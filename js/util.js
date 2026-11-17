// util.js — small, dependency-free helpers shared by every module.
// Nothing in here touches Cesium or the network.

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Build a DOM element. Text always goes in as text (never HTML), so untrusted data can't inject markup. */
export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, val] of Object.entries(props)) {
    if (val === null || val === undefined || val === false) continue;
    if (key === 'class') node.className = val;
    else if (key === 'text') node.textContent = val;
    else if (key === 'dataset') Object.assign(node.dataset, val);
    else if (key.startsWith('on') && typeof val === 'function') node.addEventListener(key.slice(2).toLowerCase(), val);
    else node.setAttribute(key, val === true ? '' : String(val));
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

/** <svg><use href="#id"/></svg> pointing at the icon sprite in index.html. */
export function icon(id, cls = 'icon') {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', cls);
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(SVG_NS, 'use');
  use.setAttribute('href', `#${id}`);
  svg.append(use);
  return svg;
}

/** Tiny event emitter. `on` returns an unsubscribe function. */
export function createEmitter() {
  const handlers = new Map();
  return {
    on(event, fn) {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event).add(fn);
      return () => handlers.get(event)?.delete(fn);
    },
    emit(event, payload) {
      for (const fn of [...(handlers.get(event) ?? [])]) {
        try { fn(payload); } catch (err) { console.error(`[emitter] handler for "${event}" threw`, err); }
      }
    },
  };
}

export const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
export const rad = (d) => (d * Math.PI) / 180;
export const deg = (r) => (r * 180) / Math.PI;
export const normLon = (lon) => ((((lon + 180) % 360) + 360) % 360) - 180;

/** Run fn at most once per animation frame (falls back to a timer when the tab is hidden). */
export function frameThrottle(fn) {
  let queued = false;
  return (...args) => {
    if (queued) return;
    queued = true;
    const run = () => { queued = false; fn(...args); };
    if (document.hidden) setTimeout(run, 250);
    else requestAnimationFrame(run);
  };
}

// ---------- number / coordinate formatting ----------

export function formatLat(lat, digits = 4) {
  return `${Math.abs(lat).toFixed(digits)}°${lat >= 0 ? 'N' : 'S'}`;
}
export function formatLon(lon, digits = 4) {
  return `${Math.abs(lon).toFixed(digits)}°${lon >= 0 ? 'E' : 'W'}`;
}
export function formatCoord(lon, lat, digits = 4) {
  return `${formatLat(lat, digits)} ${formatLon(lon, digits)}`;
}

/** Metres → "850 m" / "10.6 km" / "15,000 km" */
export function formatAltitude(m) {
  if (m === null || m === undefined || Number.isNaN(m)) return null;
  if (Math.abs(m) < 1000) return `${Math.round(m)} m`;
  if (Math.abs(m) < 100000) return `${(m / 1000).toFixed(1)} km`;
  return `${Math.round(m / 1000).toLocaleString('en-US')} km`;
}

export function formatNumber(n, digits = 0, unit = '') {
  if (n === null || n === undefined || Number.isNaN(n)) return null;
  return `${n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}${unit ? ' ' + unit : ''}`;
}

/** Heading in degrees → "087° E" style string. */
export function formatHeading(h) {
  if (h === null || h === undefined || Number.isNaN(h)) return null;
  const pts = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  const norm = ((h % 360) + 360) % 360;
  return `${String(Math.round(norm)).padStart(3, '0')}° ${pts[Math.round(norm / 45) % 8]}`;
}

// ---------- time formatting ----------

const formatterCache = new Map();
function formatter(key, opts) {
  if (!formatterCache.has(key)) formatterCache.set(key, new Intl.DateTimeFormat('en-GB', opts));
  return formatterCache.get(key);
}

