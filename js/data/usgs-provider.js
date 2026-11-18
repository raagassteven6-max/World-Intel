// usgs-provider.js — REAL earthquakes from the U.S. Geological Survey (no key, no proxy).
//
// Feed: "M2.5+ past day" GeoJSON. The USGS refreshes it about every minute; we ask every 2 minutes.
// The all-or-nothing validation below (reject the whole snapshot if any event is malformed, keep the
// last good one) follows the approach in bilawalsidhu/gods-eye-view (MIT), rewritten for this app.

import { createLiveProvider } from './live-provider.js';
import { fetchJson, FeedError } from './net.js';

export const USGS_URL = 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_day.geojson';

export function severityFor(mag) {
  if (mag >= 7) return 'Major';
  if (mag >= 6) return 'Strong';
  if (mag >= 5) return 'Moderate';
  if (mag >= 4) return 'Light';
  return 'Minor';
}

/**
 * Turn a USGS GeoJSON document into entity records.
 * Returns null if the document is not a trustworthy USGS feed (so the caller keeps the previous data).
 */
export function normalizeUsgs(geojson) {
  if (!Array.isArray(geojson?.features)) return null;
  const records = [];
  const seen = new Set();
  for (const f of geojson.features) {
    const c = f?.geometry?.coordinates;
    const p = f?.properties;
    if (!Array.isArray(c) || c.length < 2 || !p || typeof p !== 'object' || Array.isArray(p)) return null;
    if (f.geometry.type != null && f.geometry.type !== 'Point') return null;
    const [lon, lat, depth] = c;
    const mag = p.mag;
    if (!Number.isFinite(lon) || Math.abs(lon) > 180 || !Number.isFinite(lat) || Math.abs(lat) > 90) return null;
    if (depth != null && !Number.isFinite(depth)) return null;
    if (mag != null && (!Number.isFinite(mag) || mag > 10)) return null;
    if (mag == null) continue;                          // no magnitude: cannot honestly list it as an earthquake of known size
    if (f.id == null || f.id === '') return null;       // an event without an id cannot be tracked between refreshes
    const key = String(f.id);
    if (seen.has(key)) return null;
    seen.add(key);
    const time = Number.isFinite(p.time) ? p.time : null;
    const place = typeof p.place === 'string' && p.place.trim() ? p.place.trim() : null;
    records.push({
      id: `usgs:${key}`, layerId: 'earthquakes', type: 'earthquake',
      name: `M ${mag.toFixed(1)}${place ? ` — ${place}` : ''}`,
      lon, lat, alt: 0, heading: null,
      updatedAt: Number.isFinite(p.updated) ? p.updated : time,
      observedAt: time,
      attrs: { magnitude: mag, depthKm: depth ?? null, severity: severityFor(mag), place },
    });
  }
  return records;
}

export function createUsgsProvider({ fetchImpl, now, setTimer, clearTimer, url = USGS_URL, isVisible = () => true } = {}) {
  return createLiveProvider({
    id: 'usgs', layerId: 'earthquakes',
    name: 'USGS Earthquake Hazards Program',
    attribution: 'Earthquakes (M2.5+, past 24 h): U.S. Geological Survey',
    intervalMs: 120_000,
    staleAfterMs: 10 * 60_000,
    now, setTimer, clearTimer,
    isVisible,
    requires: () => (isVisible() ? null : 'Layer is switched off, so nothing is being fetched.'),
    async poll({ now: clock }) {
      const { data } = await fetchJson(url, { fetchImpl, timeoutMs: 10_000 });
      const records = normalizeUsgs(data);
      if (!records) throw new FeedError('USGS sent a feed we could not trust, so it was ignored.', { kind: 'bad_response' });
      return { records, dataTime: clock() };
    },
  });
}
