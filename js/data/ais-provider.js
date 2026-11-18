// ais-provider.js — REAL ships near the middle of your screen, from AISStream (free API key).
//
// AISStream does not allow browsers to connect, and its key must stay secret, so the Cloudflare Worker holds the
// key (as a Worker "secret"), listens for a few seconds inside a small box, and hands this page one snapshot.
// What you get: vessels that BROADCAST AIS and were heard in that window — a regional sample, not every ship on Earth.
// Many vessels (especially small or dark ones) do not appear. Ship type/destination only show if the ship sent them.

import { createLiveProvider } from './live-provider.js';
import { fetchJson, proxyUrl, FeedError } from './net.js';

export const MAX_SHIPS = 800;
export const MAX_SPAN_LAT = 10;
export const MAX_SPAN_LON = 20;

const NAV = { 0: 'Under way using engine', 1: 'At anchor', 2: 'Not under command', 3: 'Restricted manoeuvrability', 4: 'Constrained by draught', 5: 'Moored', 6: 'Aground', 7: 'Engaged in fishing', 8: 'Under way sailing', 14: 'AIS-SART active' };

/** ITU AIS ship-type code -> plain words. Unknown / 0 -> null (never guessed). */
export function shipTypeName(code) {
  if (!Number.isInteger(code) || code <= 0) return null;
  if (code >= 70 && code <= 79) return 'Cargo';
  if (code >= 80 && code <= 89) return 'Tanker';
  if (code >= 60 && code <= 69) return 'Passenger';
  if (code >= 40 && code <= 49) return 'High-speed craft';
  if (code >= 20 && code <= 29) return 'Wing-in-ground';
  const named = { 30: 'Fishing', 31: 'Towing', 32: 'Towing (large)', 33: 'Dredging', 34: 'Diving ops', 35: 'Military', 36: 'Sailing', 37: 'Pleasure craft', 50: 'Pilot vessel', 51: 'Search and rescue', 52: 'Tug', 53: 'Port tender', 55: 'Law enforcement', 58: 'Medical transport' };
  if (named[code]) return named[code];
  return code >= 90 ? 'Other' : `Type code ${code}`;
}

/** Box around the view centre: bigger when zoomed out, always inside the size limits. */
export function boxForView({ lat, lon, heightM }) {
  const half = Math.min(MAX_SPAN_LAT / 2, Math.max(0.5, Number.isFinite(heightM) ? (heightM / 111_000) * 0.5 : MAX_SPAN_LAT / 2));
  const lonHalf = Math.min(MAX_SPAN_LON / 2, half / Math.max(0.2, Math.cos((lat * Math.PI) / 180)));
  return {
    south: Math.max(-90, lat - half), north: Math.min(90, lat + half),
    west: Math.max(-180, lon - lonHalf), east: Math.min(180, lon + lonHalf),
  };
}

const r2 = (v) => Math.round(v * 100) / 100;
const text = (v) => (typeof v === 'string' && v.replace(/[@\s]+$/g, '').trim() ? v.replace(/[@\s]+$/g, '').trim() : null);   // AIS pads names with '@'

/** Worker answer -> records. Returns null when the answer is not the expected shape. */
export function normalizeAis(json) {
  if (!json || !Array.isArray(json.ships)) return null;
  const out = [];
  for (const s of json.ships) {
    if (out.length >= MAX_SHIPS) break;
    const mmsi = s?.mmsi == null ? '' : String(s.mmsi);
    if (!/^\d{9}$/.test(mmsi)) continue;                                         // not a valid ship identity
    if (!Number.isFinite(s.lat) || !Number.isFinite(s.lon) || Math.abs(s.lat) > 90 || Math.abs(s.lon) > 180) continue;   // 91 / 181 = "position unavailable"
    const seen = Number.isFinite(s.heardAt) ? s.heardAt : Number.isFinite(json.now) ? json.now : Date.now();
    out.push({
      id: `ais:${mmsi}`, layerId: 'ships', type: 'ship',
      name: text(s.name) ?? `MMSI ${mmsi}`,
      lon: s.lon, lat: s.lat, alt: 0,
      heading: Number.isFinite(s.heading) && s.heading >= 0 && s.heading < 360 ? s.heading : (Number.isFinite(s.cog) && s.cog >= 0 && s.cog < 360 ? s.cog : null),
      updatedAt: seen, observedAt: seen,
      attrs: {
        mmsi,
        imo: Number.isInteger(s.imo) && s.imo > 0 ? String(s.imo) : null,
        shipType: shipTypeName(s.shipType),
        speedKts: Number.isFinite(s.sog) && s.sog >= 0 && s.sog < 102.3 ? s.sog : null,   // 102.3 = "not available"
        destination: text(s.destination),
        navStatus: Number.isInteger(s.navStatus) ? (NAV[s.navStatus] ?? null) : null,
      },
    });
  }
  return out;
}

export function createAisProvider({ getProxy, getView, fetchImpl, now, setTimer, clearTimer, isVisible = () => true }) {
  const provider = createLiveProvider({
    id: 'aisstream', layerId: 'ships',
    name: 'AISStream (via your proxy)',
    attribution: 'Ships: AISStream.io — regional sample of vessels broadcasting AIS',
    intervalMs: 60_000,
    staleAfterMs: 5 * 60_000,
    now, setTimer, clearTimer, isVisible,
    requires: () => (!isVisible() ? 'Layer is switched off, so nothing is being fetched.' : getProxy() ? null : 'Needs the data proxy. Add its address in Settings → Data.'),
    async poll({ now: clock }) {
      const view = getView();
      if (!view || !Number.isFinite(view.lat) || !Number.isFinite(view.lon)) {
        throw new FeedError('Camera is not looking at the globe, so there is no area to request.', { kind: 'config' });
      }
      const b = boxForView(view);
      const url = proxyUrl(getProxy(), 'ais', { west: r2(b.west), south: r2(b.south), east: r2(b.east), north: r2(b.north) });
      const { data, meta } = await fetchJson(url, { fetchImpl, timeoutMs: 20_000 });   // the relay listens ~8 s
      const records = normalizeAis(data);
      if (!records) throw new FeedError('The AIS relay sent an answer in an unexpected shape, so it was ignored.', { kind: 'bad_response' });
      provider.attribution = `Ships: AISStream.io — ${records.length} vessels heard in a ${r2(b.north - b.south)}° × ${r2(b.east - b.west)}° box around the screen centre (regional sample, not all ships)`;
      return {
        records,
        dataTime: Number.isFinite(data.now) ? data.now : clock(),
        warning: meta.cache === 'STALE' ? 'The proxy could not reach AISStream and served an older copy.' : undefined,
      };
    },
  });
  return provider;
}
