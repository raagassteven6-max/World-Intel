// firms-provider.js — REAL fire hotspots from NASA FIRMS (free MAP_KEY, held as a Worker secret).
//
// A "hotspot" is a satellite heat detection (VIIRS on NOAA-20 and NOAA-21), usually a fire, but it can also be
// an industrial flare or a false alarm — the confidence value says how sure the satellite team is.
// Satellites pass a few times a day, so "live" here means "latest NASA release", typically 1–3 hours behind.
// We show the last 24 hours inside a box around your screen centre. (NASA ended Suomi-NPP delivery on 1 Nov 2026,
// so NOAA-20 / NOAA-21 are used.)

import { createLiveProvider } from './live-provider.js';
import { fetchJson, proxyUrl, FeedError } from './net.js';

export const MAX_HOTSPOTS = 3000;
export const MAX_SPAN = 30;                    // degrees; bigger boxes make large downloads
const HOUR = 3600_000;

/** Tiny CSV reader for FIRMS rows (no quoted commas appear in these files). Returns [] if the header is wrong. */
export function parseFirmsCsv(csv) {
  if (typeof csv !== 'string') return [];
  const lines = csv.trim().split(/\r?\n/);
  const head = (lines.shift() ?? '').split(',').map((h) => h.trim().toLowerCase());
  for (const need of ['latitude', 'longitude', 'acq_date', 'acq_time', 'confidence', 'frp']) if (!head.includes(need)) return [];
  return lines.filter(Boolean).map((line) => {
    const cells = line.split(',');
    const row = {};
    head.forEach((h, i) => { row[h] = (cells[i] ?? '').trim(); });
    return row;
  });
}

/** acq_date "2026-11-18" + acq_time "45" (=00:45, NOT zero-padded in the file) -> epoch ms UTC. */
export function acquiredMs(date, time) {
  const t = String(time ?? '').padStart(4, '0');
  const ms = Date.parse(`${date}T${t.slice(0, 2)}:${t.slice(2, 4)}:00Z`);
  return Number.isFinite(ms) ? ms : null;
}

/** VIIRS confidence is l/n/h; MODIS is 0–100 (NASA bands: <30 low, 30–79 nominal, >=80 high). */
export function confidenceLabel(raw) {
  const v = String(raw ?? '').trim().toLowerCase();
  if (v === 'l') return 'Low'; if (v === 'n') return 'Nominal'; if (v === 'h') return 'High';
  const n = Number(v);
  if (v !== '' && Number.isFinite(n)) return n >= 80 ? 'High' : n >= 30 ? 'Nominal' : 'Low';
  return null;
}

/** Worker answer {now, parts:[{source, csv}]} -> records for the trailing 24 h. Null when the shape is wrong. */
export function normalizeFirms(json, nowMs = Date.now()) {
  if (!json || !Array.isArray(json.parts)) return null;
  const seen = new Set();
  const out = [];
  for (const part of json.parts) {
    for (const r of parseFirmsCsv(part?.csv)) {
      const lat = Number(r.latitude); const lon = Number(r.longitude);
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
      const at = acquiredMs(r.acq_date, r.acq_time);
      if (at == null || at < nowMs - 24 * HOUR || at > nowMs + 2 * HOUR) continue;       // trailing 24 h only
      const id = `firms:${part.source}:${lat.toFixed(4)}:${lon.toFixed(4)}:${at}`;
      if (seen.has(id)) continue;
      seen.add(id);
      const frp = Number(r.frp);
      out.push({
        id, layerId: 'wildfires', type: 'wildfire',
        name: `Hotspot ${lat.toFixed(2)}°, ${lon.toFixed(2)}°`,
        lon, lat, alt: 0, heading: null,
        updatedAt: at, observedAt: at,
        attrs: {
          confidence: confidenceLabel(r.confidence),
          frpMw: Number.isFinite(frp) ? frp : null,
          severity: null,                                                              // FIRMS gives no severity rating: shown as NOT PROVIDED
          satellite: r.satellite || part.source,
          dayNight: r.daynight === 'D' ? 'Day' : r.daynight === 'N' ? 'Night' : null,
        },
      });
    }
  }
  out.sort((a, b) => (b.attrs.frpMw ?? 0) - (a.attrs.frpMw ?? 0));                       // keep the most intense if we must cap
  return out.slice(0, MAX_HOTSPOTS);
}

export function boxForFires({ lat, lon, heightM }) {
  const half = Math.min(MAX_SPAN / 2, Math.max(1, Number.isFinite(heightM) ? (heightM / 111_000) * 0.6 : MAX_SPAN / 2));
  return { south: Math.max(-90, lat - half), north: Math.min(90, lat + half), west: Math.max(-180, lon - half), east: Math.min(180, lon + half) };
}

const r2 = (v) => Math.round(v * 100) / 100;

export function createFirmsProvider({ getProxy, getView, fetchImpl, now, setTimer, clearTimer, isVisible = () => true }) {
  const provider = createLiveProvider({
    id: 'firms', layerId: 'wildfires',
    name: 'NASA FIRMS (via your proxy)',
    attribution: 'Fire hotspots: NASA FIRMS (VIIRS NOAA-20/21) — last 24 h around the screen centre',
    intervalMs: 15 * 60_000,
    staleAfterMs: 3 * 3600_000,
    now, setTimer, clearTimer, isVisible,
    requires: () => (!isVisible() ? 'Layer is switched off, so nothing is being fetched.' : getProxy() ? null : 'Needs the data proxy. Add its address in Settings → Data.'),
    async poll({ now: clock }) {
      const view = getView();
      if (!view || !Number.isFinite(view.lat) || !Number.isFinite(view.lon)) {
        throw new FeedError('Camera is not looking at the globe, so there is no area to request.', { kind: 'config' });
      }
      const b = boxForFires(view);
      const url = proxyUrl(getProxy(), 'firms', { west: r2(b.west), south: r2(b.south), east: r2(b.east), north: r2(b.north) });
      const { data, meta } = await fetchJson(url, { fetchImpl, timeoutMs: 25_000 });
      const records = normalizeFirms(data, clock());
      if (!records) throw new FeedError('The FIRMS relay sent an answer in an unexpected shape, so it was ignored.', { kind: 'bad_response' });
      provider.attribution = `Fire hotspots: NASA FIRMS (VIIRS NOAA-20/21) — ${records.length} in the last 24 h within a ${r2(b.north - b.south)}° box around the screen centre`;
      const failed = Array.isArray(data.failed) && data.failed.length ? `Part of the data is missing (${data.failed.join(', ')} unavailable).` : null;
      return {
        records,
        dataTime: Number.isFinite(data.now) ? data.now : clock(),
        warning: failed ?? (meta.cache === 'STALE' ? 'The proxy could not reach NASA and served an older copy.' : undefined),
      };
    },
  });
  return provider;
}
