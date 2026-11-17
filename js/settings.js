// settings.js — user preferences (saved in this browser only) and the Settings dialog.
//
// Rules we follow here:
//  * Only harmless preferences go into localStorage. Never API keys or secrets.
//  * Anything read back from storage is validated, so a corrupted value can't break the app.

import { createEmitter, el, formatCoord } from './util.js';
import { LAYER_DEFS, BASEMAPS, REFRESH_CHOICES } from './config.js';
import { STATE_LABEL, STATE_CHIP } from './data/provider-manager.js';
// (STATE_LABEL / STATE_CHIP map a provider state like "not_connected" to its on-screen word and colour class)

const KEY = 'gec.settings.v1';

export const DEFAULTS = {
  basemap: 'osm',
  dimBasemap: true,
  lighting: true,
  atmosphere: true,
  resolution: 'standard',            // 'battery' | 'standard' | 'high'
  defaultView: { lon: 122.0, lat: 12.0, height: 15000000 },  // same start view as the original prototype
  simulation: true,
  refreshSec: 2,
  density: 'comfortable',            // 'comfortable' | 'compact'
  clock12h: false,
  timestamps: 'utc',                 // 'utc' | 'local'
  visibleLayers: Object.fromEntries(LAYER_DEFS.map((l) => [l.id, true])),
};

const pick = (v, allowed, fallback) => (allowed.includes(v) ? v : fallback);
const bool = (v, fallback) => (typeof v === 'boolean' ? v : fallback);
const num = (v, lo, hi, fallback) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback);

/** Turn anything (including garbage) into a complete, valid settings object. */
export function sanitize(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const d = DEFAULTS;
  const dv = r.defaultView && typeof r.defaultView === 'object' ? r.defaultView : {};
  const vl = r.visibleLayers && typeof r.visibleLayers === 'object' ? r.visibleLayers : {};
  return {
    basemap: pick(r.basemap, Object.keys(BASEMAPS), d.basemap),
    dimBasemap: bool(r.dimBasemap, d.dimBasemap),
    lighting: bool(r.lighting, d.lighting),
    atmosphere: bool(r.atmosphere, d.atmosphere),
    resolution: pick(r.resolution, ['battery', 'standard', 'high'], d.resolution),
    defaultView: {
      lon: num(dv.lon, -180, 180, d.defaultView.lon),
      lat: num(dv.lat, -90, 90, d.defaultView.lat),
      height: num(dv.height, 200, 60000000, d.defaultView.height),
    },
    simulation: bool(r.simulation, d.simulation),
    refreshSec: REFRESH_CHOICES.includes(r.refreshSec) ? r.refreshSec : d.refreshSec,
    density: pick(r.density, ['comfortable', 'compact'], d.density),
    clock12h: bool(r.clock12h, d.clock12h),
    timestamps: pick(r.timestamps, ['utc', 'local'], d.timestamps),
    visibleLayers: Object.fromEntries(LAYER_DEFS.map((l) => [l.id, bool(vl[l.id], true)])),
  };
}

export function createSettings() {
  const emitter = createEmitter();
  let value;
  try {
    const stored = localStorage.getItem(KEY);
    value = sanitize(stored ? JSON.parse(stored) : null);
  } catch {
    value = sanitize(null);
  }

  function persist() {
    try { localStorage.setItem(KEY, JSON.stringify(value)); } catch { /* private mode / storage full: keep working in memory */ }
  }

  return {
    get: () => value,
    set(patch) {
      value = sanitize({ ...value, ...patch });
      persist();
      emitter.emit('change', { patch, value });
    },
    setLayerVisible(id, visible) {
      this.set({ visibleLayers: { ...value.visibleLayers, [id]: visible } });
    },
    reset() {
      value = sanitize(null);
      persist();
      emitter.emit('change', { patch: null, value });
    },
    on: emitter.on,
  };
}

