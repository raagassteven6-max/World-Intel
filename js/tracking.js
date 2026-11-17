// tracking.js — the tracking subsystem (kept separate from the globe on purpose).
//
// Three separate ideas, so they don't get confused:
//   SELECTED  = the one entity whose details are open in the right panel (managed by the globe).
//   TRACKED   = entities you pinned to your watch list (this module). They keep a visible name label.
//   FOLLOWING = the camera locked onto one tracked entity (this module, uses Cesium's trackedEntity).
//
// Paths: we draw only OBSERVED positions (the points the data source actually reported while this
// page was open). Nothing is interpolated or guessed, so there is nothing to mislabel.

import { createEmitter, el, formatCoord, formatAge } from './util.js';

const Cesium = window.Cesium;

export function createTracker({ globe, store }) {
  const emitter = createEmitter();
  const tracked = new Map();            // id -> { since }
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
  store.on('change', () => { refreshPaths(); emitter.emit('change'); });

  const api = {
    isTracked: (id) => tracked.has(id),
    isFollowing: (id) => followingId === id,
    followingId: () => followingId,
    list: () => [...tracked.entries()].map(([id, v]) => ({ id, since: v.since })),

    add(id) {
      if (tracked.has(id)) return;
      tracked.set(id, { since: Date.now() });
      store.setHighlight(id, true);
      emitter.emit('change');
    },

    remove(id) {
      if (!tracked.has(id)) return;
      if (followingId === id) api.follow(null);
      tracked.delete(id);
      store.setHighlight(id, false);
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
      const following = tracker.isFollowing(id);
      return el('li', { class: 'tracked__item', dataset: { following: String(following) } },
        el('span', { class: 'tracked__name', text: rec ? rec.name : id }),
        el('span', { class: 'tracked__actions' },
          el('button', {
            type: 'button', class: 'btn btn--small', text: 'Show',
            'aria-label': `Show ${rec?.name ?? id} on the globe`,
            disabled: !rec,
            onclick: () => { globe.select(id); if (rec) globe.flyToRecord(rec); },
          }),
          el('button', {
            type: 'button', class: 'btn btn--small btn--danger', text: 'Remove',
            'aria-label': `Stop tracking ${rec?.name ?? id}`,
            onclick: () => tracker.remove(id),
          })),
        el('span', {
          class: 'tracked__pos',
          text: rec
            ? `${formatCoord(rec.lon, rec.lat, 3)} · ${formatAge(rec.updatedAt)}${following ? ' · FOLLOWING' : ''}`
            : 'NO DATA — this source is no longer providing it',
        }));
    });
    root.replaceChildren(el('ul', { class: 'tracked', style: 'display:grid;gap:.25rem' }, rows));
  }

  tracker.on('change', render);
  settings.on('change', render);
  render();
  return { render };
}
