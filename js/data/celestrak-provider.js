// celestrak-provider.js — REAL satellites: orbital elements from CelesTrak, positions calculated in your browser.
//
// How it works, plainly:
//   1. Once every ~6 hours we download each satellite's "orbital elements" (TLE: a few numbers describing its orbit).
//      CelesTrak asks clients not to download more often than every ~2 hours, so we cache them in this browser.
//   2. Every few seconds we run a standard physics model (SGP4, from the satellite.js library) on those numbers
//      to calculate where each satellite is right now. These positions are CALCULATED, not observed — the panel says so.
//   3. Elements older than 30 days are not used: the maths drifts too far from reality.
//
// CelesTrak does not allow browser pages to call it directly (no CORS headers — also stated in the gods-eye-view
// source, MIT), so the download goes through the Cloudflare Worker proxy (worker/worker.js).

import { createLiveProvider } from './live-provider.js';
import { fetchText, proxyUrl, FeedError, cooldownFor } from './net.js';

export const GROUPS = ['stations', 'visual'];          // space stations + ~100 brightest satellites
export const ELEMENTS_TTL_MS = 6 * 3600_000;           // re-download at most this often
export const MAX_ELEMENT_AGE_MS = 30 * 86400_000;      // refuse to propagate older elements
export const SATELLITE_LIB_URL = 'https://cdn.jsdelivr.net/npm/satellite.js@6.0.2/+esm';
const CACHE_KEY = 'gec.tle.v1';

// ----------------------------------------------------------------------------------- TLE text handling
/** Parse "name / line 1 / line 2" triples. Skips anything malformed. */
export function parseTle(text) {
  const lines = String(text ?? '').split(/\r?\n/).map((l) => l.trimEnd()).filter((l) => l.length);
  const out = [];
  for (let i = 0; i + 2 < lines.length; i += 1) {
    const [name, l1, l2] = [lines[i], lines[i + 1], lines[i + 2]];
    if (l1.startsWith('1 ') && l2.startsWith('2 ') && l1.length >= 69 && l2.length >= 69 && !name.startsWith('1 ') && !name.startsWith('2 ')) {
      const noradId = l1.slice(2, 7).trim();
      if (/^\d{1,5}$/.test(noradId) && l2.slice(2, 7).trim() === noradId) {
        out.push({ name: name.trim(), noradId, line1: l1, line2: l2 });
        i += 2;
      }
    }
  }
  return out;
}

/** Epoch of a TLE (when its numbers were measured), in epoch milliseconds. */
export function tleEpochMs(line1) {
  const yy = Number(line1.slice(18, 20));
  const day = Number(line1.slice(20, 32));
  if (!Number.isFinite(yy) || !Number.isFinite(day)) return null;
  const year = yy < 57 ? 2000 + yy : 1900 + yy;           // convention used by the TLE format
  return Date.UTC(year, 0, 1) + (day - 1) * 86400_000;
}

export const inclinationDeg = (line2) => {
  const v = Number(line2.slice(8, 16));
  return Number.isFinite(v) ? v : null;
};

// ----------------------------------------------------------------------------------- cache (this browser only)
function readCache(storage) {
  try {
    const raw = JSON.parse(storage?.getItem(CACHE_KEY) ?? 'null');
    return raw && typeof raw === 'object' ? raw : {};
  } catch { return {}; }
}
function writeCache(storage, cache) {
  try { storage?.setItem(CACHE_KEY, JSON.stringify(cache)); } catch { /* storage full or blocked: carry on without a cache */ }
}

// ----------------------------------------------------------------------------------- provider
/**
 * @param getProxy   () => saved proxy base URL
 * @param loadLib    async () => satellite.js module   (injectable so tests need no network)
 * @param storage    localStorage-like (injectable)
 */