// ---------------------------------------------------------------------------
// Settings dialog (a native <dialog>: focus trapping, Esc to close, backdrop — all built in)
// ---------------------------------------------------------------------------

export function mountSettingsDialog({ dialog, settings, getCurrentView, flyToDefault, providers, catalog, toast }) {
  const $ = (id) => dialog.querySelector(`#${id}`);

  const controls = [
    ['set-basemap', 'basemap', 'value'],
    ['set-dim', 'dimBasemap', 'checked'],
    ['set-lighting', 'lighting', 'checked'],
    ['set-atmosphere', 'atmosphere', 'checked'],
    ['set-resolution', 'resolution', 'value'],
    ['set-simulation', 'simulation', 'checked'],
    ['set-refresh', 'refreshSec', 'number'],
    ['set-density', 'density', 'value'],
    ['set-clock12', 'clock12h', 'checked'],
    ['set-timestamps', 'timestamps', 'value'],
  ];

  // Fill the basemap choices from config so there is one source of truth.
  const bm = $('set-basemap');
  bm.replaceChildren(...Object.entries(BASEMAPS).map(([k, v]) => el('option', { value: k, text: v.label })));
  const rf = $('set-refresh');
  rf.replaceChildren(...REFRESH_CHOICES.map((s) => el('option', { value: s, text: `${s} s` })));

  function syncFromSettings() {
    const s = settings.get();
    for (const [id, key, kind] of controls) {
      const node = $(id);
      if (kind === 'checked') node.checked = Boolean(s[key]);
      else node.value = String(s[key]);
    }
    const v = s.defaultView;
    $('set-default-view').textContent = `${formatCoord(v.lon, v.lat, 2)} · ${Math.round(v.height / 1000).toLocaleString('en-US')} km up`;
  }

  for (const [id, key, kind] of controls) {
    $(id).addEventListener('change', (e) => {
      const node = e.target;
      const val = kind === 'checked' ? node.checked : kind === 'number' ? Number(node.value) : node.value;
      settings.set({ [key]: val });
    });
  }

  $('set-use-current').addEventListener('click', () => {
    const v = getCurrentView();
    if (!v) { toast('Could not read the current camera position.', 'warn'); return; }
    settings.set({ defaultView: v });
    syncFromSettings();
    toast('Default view saved.');
  });
  $('set-fly-default').addEventListener('click', () => { dialog.close(); flyToDefault(); });
  $('set-reset').addEventListener('click', () => {
    settings.reset();
    syncFromSettings();
    toast('Settings reset to defaults.');
  });
  $('set-close').addEventListener('click', () => dialog.close());
  dialog.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => dialog.close()));
  // click on the dark backdrop (the <dialog> element itself) closes it
  dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.close(); });

  function renderSources() {
    const host = $('set-sources');
    host.replaceChildren(...catalog.map((src) => {
      // This list describes the REAL source. A simulated stand-in on the same layer does not make it "connected".
      const live = providers.list().find((p) => p.kind === 'live' && p.layerId === src.layerId && p.running);
      const state = live ? live.state : src.onDemand ? 'on_demand' : 'not_connected';
      return el('details', { class: 'src' },
        el('summary', {}, el('span', { text: src.name }), el('span', { class: `chip ${STATE_CHIP[state]}`, text: STATE_LABEL[state] })),
        el('dl', {},
          ...[
            ['Layer', src.layerLabel],
            ['Endpoint', src.endpoint],
            ['Auth', src.auth],
            ['Rate limit', src.rateLimit],
            ['Updates', src.updateFrequency],
            ['Restrictions', src.restrictions],
            ['CORS', src.cors],
            ['Proxy needed', src.proxy],
            ['Planned for', src.phase],
          ].flatMap(([k, v]) => [el('dt', { text: k }), el('dd', { text: v })])));
    }));
  }

  settings.on('change', syncFromSettings);
  return {
    open() {
      syncFromSettings();
      renderSources();
      if (!dialog.open) dialog.showModal();
    },
  };
}
