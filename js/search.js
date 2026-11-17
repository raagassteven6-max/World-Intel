// search.js — the global search box.
//
// What it searches (Phase 1):
//   1. Coordinates you type            ("12.5, 122.1"  or  "12.5N 122.1E")
//   2. Entities already on the globe   (name, callsign, MMSI, NORAD id…)  — instant, local
//   3. Place names, via OpenStreetMap Nominatim — ONLY when you press Enter (the public server
//      forbids search-as-you-type and allows at most 1 request/second).

import { el, formatCoord, parseCoordinates } from './util.js';
import { TYPE_LABEL } from './config.js';

const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
const MIN_GAP_MS = 1100;

export function mountSearch({ form, input, resultsBox, store, globe, setPin, toast }) {
  let lastRequestAt = 0;
  const cache = new Map();           // the usage policy asks us to cache results
  let controller = null;

  const close = () => { resultsBox.hidden = true; resultsBox.replaceChildren(); input.setAttribute('aria-expanded', 'false'); };

  function item(main, sub, onChoose) {
    return el('li', {}, el('button', {
      type: 'button', class: 'search__item',
      onclick: () => { onChoose(); close(); },
    }, el('span', { class: 'search__item-main', text: main }), sub ? el('span', { class: 'search__item-sub', text: sub }) : null));
  }

  function group(title, items) {
    return items.length ? [el('li', { class: 'search__group', role: 'presentation', text: title }), ...items] : [];
  }

  function paint({ coord, entities, places, message, attribution }) {
    const list = el('ul', { role: 'list' });
    const rows = [];
    if (coord) {
      rows.push(...group('Coordinates', [item(`Go to ${formatCoord(coord.lon, coord.lat, 4)}`, 'Fly there and mark the point', () => {
        setPin(coord.lon, coord.lat);
        globe.flyTo({ lon: coord.lon, lat: coord.lat, height: 800000 });
      })]));
    }
    rows.push(...group('On the globe', entities.map((rec) => item(rec.name, `${TYPE_LABEL[rec.type] ?? rec.type} · ${formatCoord(rec.lon, rec.lat, 2)}`, () => {
      globe.select(rec.id);
      globe.flyToRecord(rec);
    }))));
    if (places) {
      rows.push(...group('Places', places.map((p) => item(p.display_name, formatCoord(Number(p.lon), Number(p.lat), 3), () => {
        const [south, north, west, east] = (p.boundingbox ?? []).map(Number);
        setPin(Number(p.lon), Number(p.lat));
        if ([south, north, west, east].every(Number.isFinite)) globe.flyToRectangle(west, south, east, north);
        else globe.flyTo({ lon: Number(p.lon), lat: Number(p.lat), height: 400000 });
      }))));
    }
    list.append(...rows);
    resultsBox.replaceChildren(list);
    if (message) resultsBox.append(el('p', { class: 'search__msg', role: 'status', text: message }));
    if (attribution) resultsBox.append(el('p', { class: 'search__attr', text: attribution }));
    resultsBox.hidden = false;
    input.setAttribute('aria-expanded', 'true');
  }

  function localResults(text) {
    return { coord: parseCoordinates(text), entities: store.search(text) };
  }

  input.addEventListener('input', () => {
    const text = input.value.trim();
    if (!text) { close(); return; }
    const local = localResults(text);
    paint({
      ...local,
      message: local.coord || local.entities.length ? 'Press Enter to also search place names.' : 'No match on the globe. Press Enter to search place names.',
    });
  });

  async function placeSearch(text) {
    const key = text.toLowerCase();
    if (cache.has(key)) return cache.get(key);
    const wait = lastRequestAt + MIN_GAP_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    controller?.abort();
    controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    lastRequestAt = Date.now();
    try {
      const url = `${NOMINATIM}?format=jsonv2&limit=6&q=${encodeURIComponent(text)}`;
      const res = await fetch(url, { signal: controller.signal, headers: { Accept: 'application/json' } });
      if (res.status === 429) throw new Error('rate-limited');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (!Array.isArray(data)) throw new Error('unexpected response');
      cache.set(key, data);
      return data;
    } finally {
      clearTimeout(timeout);
    }
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    const local = localResults(text);
    // An exact coordinate or a single local hit: act immediately, no network needed.
    if (local.coord && !local.entities.length) {
      setPin(local.coord.lon, local.coord.lat);
      globe.flyTo({ lon: local.coord.lon, lat: local.coord.lat, height: 800000 });
      close();
      return;
    }
    paint({ ...local, message: 'Searching places…' });
    try {
      const places = await placeSearch(text);
      if (input.value.trim() !== text) return;           // user kept typing; ignore the stale answer
      paint({
        ...local, places,
        message: places.length || local.coord || local.entities.length ? null : 'No places found.',
        attribution: 'Place search © OpenStreetMap contributors (Nominatim)',
      });
    } catch (err) {
      if (input.value.trim() !== text) return;
      const msg = err.name === 'AbortError' ? 'Place search timed out.' : err.message === 'rate-limited' ? 'Place search is rate-limited right now. Wait a moment and try again.' : 'Place search is unavailable (offline or blocked). Coordinates and on-globe results still work.';
      paint({ ...local, message: msg });
      toast(msg, 'warn');
    }
  });

  document.addEventListener('click', (e) => { if (!form.contains(e.target)) close(); });
  input.addEventListener('keydown', (e) => { if (e.key === 'Escape') { close(); input.blur(); } });
  return { close };
}