/** "13:20:05" — UTC or local, 24h or 12h. */
export function formatClock(date, { utc = false, hour12 = false, seconds = true, zoneName = false } = {}) {
  const key = `${utc}|${hour12}|${seconds}|${zoneName}`;
  const f = formatter(key, {
    hour: '2-digit', minute: '2-digit', second: seconds ? '2-digit' : undefined,
    hour12, timeZone: utc ? 'UTC' : undefined, timeZoneName: zoneName ? 'short' : undefined,
  });
  return f.format(date);
}

/** "13:20:05Z" or "21:20:05" according to the user's timestamp settings. */
export function formatTime(ms, s) {
  if (ms === null || ms === undefined) return null;
  const d = new Date(ms);
  const utc = s.timestamps === 'utc';
  return formatClock(d, { utc, hour12: utc ? false : s.clock12h }) + (utc ? 'Z' : '');
}

/** "2026-10-30 13:20:05Z" */
export function formatDateTime(ms, s) {
  if (ms === null || ms === undefined) return null;
  const d = new Date(ms);
  const utc = s.timestamps === 'utc';
  const date = utc
    ? d.toISOString().slice(0, 10)
    : formatter('date-local', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(d).split('/').reverse().join('-');
  return `${date} ${formatTime(ms, s)}`;
}

/** "12 s ago" / "3 min ago" */
export function formatAge(ms, now = Date.now()) {
  if (ms === null || ms === undefined) return null;
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  return `${Math.round(s / 3600)} h ago`;
}

// ---------- geometry ----------

const EARTH_R = 6371008.8;

/** Where do you end up if you travel `distM` metres on `bearingDeg` from a point (great circle)? */
export function destination(lonDeg, latDeg, bearingDeg, distM) {
  const d = distM / EARTH_R;
  const t = rad(bearingDeg);
  const p1 = rad(latDeg);
  const l1 = rad(lonDeg);
  const sinP2 = Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(t);
  const p2 = Math.asin(clamp(sinP2, -1, 1));
  const l2 = l1 + Math.atan2(Math.sin(t) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * sinP2);
  return { lon: normLon(deg(l2)), lat: deg(p2) };
}

/** Great-circle distance in metres. */
export function distanceM(lon1, lat1, lon2, lat2) {
  const dp = rad(lat2 - lat1);
  const dl = rad(lon2 - lon1);
  const a = Math.sin(dp / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dl / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(a)));
}

// ---------- coordinate parsing (for the search box) ----------

/**
 * Understands: "12.5, 122.1"   "12.5 122.1"   "12.5N 122.1E"   "122.1E 12.5N"   "-33.9, 151.2"
 * Plain numbers are read as latitude first, then longitude.
 * Returns { lat, lon } or null. Never guesses outside valid ranges.
 */
export function parseCoordinates(text) {
  if (typeof text !== 'string') return null;
  const m = text.trim().match(/^(-?\d+(?:\.\d+)?)\s*°?\s*([NSEWnsew])?\s*[,;\s]\s*(-?\d+(?:\.\d+)?)\s*°?\s*([NSEWnsew])?$/);
  if (!m) return null;
  let [, a, h1, b, h2] = m;
  a = parseFloat(a); b = parseFloat(b);
  h1 = h1?.toUpperCase(); h2 = h2?.toUpperCase();
  let lat; let lon;
  if (h1 && h2) {
    const first = 'NS'.includes(h1) ? 'lat' : 'lon';
    const second = 'NS'.includes(h2) ? 'lat' : 'lon';
    if (first === second) return null;
    const signed = (v, h) => ((h === 'S' || h === 'W') ? -Math.abs(v) : Math.abs(v));
    if (first === 'lat') { lat = signed(a, h1); lon = signed(b, h2); }
    else { lon = signed(a, h1); lat = signed(b, h2); }
  } else if (h1 || h2) {
    return null; // one hemisphere letter only — ambiguous, don't guess
  } else {
    lat = a; lon = b;
  }
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat, lon };
}
