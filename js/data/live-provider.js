// live-provider.js — the shared engine for every REAL data source.
//
// A source only has to say "how do I fetch one snapshot?". This file does the rest, identically for all:
//
//   state machine (what the UI shows)
//     LIVE   last fetch worked and is recent
//     STALE  the latest fetch failed (or the proxy served an old copy) but we still hold recent data
//     ERROR  failing and the data we hold is old / we never got any
//   rules
//     * the last good data stays on the map while a feed is down (it is never invented or extrapolated),
//       and it is labelled STALE/ERROR so nobody mistakes it for current
//     * a snapshot replaces the previous one: things that left the feed are removed from the map
//     * rate limits: after HTTP 429 / 5xx the feed is left alone for the server's Retry-After time
//     * failures back off (x2, up to 5 minutes) instead of hammering a struggling server
//     * nothing is fetched while the browser tab is hidden or the device is offline
//     * a source that needs something we lack (a proxy address) simply does not start,
//       and says exactly why ("idleReason")
//
// poll() returns  { records, dataTime, warning? }  or throws a FeedError.
//   records   full snapshot for this source (array of entity records)
//   dataTime  when the DATA was produced (ms), shown as "Updated …"
//   warning   optional text: data is usable but degraded (e.g. proxy served a cached copy)

import { STATE } from './provider-manager.js';
import { FeedError, cooldownFor } from './net.js';

const BACKOFF_MAX_MS = 5 * 60_000;

export function createLiveProvider({
  id, layerId, name, attribution,
  intervalMs,                 // normal wait between polls
  staleAfterMs,               // data older than this (while failing) turns STALE into ERROR
  requires = () => null,      // returns null when OK, or a sentence explaining what is missing
  isVisible = () => true,     // false while the user has switched this layer off (the feed pauses, but keeps its claim on the layer)
  poll,                       // async (api) => { records, dataTime, warning? }
  now = () => Date.now(),
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (t) => clearTimeout(t),
}) {
  const source = { id, name, kind: 'live' };
  let ctx = null;
  let timer = null;
  let inFlight = false;
  let failures = 0;
  let paused = false;
  let lastSuccess = null;
  let heldIds = new Set();
  let runToken = 0;

  const provider = {
    id, layerId, name, kind: 'live', attribution,
    state: STATE.OFF, lastUpdate: null, error: null, running: false, idleReason: null,
    intervalMs, source, requires,
    /** True when the only reason we are idle is that the user hid the layer. A simulated stand-in must not appear then. */
    layerHidden: () => !isVisible(),

    start(c) {
      const missing = requires();
      if (missing) {                       // not an error: the source is simply not usable yet
        provider.idleReason = missing;
        provider.running = false;
        provider.state = STATE.OFF;
        c.notify();
        return;
      }
      ctx = c;
      provider.idleReason = null;
      provider.running = true;
      provider.state = STATE.CONNECTING;   // nothing known yet; becomes LIVE only after real data arrives
      provider.error = null;
      failures = 0; lastSuccess = null; paused = false;
      runToken += 1;
      c.notify();
      schedule(0);
    },

    stop() {
      runToken += 1;
      clearTimer(timer); timer = null;
      provider.running = false;
      provider.state = STATE.OFF;
      provider.error = null;
      if (ctx) ctx.sink.removeBySource(id);
      heldIds = new Set();
      lastSuccess = null;
      provider.lastUpdate = null;
      ctx?.notify();
    },

    pause() { paused = true; clearTimer(timer); timer = null; },
    resume() {
      if (!paused) return;
      paused = false;
      // If we slept longer than one interval, refresh right away; otherwise carry on as before.
      const idle = lastSuccess ? now() - lastSuccess : Infinity;
      schedule(idle >= provider.intervalMs ? 0 : provider.intervalMs - idle);
    },

    /** Force a refresh now (used by tests and the "reconnect" paths). */
    refreshNow() { clearTimer(timer); return runOnce(); },
  };

  function schedule(ms) {
    clearTimer(timer);
    if (!provider.running || paused) return;
    timer = setTimer(runOnce, ms);
  }

  function offline() { return typeof navigator !== 'undefined' && navigator.onLine === false; }

  function applyFailure(err) {
    failures += 1;
    const age = lastSuccess == null ? Infinity : now() - lastSuccess;
    provider.state = age < staleAfterMs ? STATE.STALE : STATE.ERROR;
    provider.error = err instanceof FeedError ? err.message : 'Unexpected problem while reading this feed.';
    if (!(err instanceof FeedError)) console.error(`[${id}]`, err);
  }

  async function runOnce() {
    if (!provider.running || inFlight || paused) return;
    if (offline()) {                                      // don't burn rate limits while offline
      applyFailure(new FeedError('Device is offline.', { kind: 'network' }));
      ctx.notify();
      schedule(10_000);
      return;
    }
    inFlight = true;
    const token = runToken;
    let nextIn = provider.intervalMs;
    try {
      const out = await poll({ now });
      if (token !== runToken) return;                     // stopped/restarted while we were waiting
      const ids = new Set(out.records.map((r) => r.id));
      const withSource = out.records.map((r) => ({ ...r, source }));
      ctx.sink.upsertMany(withSource);
      for (const old of heldIds) if (!ids.has(old)) ctx.sink.remove(old);
      heldIds = ids;
      lastSuccess = now();
      failures = 0;
      provider.lastUpdate = out.dataTime ?? lastSuccess;
      provider.state = out.warning ? STATE.STALE : STATE.LIVE;
      provider.error = out.warning ?? null;
    } catch (err) {
      if (token !== runToken) return;
      applyFailure(err);
      const cool = err instanceof FeedError ? cooldownFor(err) : null;
      nextIn = cool ?? Math.min(BACKOFF_MAX_MS, provider.intervalMs * 2 ** Math.min(failures, 5));
    } finally {
      inFlight = false;
    }
    ctx.notify();
    schedule(nextIn);
  }

  return provider;
}
