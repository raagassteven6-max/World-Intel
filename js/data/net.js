// net.js — the one safe way the app talks to the internet.
//
// Every real data source goes through fetchJson / fetchText, so they all behave the same way:
//   * a timeout (a hung server can never freeze a feed),
//   * a clear error type that says WHY it failed (offline/CORS, timeout, rate limit, bad data),
//   * "Retry-After" honoured when a server says "slow down" (HTTP 429 / 503).
//
// The cooldown idea (bounded Retry-After, default pause when the server gives none) follows the
// approach used in bilawalsidhu/gods-eye-view (MIT) — rewritten here for a browser-only app.

export const COOLDOWN_MIN_MS = 5_000;
export const COOLDOWN_MAX_MS = 30 * 60_000;

/** Why a request failed. `kind` is what the UI can show; `retryAfterMs` tells the poller how long to wait. */
export class FeedError extends Error {
  constructor(message, { kind = 'error', status = null, retryAfterMs = null } = {}) {
    super(message);
    this.name = 'FeedError';
    this.kind = kind;            // 'network' | 'timeout' | 'http' | 'rate_limit' | 'bad_response' | 'config'
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

/** Read an HTTP Retry-After header (seconds, or a date). Returns milliseconds, or null if absent/unusable. */
export function parseRetryAfter(value, now = Date.now()) {
  if (value == null) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  if (/^\d+(\.\d+)?$/.test(raw)) return Number(raw) * 1000;
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.max(0, at - now) : null;
}

/** Keep a wait time inside sane bounds. */
export const clampCooldown = (ms) => Math.min(COOLDOWN_MAX_MS, Math.max(COOLDOWN_MIN_MS, ms));

/** How long to leave a source alone after this failure. */
export function cooldownFor(err) {
  if (err?.retryAfterMs != null) return clampCooldown(err.retryAfterMs);
  if (err?.kind === 'rate_limit') return clampCooldown(60_000);
  if (err?.kind === 'http' && err.status >= 500) return clampCooldown(30_000);
  return null;                                   // ordinary failure: the poller's normal back-off applies
}

async function request(url, { timeoutMs = 10_000, fetchImpl, signal, headers } = {}) {
  const doFetch = fetchImpl ?? ((...a) => globalThis.fetch(...a));
  const ctl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ctl.abort(); }, timeoutMs);
  const onOuterAbort = () => ctl.abort();
  signal?.addEventListener('abort', onOuterAbort, { once: true });
  try {
    const res = await doFetch(url, { signal: ctl.signal, headers, cache: 'no-store' });
    if (!res.ok) {
      const retryAfterMs = parseRetryAfter(res.headers?.get?.('retry-after'));
      if (res.status === 429) throw new FeedError('Rate limited by the data provider (HTTP 429).', { kind: 'rate_limit', status: 429, retryAfterMs });
      let why = ''; let code = null;                          // our own proxy explains itself in JSON: {error, message}
      try { const j = JSON.parse((await res.text()).slice(0, 2000)); if (typeof j?.message === 'string') why = ` ${j.message}`; code = j?.error ?? null; } catch { /* not JSON: fine */ }
      // The proxy works but has no key for this source yet: not a failure, just "not set up".
      if (code === 'key_missing') throw new FeedError(why.trim() || 'The proxy has no key for this source yet.', { kind: 'not_configured', status: res.status });
      throw new FeedError(`Data provider answered HTTP ${res.status}.${why}`, { kind: 'http', status: res.status, retryAfterMs });
    }
    return res;
  } catch (err) {
    if (err instanceof FeedError) throw err;
    if (timedOut) throw new FeedError(`No answer within ${Math.round(timeoutMs / 1000)} s.`, { kind: 'timeout' });
    if (signal?.aborted) throw new FeedError('Request cancelled.', { kind: 'cancelled' });
    // fetch() only throws a bare TypeError for "could not connect", including a browser CORS block.
    throw new FeedError('Could not reach the data provider (offline, blocked, or the server does not allow browser access).', { kind: 'network' });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onOuterAbort);
  }
}

/** Cache info our own proxy adds to its answers (see worker/worker.js). */
function readMeta(res) {
  const cache = res.headers?.get?.('x-feed-cache') ?? null;          // HIT | MISS | STALE
  const age = Number(res.headers?.get?.('x-feed-age-ms'));
  return { cache, ageMs: Number.isFinite(age) ? age : null };
}

export async function fetchJson(url, opts = {}) {
  const res = await request(url, opts);
  try {
    return { data: await res.json(), meta: readMeta(res) };
  } catch {
    throw new FeedError('The data provider sent something that is not valid JSON.', { kind: 'bad_response' });
  }
}

export async function fetchText(url, opts = {}) {
  const res = await request(url, opts);
  try {
    return { data: await res.text(), meta: readMeta(res) };
  } catch {
    throw new FeedError('The data provider sent an unreadable answer.', { kind: 'bad_response' });
  }
}

/** Build "<proxy>/<path>?query" from the saved proxy address. Returns null when no proxy is set. */
export function proxyUrl(base, path, params = {}) {
  if (!base) return null;
  const u = new URL(`${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v));
  return u.toString();
}