export function createCelestrakProvider({
  getProxy, fetchImpl, now, setTimer, clearTimer,
  loadLib = () => import(SATELLITE_LIB_URL),
  storage = (() => { try { return globalThis.localStorage; } catch { return undefined; } })(),
  groups = GROUPS,
  isVisible = () => true,
} = {}) {
  const clock = now ?? (() => Date.now());
  let lib = null;
  let sats = [];                  // [{ name, noradId, line1, line2, satrec, epochMs, group }]
  let elementsFetchedAt = null;   // when the newest element download (or cached copy) was made
  let holdUntil = 0;              // do not contact CelesTrak before this time (after rate limit / failure)
  let lastFetchError = null;

  async function loadElements() {
    const cache = readCache(storage);
    const t = clock();
    const fresh = groups.every((g) => cache[g] && t - cache[g].fetchedAt < ELEMENTS_TTL_MS);
    let usedStale = false;
    if (!fresh && t >= holdUntil) {
      for (const g of groups) {
        if (cache[g] && t - cache[g].fetchedAt < ELEMENTS_TTL_MS) continue;
        try {
          const { data } = await fetchText(proxyUrl(getProxy(), 'celestrak', { group: g }), { fetchImpl, timeoutMs: 15_000 });
          if (!parseTle(data).length) throw new FeedError('CelesTrak sent no usable orbital elements.', { kind: 'bad_response' });
          cache[g] = { text: data, fetchedAt: clock() };
          lastFetchError = null;
        } catch (err) {
          lastFetchError = err instanceof FeedError ? err.message : 'Download failed.';
          holdUntil = t + (err instanceof FeedError ? (cooldownFor(err) ?? 5 * 60_000) : 5 * 60_000);
          if (!cache[g]) throw err;               // nothing cached for this group at all
          usedStale = true;                       // fall back to the cached copy and say so
        }
      }
      writeCache(storage, cache);
    } else if (!fresh) {
      usedStale = groups.some((g) => !cache[g] || t - cache[g].fetchedAt >= ELEMENTS_TTL_MS);
      if (groups.some((g) => !cache[g])) throw new FeedError(lastFetchError ?? 'Waiting before retrying CelesTrak.', { kind: 'network' });
    }
    // Rebuild the working list only when the underlying text changed.
    const stamp = groups.map((g) => cache[g]?.fetchedAt ?? 0).join(',');
    if (stamp !== loadElements.stamp) {
      const next = [];
      const ids = new Set();
      for (const g of groups) {
        for (const e of parseTle(cache[g]?.text)) {
          if (ids.has(e.noradId)) continue;       // a satellite can be in two groups
          const epochMs = tleEpochMs(e.line1);
          if (epochMs == null) continue;
          ids.add(e.noradId);
          next.push({ ...e, epochMs, group: g, satrec: lib.twoline2satrec(e.line1, e.line2) });
        }
      }
      sats = next;
      loadElements.stamp = stamp;
    }
    elementsFetchedAt = Math.min(...groups.map((g) => cache[g]?.fetchedAt ?? Infinity));
    return usedStale;
  }
  loadElements.stamp = '';

  /** Where is every satellite right now? (calculated, not observed) */
  function positions(atMs) {
    const date = new Date(atMs);
    const gmst = lib.gstime(date);
    const records = [];
    for (const s of sats) {
      if (atMs - s.epochMs > MAX_ELEMENT_AGE_MS) continue;   // elements too old to trust
      let pv;
      try { pv = lib.propagate(s.satrec, date); } catch { continue; }
      if (!pv || !pv.position || typeof pv.position !== 'object' || !pv.velocity) continue;   // SGP4 gave up (decayed / bad elements)
      const geo = lib.eciToGeodetic(pv.position, gmst);
      const lat = lib.degreesLat(geo.latitude);
      const lon = lib.degreesLong(geo.longitude);
      if (![lat, lon, geo.height].every(Number.isFinite)) continue;
      const v = pv.velocity;
      records.push({
        id: `celestrak:${s.noradId}`, layerId: 'satellites', type: 'satellite',
        name: s.name, lon, lat, alt: geo.height * 1000, heading: null,
        updatedAt: atMs, observedAt: atMs,
        attrs: {
          noradId: s.noradId,
          altitudeKm: geo.height,
          velocityKms: Math.hypot(v.x, v.y, v.z),
          inclinationDeg: inclinationDeg(s.line2),
          model: `Calculated (SGP4) from CelesTrak elements dated ${new Date(s.epochMs).toISOString().slice(0, 10)}; not an observed position`,
        },
      });
    }
    return records;
  }

  return createLiveProvider({
    id: 'celestrak', layerId: 'satellites',
    name: 'CelesTrak orbital elements (calculated positions)',
    attribution: 'Satellites: orbital elements from CelesTrak; positions calculated here (SGP4)',
    intervalMs: 5_000,
    staleAfterMs: 2 * ELEMENTS_TTL_MS,
    now, setTimer, clearTimer,
    isVisible,
    requires: () => (!isVisible() ? 'Layer is switched off, so nothing is being fetched.' : getProxy() ? null : 'Needs the data proxy. Add its address in Settings → Data.'),
    async poll() {
      if (!lib) {
        try { lib = await loadLib(); } catch { throw new FeedError('The satellite maths library (satellite.js) could not be downloaded.', { kind: 'network' }); }
      }
      const usedStale = await loadElements();
      const records = positions(clock());
      return {
        records,
        dataTime: elementsFetchedAt,
        warning: usedStale ? `Using saved orbital elements: ${lastFetchError ?? 'refresh pending'}` : undefined,
      };
    },
  });
}
