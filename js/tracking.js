// tracking.js — the tracking subsystem (kept separate from the globe on purpose).
//
// Three separate ideas, so they don't get confused:
//   SELECTED  = the one entity whose details are open in the right panel (managed by the globe).
//   TRACKED   = entities you pinned to your watch list (this module). They keep a visible name label.
//   FOLLOWING = the camera locked onto one tracked entity (this module, uses Cesium's trackedEntity).
//
// Paths: we draw only OBSERVED positions (the points the data source actually reported while this
// page was open). Nothing is interpolated or guessed, so there is nothing to mislabel.

import { createEmitter, el, formatCoord, formatAge, formatTime } from './util.js';

const Cesium = window.Cesium;

const KEY = 'gec.tracked.v1';
const MAX_TRACKED = 50;
const WAIT_MS = 2 * 60_000;             // after a reload, how long we wait for a saved item to show up before calling it "not reported"

/** Read the saved watch list. Only real (non-simulated) things are ever saved; anything malformed is dropped. */
export function loadTracked(storage = (() => { try { return globalThis.localStorage; } catch { return undefined; } })()) {
  try {
    const raw = JSON.parse(storage?.getItem(KEY) ?? '[]');
    if (!Array.isArray(raw)) return [];
    return raw.filter((r) => r && typeof r.id === 'string' && r.id.length < 80 && !r.id.startsWith('sim:') && !r.id.startsWith('pin'))
      .slice(0, MAX_TRACKED)
      .map((r) => ({
        id: r.id, since: Number.isFinite(r.since) ? r.since : Date.now(),
        last: Number.isFinite(r.lon) && Number.isFinite(r.lat) && Math.abs(r.lat) <= 90 && Math.abs(r.lon) <= 180
          ? { name: typeof r.name === 'string' ? r.name.slice(0, 80) : r.id, type: typeof r.type === 'string' ? r.type.slice(0, 20) : null, lon: r.lon, lat: r.lat, seenAt: Number.isFinite(r.seenAt) ? r.seenAt : null }
          : null,
      }));
  } catch { return []; }
}

export function createTracker({ globe, store, storage = (() => { try { return globalThis.localStorage; } catch { return undefined; } })(), now = () => Date.now() }) {
  const emitter = createEmitter();
  const tracked = new Map();            // id -> { since }
  const lastSeen = new Map();           // id -> { name, type, lon, lat, seenAt, simulated }   (what we last heard, kept after a feed drops it)
  const seenThisSession = new Set();
  const startedAt = now();
  let lastSave = 0;
  const paths = new Map();              // id -> Cartesian3[]
  let followingId = null;

  const viewer = globe.viewer;

  viewer.trackedEntityChanged.addEventListener((ent) => {
    followingId = ent ? ent.id : null;     // keeps us honest if Cesium ends tracking itself
    emitter.emit('change');
  });

  function refreshPaths() {
    for (const id of paths.keys()) {
      const rec = store.get(id);
      paths.set(id, (rec?.history ?? []).map((h) => Cesium.Cartesian3.fromDegrees(h.lon, h.lat, h.alt)));
    }
    if (paths.size) globe.requestRender();
  }

  function save(force = false) {
    if (!force && now() - lastSave < 5000) return;
    lastSave = now();
    const rows = [...tracked.entries()].filter(([id]) => !id.startsWith('sim:') && !lastSeen.get(id)?.simulated).slice(0, MAX_TRACKED)
      .map(([id, v]) => ({ id, since: v.since, ...(lastSeen.get(id) ? { name: lastSeen.get(id).name, type: lastSeen.get(id).type, lon: lastSeen.get(id).lon, lat: lastSeen.get(id).lat, seenAt: lastSeen.get(id).seenAt } : {}) }));
    try { storage?.setItem(KEY, JSON.stringify(rows)); } catch { /* storage full/blocked: tracking still works this session */ }
  }

  /** Remember where every tracked thing was last reported, and re-highlight saved items when they reappear. */
  function noteSeen() {
    for (const id of tracked.keys()) {
      const rec = store.get(id);
      if (!rec) continue;
      seenThisSession.add(id);
      lastSeen.set(id, { name: rec.name, type: rec.type, lon: rec.lon, lat: rec.lat, seenAt: rec.observedAt ?? rec.updatedAt, simulated: rec.source?.kind === 'simulated' });
      store.setHighlight(id, true);
    }
    save();
  }
  store.on('change', () => { noteSeen(); refreshPaths(); emitter.emit('change'); });

  // Restore the saved watch list (real items only). Until each shows up in a feed it is honestly "waiting".
  for (const r of loadTracked(storage)) {
    tracked.set(r.id, { since: r.since });
    if (r.last) lastSeen.set(r.id, { ...r.last, simulated: false });
  }
  const api = {
    isTracked: (id) => tracked.has(id),
    /** 'live' = in a feed right now; 'waiting' = restored from a previous visit, not seen yet; 'lost' = not reported (any more). */
    status(id) {
      if (store.get(id)) return 'live';
      if (!seenThisSession.has(id) && now() - startedAt < WAIT_MS) return 'waiting';
      return 'lost';
    },
    lastSeen: (id) => lastSeen.get(id) ?? null,
    isFollowing: (id) => followingId === id,
    followingId: () => followingId,
    list: () => [...tracked.entries()].map(([id, v]) => ({ id, since: v.since })),

    add(id) {
      if (tracked.has(id) || tracked.size >= MAX_TRACKED) return;
      tracked.set(id, { since: now() });
      seenThisSession.add(id);
      noteSeen();
      save(true);
      emitter.emit('change');
    },

    remove(id) {
      if (!tracked.has(id)) return;
      if (followingId === id) api.follow(null);
      tracked.delete(id);
      lastSeen.delete(id);
      seenThisSession.delete(id);
      store.setHighlight(id, false);
      save(true);
      emitter.emit('change');
    },

    toggle(id) { if (tracked.has(id)) api.remove(id); else api.add(id); },

    follow(id) {
      if (!id) { viewer.trackedEntity = undefined; return; }
      const ent = globe.findEntity(id);
      if (ent) viewer.trackedEntity = ent;
      globe.requestRender();
    },

    // ---- observed-position paths
    hasPath: (id) => paths.has(id),
    canShowPath: (id) => (store.get(id)?.history?.length ?? 0) >= 2,
    togglePath(id) {
      if (paths.has(id)) {
        paths.delete(id);
        viewer.entities.removeById(`path:${id}`);
      } else {
        paths.set(id, []);
        refreshPaths();
        viewer.entities.add({
          id: `path:${id}`,
          polyline: {
            positions: new Cesium.CallbackProperty(() => paths.get(id) ?? [], false),
            width: 2,
            material: Cesium.Color.fromCssColorString('#38d6f5').withAlpha(0.9),
          },
        });
      }
      globe.requestRender();
      emitter.emit('change');
    },

    on: emitter.on,
  };
  return api;
}

