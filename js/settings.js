// settings.js — user preferences (saved in this browser only) and the Settings dialog.
//
// Rules we follow here:
//  * Only harmless preferences go into localStorage. Never API keys or secrets.
//  * Anything read back from storage is validated, so a corrupted value can't break the app.

import { createEmitter, el, formatCoord } from './util.js';
import { LAYER_DEFS, BASEMAPS, REFRESH_CHOICES } from './config.js';
import { STATE_LABEL, STATE_CHIP } from './data/provider-manager.js';
import { fetchJson, proxyUrl } from './data/net.js';
// (STATE_LABEL / STATE_CHIP map a provider state like "not_connected" to its on-screen word and colour class)

const KEY = 'gec.settings.v1';

export const DEFAULTS = {
  basemap: 'osm',
  dimBasemap: true,
  lighting: true,
  atmosphere: true,
  resolution: 'standard',            // 'battery' | 'standard' | 'high'
  defaultView: { lon: 122.0, lat: 12.0, height: 15000000 },  // same start view as the original prototype
  liveFeeds: true,                   // try real data sources
  proxyUrl: '',                      // address of YOUR Cloudflare Worker (an address, never a secret)
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

/** Accept only a clean https address (or http://localhost for testing); anything else becomes '' (= no proxy). */
export function cleanProxyUrl(v) {
  if (typeof v !== 'string') return '';
  const text = v.trim();
  if (!text || text.length > 200) return '';
  try {
    const u = new URL(text);
    const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
    if (!(u.protocol === 'https:' || (u.protocol === 'http:' && local))) return '';
    if (u.username || u.password || u.search || u.hash) return '';          // no credentials/keys smuggled into the address
    return `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
  } catch { return ''; }
}

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
    liveFeeds: bool(r.liveFeeds, d.liveFeeds),
    proxyUrl: cleanProxyUrl(r.proxyUrl),
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
    ['set-live', 'liveFeeds', 'checked'],
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
    // "Test proxy": says exactly which step fails instead of one vague error.
  $('set-proxy-test').addEventListener('click', async () => {
    const out = $('set-proxy-result'); const base = settings.get().proxyUrl;
    if (!base) { out.textContent = 'Enter the proxy address first (it must start with https://).'; return; }
    out.textContent = 'Testing…';
    try {
      const { data } = await fetchJson(proxyUrl(base, 'health', { deep: 1 }), { timeoutMs: 15000 });
      const bad = [data.adsb !== 'ok' && `aircraft source (adsb.lol): ${data.adsb}`, data.celestrak !== 'ok' && `satellite source (CelesTrak): ${data.celestrak}`].filter(Boolean);
      out.textContent = bad.length
        ? `Proxy reachable and your site is allowed, but the Worker cannot reach: ${bad.join('; ')}. Try again in a minute.`
        : 'Proxy works: reachable, your site is allowed, and both data sources answered.';
    } catch (err) {
      out.textContent = err.kind === 'network'
        ? 'Could not connect. Check: (1) the address is exactly the workers.dev address shown in Cloudflare, (2) the Worker is deployed, (3) ALLOWED_ORIGIN is set (an unset or wrong value can also look like this on older copies of the Worker). Open the address + /health in a new tab to see.'
        : err.message;
    }
  });

  for (const [id, key, kind] of controls) {
      const node = $(id);
      if (kind === 'checked') node.checked = Boolean(s[key]);
      else node.value = String(s[key]);
    }
    $('set-proxy').value = s.proxyUrl;
    const v = s.defaultView;
    $('set-default-view').textContent = `${formatCoord(v.lon, v.lat, 2)} · ${Math.round(v.height / 1000).toLocaleString('en-US')} km up`;
  }

  // The proxy address is validated: a bad value is refused with a message instead of silently ignored.
  $('set-proxy').addEventListener('change', (e) => {
    const typed = e.target.value.trim();
    const clean = cleanProxyUrl(typed);
    if (typed && !clean) toast('Proxy address must start with https:// and contain no password or ? parts.', 'warn');
    settings.set({ proxyUrl: clean });
    syncFromSettings();
  });

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
