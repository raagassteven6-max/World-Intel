// local-locations-provider.js — the "My locations" layer.
// This one is REAL data: places you saved yourself, kept in this browser's localStorage.
// (It never leaves your device. If you clear site data, they are gone.)

import { STATE } from './provider-manager.js';

const KEY = 'gec.locations.v1';
const MAX = 200;

function load() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((r) => r && typeof r.id === 'string' && Number.isFinite(r.lon) && Number.isFinite(r.lat))
      .slice(0, MAX)
      .map((r) => ({
        id: r.id,
        name: typeof r.name === 'string' && r.name.trim() ? r.name.trim().slice(0, 60) : 'Saved location',
        lon: Math.max(-180, Math.min(180, r.lon)),
        lat: Math.max(-90, Math.min(90, r.lat)),
        savedAt: Number.isFinite(r.savedAt) ? r.savedAt : Date.now(),
      }));
  } catch {
    return [];
  }
}

export function createLocalLocationsProvider() {
  const source = { id: 'local-locations', name: 'Saved in this browser', kind: 'local' };
  let ctx = null;
  let saved = load();

  const toRecord = (r) => ({
    id: r.id, layerId: 'locations', type: 'location', name: r.name,
    lon: r.lon, lat: r.lat, alt: 0, heading: null,
    updatedAt: r.savedAt, observedAt: r.savedAt, source,
    attrs: { savedAt: r.savedAt },
  });

  function persist() {
    try { localStorage.setItem(KEY, JSON.stringify(saved)); return true; } catch { return false; }
  }

  const provider = {
    id: 'local-locations', layerId: 'locations', name: 'My saved locations', kind: 'local',
    attribution: 'Saved in this browser (localStorage). Never uploaded.',
    state: STATE.OFF, lastUpdate: null, error: null, running: false,

    start(c) {
      ctx = c;
      provider.running = true;
      provider.state = STATE.LOCAL;
      ctx.sink.upsertMany(saved.map(toRecord));
      provider.lastUpdate = Date.now();
      ctx.notify();
    },
    stop() {
      provider.running = false; provider.state = STATE.OFF;
      ctx?.sink.removeBySource(source.id);
      ctx?.notify();
    },

    /** @returns {{ok:boolean, id?:string, reason?:string}} */
    add({ name, lon, lat }) {
      if (saved.length >= MAX) return { ok: false, reason: `Limit of ${MAX} saved locations reached.` };
      const rec = {
        id: `loc:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`,
        name: (name ?? '').trim().slice(0, 60) || 'Saved location',
        lon, lat, savedAt: Date.now(),
      };
      saved.push(rec);
      const stored = persist();
      ctx?.sink.upsertMany([toRecord(rec)]);
      provider.lastUpdate = Date.now();
      ctx?.notify();
      return { ok: true, id: rec.id, stored };
    },

    remove(id) {
      saved = saved.filter((r) => r.id !== id);
      persist();
      ctx?.sink.removeById(id);
      provider.lastUpdate = Date.now();
      ctx?.notify();
    },
  };
  return provider;
}
