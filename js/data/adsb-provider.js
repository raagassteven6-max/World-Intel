// adsb-provider.js — REAL aircraft near the middle of your screen, from adsb.lol (community ADS-B network).
//
// Needs the Cloudflare Worker proxy (worker/worker.js): adsb.lol's browser (CORS) policy is not documented,
// and the proxy also gives caching so one busy page cannot hammer a volunteer-run service.
//
// What you get: a REGIONAL snapshot — aircraft within up to 250 nautical miles of the view centre, not the whole
// world. The layer says so. Positions are what receivers last heard (observed), never predicted.
// Origin / destination are not provided by this source, so the panel shows NOT PROVIDED.

import { createLiveProvider } from './live-provider.js';
import { fetchJson, proxyUrl, FeedError } from './net.js';

const FT_TO_M = 0.3048;
const FPM_TO_MS = 0.00508;
export const MAX_RADIUS_NM = 250;
export const MAX_AIRCRAFT = 1500;

/** How far around the view centre to ask for, based on how high the camera is (metres). */
export function radiusForHeight(heightM) {
  const nm = Number.isFinite(heightM) ? (heightM / 1852) * 0.6 : MAX_RADIUS_NM;
  return Math.round(Math.min(MAX_RADIUS_NM, Math.max(25, nm)));
}

const round2 = (v) => Math.round(v * 100) / 100;

/** adsb.lol v2 answer -> entity records. Returns null when the answer is not the expected shape. */
export function normalizeAdsb(json, nowMs = Date.now()) {
  if (!json || !Array.isArray(json.ac)) return null;
  const base = Number.isFinite(json.now) ? json.now : nowMs;       // server clock, epoch ms
  const records = [];
  for (const a of json.ac) {
    if (records.length >= MAX_AIRCRAFT) break;
    if (!a || typeof a.hex !== 'string' || !Number.isFinite(a.lat) || !Number.isFinite(a.lon)) continue;   // no position heard: not plottable
    if (Math.abs(a.lat) > 90 || Math.abs(a.lon) > 180) continue;
    const ground = a.alt_baro === 'ground';
    const altFt = typeof a.alt_baro === 'number' ? a.alt_baro : null;
    const seen = Number.isFinite(a.seen_pos) ? a.seen_pos : 0;
    const observed = base - seen * 1000;
    const callsign = typeof a.flight === 'string' && a.flight.trim() ? a.flight.trim() : null;
    const hex = a.hex.toLowerCase();
    records.push({
      id: `adsb:${hex}`, layerId: 'aircraft', type: 'aircraft',
      name: callsign ?? hex.toUpperCase(),
      lon: a.lon, lat: a.lat,
      alt: ground ? 0 : altFt == null ? null : altFt * FT_TO_M,
      heading: Number.isFinite(a.track) ? a.track : null,
      updatedAt: observed, observedAt: observed,
      attrs: {
        callsign, icao24: hex.toUpperCase(),
        speedKts: Number.isFinite(a.gs) ? a.gs : null,
        vrateMs: Number.isFinite(a.baro_rate) ? a.baro_rate * FPM_TO_MS : null,
        registration: typeof a.r === 'string' && a.r ? a.r : null,
        aircraftType: typeof a.t === 'string' && a.t ? a.t : null,
        onGround: ground,
        origin: null, destination: null,                              // not provided by this source
      },
    });
  }
  return records;
}

/**
 * @param getProxy  () => saved proxy base URL ('' when none)
 * @param getView   () => { lon, lat, heightM } for the current camera (lon/lat may be null in space)
 */
export function createAdsbProvider({ getProxy, getView, fetchImpl, now, setTimer, clearTimer, isVisible = () => true }) {
  const provider = createLiveProvider({
    id: 'adsblol', layerId: 'aircraft',
    name: 'adsb.lol (community ADS-B)',
    attribution: 'Aircraft: adsb.lol contributors (ODbL) — regional snapshot, not worldwide',
    intervalMs: 15_000,
    staleAfterMs: 90_000,
    now, setTimer, clearTimer,
    isVisible,
    requires: () => (!isVisible() ? 'Layer is switched off, so nothing is being fetched.' : getProxy() ? null : 'Needs the data proxy. Add its address in Settings → Data.'),
    async poll({ now: clock }) {
      const view = getView();
      if (!view || !Number.isFinite(view.lat) || !Number.isFinite(view.lon)) {
        throw new FeedError('Camera is not looking at the globe, so there is no area to request.', { kind: 'config' });
      }
      const dist = radiusForHeight(view.heightM);
      const url = proxyUrl(getProxy(), 'adsb', { lat: round2(view.lat), lon: round2(view.lon), dist });
      const { data, meta } = await fetchJson(url, { fetchImpl, timeoutMs: 10_000 });
      const records = normalizeAdsb(data, clock());
      if (!records) throw new FeedError('adsb.lol sent an answer in an unexpected shape, so it was ignored.', { kind: 'bad_response' });
      provider.attribution = `Aircraft: adsb.lol contributors (ODbL) — ${records.length} within ${dist} nm of ${round2(view.lat)}°, ${round2(view.lon)}° (regional, not worldwide)`;
      const stale = meta.cache === 'STALE';
      return {
        records,
        dataTime: Number.isFinite(data.now) ? data.now : clock(),
        warning: stale ? 'The proxy could not reach adsb.lol and served an older copy.' : undefined,
      };
    },
  });
  return provider;
}