/** The "Tracked" list in the left panel. */
export function mountTrackedList({ root, tracker, store, globe, settings }) {
  function render() {
    const items = tracker.list();
    if (!items.length) {
      root.replaceChildren(el('p', { class: 'note', text: 'Nothing tracked yet. Tap an entity on the globe, then press Track.' }));
      return;
    }
    const rows = items.map(({ id }) => {
      const rec = store.get(id);
      const status = tracker.status(id);
      const last = tracker.lastSeen(id);
      const shown = rec ?? last;
      const following = tracker.isFollowing(id);
      const s = settings.get();
      const text = status === 'live'
        ? `${formatCoord(rec.lon, rec.lat, 3)} · ${formatAge(rec.updatedAt)}${following ? ' · FOLLOWING' : ''}`
        : status === 'waiting'
          ? `WAITING FOR DATA — saved from your last visit${last?.seenAt ? `; last seen ${formatTime(last.seenAt, s)} (${formatAge(last.seenAt)})` : ''}`
          : last?.seenAt
            ? `NOT CURRENTLY REPORTED — last seen ${formatTime(last.seenAt, s)} (${formatAge(last.seenAt)}) at ${formatCoord(last.lon, last.lat, 3)}`
            : 'NOT CURRENTLY REPORTED — this source is not providing it';
      return el('li', { class: 'tracked__item', dataset: { following: String(following), status } },
        el('span', { class: 'tracked__name', text: shown ? shown.name : id }),
        el('span', { class: 'tracked__actions' },
          el('button', {
            type: 'button', class: 'btn btn--small', text: status === 'live' ? 'Show' : 'Last seen',
            'aria-label': status === 'live' ? `Show ${shown?.name ?? id} on the globe` : `Fly to where ${shown?.name ?? id} was last seen`,
            disabled: !shown,
            onclick: () => {
              if (rec) { globe.select(id); globe.flyToRecord(rec); }
              else if (last) globe.flyToRecord({ type: last.type, lon: last.lon, lat: last.lat });
            },
          }),
          el('button', {
            type: 'button', class: 'btn btn--small btn--danger', text: 'Remove',
            'aria-label': `Stop tracking ${shown?.name ?? id}`,
            onclick: () => tracker.remove(id),
          })),
        el('span', { class: 'tracked__pos', text }));
    });
    root.replaceChildren(el('ul', { class: 'tracked', style: 'display:grid;gap:.25rem' }, rows));
  }

  tracker.on('change', render);
  settings.on('change', render);
  setInterval(() => { if (!document.hidden) render(); }, 5000);          // keeps "last seen … ago" and waiting→not-reported honest
  render();
  return { render };
}
