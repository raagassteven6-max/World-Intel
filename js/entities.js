// entities.js — the entity store.
//
// Plain-English: this is the app's single list of "things on the map". Data providers push records
// in; the store keeps ONE Cesium entity per record and updates it in place (it never rebuilds the globe).
// Everything else (panels, search, tracking, telemetry) reads from here.
//
// A record looks like:
//   { id, layerId, type, name, lon, lat, alt, heading, updatedAt, observedAt,
//     keepHistory?, source: {id, name, kind}, attrs: {…type-specific…} }

import { createEmitter } from './util.js';
import { LAYER_DEFS, TYPE_STYLE } from './config.js';
import { markerIcon } from './markers.js';

const Cesium = window.Cesium;
const HISTORY_MAX = 240;
const ROTATES = new Set(LAYER_DEFS.filter((l) => l.rotates).map((l) => l.id));

export function createEntityStore({ layers, requestRender }) {
  const records = new Map();
  const bySource = new Map();
  const emitter = createEmitter();
  let notifyQueued = false;

  function scheduleNotify() {
    if (notifyQueued) return;
    notifyQueued = true;
    setTimeout(() => { notifyQueued = false; emitter.emit('change'); }, 0);   // batch many upserts into one UI refresh
  }

  function visualFor(rec) {
    const style = TYPE_STYLE[rec.type] ?? TYPE_STYLE.pin;
    const sim = rec.source?.kind === 'simulated';
    const rotates = ROTATES.has(rec.layerId) && Number.isFinite(rec.heading);
    return { style, sim, rotates };
  }

  function syncEntity(rec) {
    const ds = layers.dataSource(rec.layerId);
    const position = Cesium.Cartesian3.fromDegrees(rec.lon, rec.lat, rec.alt ?? 0);
    const { style, sim, rotates } = visualFor(rec);
    const rotation = rotates ? -Cesium.Math.toRadians(rec.heading) : 0;

    let ent = ds.entities.getById(rec.id);
    if (!ent) {
      ent = ds.entities.add({
        id: rec.id,
        name: rec.name,
        position,
        billboard: {
          image: markerIcon(rec.type, { sim }),
          width: style.size, height: style.size,
          rotation,
          alignedAxis: rotates ? Cesium.Cartesian3.UNIT_Z : Cesium.Cartesian3.ZERO,
          verticalOrigin: Cesium.VerticalOrigin.CENTER,
          scaleByDistance: new Cesium.NearFarScalar(1.5e6, 1.0, 3.0e7, 0.6),
          disableDepthTestDistance: 1.0e5,
        },
        label: {
          text: rec.name,
          show: false,                                              // only shown for tracked entities
          font: '600 12px "IBM Plex Mono", ui-monospace, monospace',
          fillColor: Cesium.Color.fromCssColorString('#d6e4f0'),
          outlineColor: Cesium.Color.fromCssColorString('#05090f'),
          outlineWidth: 4,
          style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          verticalOrigin: Cesium.VerticalOrigin.TOP,
          pixelOffset: new Cesium.Cartesian2(0, 16),
          disableDepthTestDistance: 1.0e5,
        },
      });
    } else {
      ent.position = position;                                      // incremental update: only the position changes
      if (rotates) ent.billboard.rotation = rotation;
    }
  }

  function pushHistory(rec) {
    if (!rec.keepHistory) return;
    rec.history ??= [];
    const last = rec.history[rec.history.length - 1];
    if (last && last.lon === rec.lon && last.lat === rec.lat) return;
    rec.history.push({ t: rec.observedAt ?? rec.updatedAt, lon: rec.lon, lat: rec.lat, alt: rec.alt ?? 0 });
    if (rec.history.length > HISTORY_MAX) rec.history.shift();
  }

  function track(rec) {
    const srcId = rec.source?.id ?? 'unknown';
    if (!bySource.has(srcId)) bySource.set(srcId, new Set());
    bySource.get(srcId).add(rec.id);
  }

  return {
    records,
    get: (id) => records.get(id),

    upsertMany(list) {
      const touched = new Set();
      for (const incoming of list) {
        const prev = records.get(incoming.id);
        const rec = prev ? Object.assign(prev, incoming) : incoming;
        records.set(rec.id, rec);
        track(rec);
        pushHistory(rec);
        const ds = layers.dataSource(rec.layerId);
        if (!touched.has(ds)) { ds.entities.suspendEvents(); touched.add(ds); }
        syncEntity(rec);
      }
      touched.forEach((ds) => ds.entities.resumeEvents());
      requestRender();
      scheduleNotify();
    },

    remove(id) {
      const rec = records.get(id);
      if (!rec) return;
      layers.dataSource(rec.layerId).entities.removeById(id);
      records.delete(id);
      bySource.get(rec.source?.id ?? 'unknown')?.delete(id);
      requestRender();
      scheduleNotify();
    },
    removeById(id) { this.remove(id); },

    removeBySource(sourceId) {
      const ids = [...(bySource.get(sourceId) ?? [])];
      ids.forEach((id) => this.remove(id));
      bySource.delete(sourceId);
    },

    /** Make a tracked entity easier to see: show its name, enlarge the marker. */
    setHighlight(id, on) {
      const rec = records.get(id);
      if (!rec) return;
      const ent = layers.dataSource(rec.layerId).entities.getById(id);
      if (!ent) return;
      ent.label.show = on;
      const { style } = visualFor(rec);
      ent.billboard.width = on ? style.size * 1.3 : style.size;
      ent.billboard.height = on ? style.size * 1.3 : style.size;
      requestRender();
    },

    countsByLayer() {
      const counts = new Map();
      for (const rec of records.values()) counts.set(rec.layerId, (counts.get(rec.layerId) ?? 0) + 1);
      return counts;
    },

    visibleCount() {
      let n = 0;
      for (const rec of records.values()) if (rec.layerId && layers.isVisible(rec.layerId)) n += 1;
      return n;
    },

    /** Find records by name or identifier (callsign, MMSI, NORAD id…). Used by the search box. */
    search(query, limit = 8) {
      const q = query.trim().toLowerCase();
      if (!q) return [];
      const out = [];
      for (const rec of records.values()) {
        if (rec.type === 'pin') continue;
        const a = rec.attrs ?? {};
        const hay = [rec.name, a.callsign, a.icao24, a.mmsi, a.imo, a.noradId, a.vesselName]
          .filter((v) => v !== null && v !== undefined).join(' ').toLowerCase();
        if (hay.includes(q)) out.push(rec);
        if (out.length >= limit) break;
      }
      return out;
    },

    on: emitter.on,
  };
}
