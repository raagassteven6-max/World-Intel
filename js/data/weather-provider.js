// weather-provider.js — REAL current weather from Open-Meteo (free, no key, called straight from the browser).
//
// Honest scope: Open-Meteo answers "what is the weather at THIS point", not "give me the world's weather map".
// So this layer shows weather at a handful of points you control:
//   * the middle of your screen, and
//   * each of your saved locations (up to 9).
// Values come from a weather MODEL on a grid (about 2-25 km cells), not from a sensor at that exact spot.
// Open-Meteo's free tier is for non-commercial use and requires attribution (CC BY 4.0) — shown in the layer panel.

import { createLiveProvider } from './live-provider.js';
import { fetchJson, FeedError } from './net.js';

export const OPEN_METEO_URL = 'https://api.open-meteo.com/v1/forecast';
export const MAX_POINTS = 10;                           // 1 screen-centre + 9 saved locations (one request, well inside the free limits)
const CURRENT = 'temperature_2m,wind_speed_10m,wind_direction_10m,wind_gusts_10m,precipitation,weather_code,cloud_cover,pressure_msl';

/** WMO weather interpretation codes -> plain words. */
export const WMO = {
  0: 'Clear sky', 1: 'Mainly clear', 2: 'Partly cloudy', 3: 'Overcast', 45: 'Fog', 48: 'Rime fog',
  51: 'Light drizzle', 53: 'Drizzle', 55: 'Dense drizzle', 56: 'Freezing drizzle', 57: 'Heavy freezing drizzle',
  61: 'Light rain', 63: 'Rain', 65: 'Heavy rain', 66: 'Freezing rain', 67: 'Heavy freezing rain',
  71: 'Light snow', 73: 'Snow', 75: 'Heavy snow', 77: 'Snow grains',
  80: 'Light rain showers', 81: 'Rain showers', 82: 'Violent rain showers', 85: 'Snow showers', 86: 'Heavy snow showers',
  95: 'Thunderstorm', 96: 'Thunderstorm with hail', 99: 'Thunderstorm with heavy hail',
};

/** A simple, openly derived label from the reported numbers (NOT an official warning). */
export function severityFor({ code, gustKph, windKph, precipMm }) {
  if ([95, 96, 99].includes(code) || gustKph >= 89 || windKph >= 62 || precipMm >= 20) return 'Severe';
  if ([65, 67, 75, 82, 86].includes(code) || gustKph >= 61 || windKph >= 39 || precipMm >= 7) return 'Moderate';
  return 'Calm';
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * @param points  [{ id, name, lat, lon }]   what we asked about, in order
 * @param json    Open-Meteo answer: one object for one point, an array for several
 * Returns records, or null when the answer is not the expected shape.
 */
export function normalizeWeather(points, json) {
  const list = Array.isArray(json) ? json : [json];
  if (list.length !== points.length) return null;
  const out = [];
  for (let i = 0; i < points.length; i += 1) {
    const cur = list[i]?.current;
    if (!cur || typeof cur !== 'object') return null;
    const t = typeof cur.time === 'string' ? Date.parse(`${cur.time}Z`) : NaN;     // timezone=GMT: the time has no suffix but IS UTC
    if (!Number.isFinite(t)) return null;
    const code = num(cur.weather_code);
    const windKph = num(cur.wind_speed_10m);
    const gustKph = num(cur.wind_gusts_10m);
    const precipMm = num(cur.precipitation);
    const p = points[i];
    out.push({
      id: p.id, layerId: 'weather', type: 'weather', name: p.name,
      lon: p.lon, lat: p.lat, alt: 0, heading: null,
      updatedAt: t, observedAt: t,
      attrs: {
        condition: code == null ? null : (WMO[code] ?? `Weather code ${code}`),
        windKph, windDirDeg: num(cur.wind_direction_10m), gustKph, precipMm,
        tempC: num(cur.temperature_2m), cloudPct: num(cur.cloud_cover), pressureHpa: num(cur.pressure_msl),
        severity: windKph == null && code == null ? null : severityFor({ code, gustKph: gustKph ?? 0, windKph: windKph ?? 0, precipMm: precipMm ?? 0 }),
        model: 'Model grid value near this point, not a sensor at it',
      },
    });
  }
  return out;
}

/**
 * @param getPoints  () => [{ id, name, lat, lon }]   screen centre + saved locations (already de-duplicated by the caller)
 */
export function createWeatherProvider({ getPoints, fetchImpl, now, setTimer, clearTimer, isVisible = () => true, url = OPEN_METEO_URL }) {
  let lastAsked = { key: '', at: 0, lat: null, lon: null };
  const clock = now ?? (() => Date.now());

  const provider = createLiveProvider({
    id: 'openmeteo', layerId: 'weather',
    name: 'Open-Meteo (model-based current weather)',
    attribution: 'Weather data by Open-Meteo.com (CC BY 4.0) — shown only at the screen centre and your saved locations',
    intervalMs: 10 * 60_000,
    staleAfterMs: 40 * 60_000,
    now, setTimer, clearTimer, isVisible,
    requires: () => (isVisible() ? null : 'Layer is switched off, so nothing is being fetched.'),
    async poll({ now: t }) {
      const points = getPoints().filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon)).slice(0, MAX_POINTS);
      if (!points.length) throw new FeedError('No point to ask about: the camera is not looking at the globe and no locations are saved.', { kind: 'config' });
      const q = new URLSearchParams({
        latitude: points.map((p) => p.lat.toFixed(3)).join(','),
        longitude: points.map((p) => p.lon.toFixed(3)).join(','),
        current: CURRENT, wind_speed_unit: 'kmh', timezone: 'GMT',
      });
      lastAsked.at = clock();                 // count the attempt, so a failing feed is not re-asked on every camera move
      const { data } = await fetchJson(`${url}?${q}`, { fetchImpl, timeoutMs: 12_000 });
      const records = normalizeWeather(points, data);
      if (!records) throw new FeedError('Open-Meteo sent an answer in an unexpected shape, so it was ignored.', { kind: 'bad_response' });
      const c = points[0];
      lastAsked = { key: points.map((p) => p.id).join(), at: clock(), lat: c.lat, lon: c.lon };
      return { records, dataTime: Math.max(...records.map((r) => r.observedAt)) || t() };
    },
  });

  /** Called after the camera settles: refresh early if the screen centre moved far or the saved locations changed. */
  provider.maybeRefresh = () => {
    if (!provider.running) return false;
    const pts = getPoints();
    const c = pts[0];
    if (!c || clock() - lastAsked.at < 60_000) return false;
    const moved = lastAsked.lat == null || Math.abs(c.lat - lastAsked.lat) > 3 || Math.abs(c.lon - lastAsked.lon) > 3;
    const changed = pts.map((p) => p.id).join() !== lastAsked.key;
    if (!moved && !changed) return false;
    provider.refreshNow();
    return true;
  };
  return provider;
}
