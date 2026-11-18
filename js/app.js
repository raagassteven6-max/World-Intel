// app.js — the conductor. It creates each module and connects them; it contains almost no logic of its own.
//
// Order of startup:
//   settings → page chrome (buttons that need no globe) → globe → layers → entity store →
//   data providers → panels / tracking / search / telemetry → start data.
//
// If Cesium or WebGL is unavailable, the page chrome still works and a clear message replaces the globe.
// Nothing pretends to be connected when it is not.

import { el, formatCoord, formatClock } from './util.js';
import { LAYER_DEFS } from './config.js';
import { createSettings, mountSettingsDialog } from './settings.js';
import { createGlobe } from './globe.js';
import { createLayerManager, mountLayerPanel } from './layers.js';
import { createEntityStore } from './entities.js';
import { createProviderManager } from './data/provider-manager.js';
import { CATALOG } from './data/provider-catalog.js';
import { createSimulatedProviders } from './data/sample-provider.js';
import { createLocalLocationsProvider } from './data/local-locations-provider.js';
import { createUsgsProvider } from './data/usgs-provider.js';
import { createAdsbProvider } from './data/adsb-provider.js';
import { createCelestrakProvider } from './data/celestrak-provider.js';
import { createTracker, mountTrackedList } from './tracking.js';
import { createIntelPanel } from './intel-panel.js';
import { mountTelemetry } from './telemetry.js';
import { mountSearch } from './search.js';

const $ = (id) => document.getElementById(id);
const app = $('app');
const desktop = window.matchMedia('(min-width: 900px)');

// ---------------------------------------------------------------- small UI helpers
function toast(message, level = 'info') {
  const node = el('div', { class: `toast${level === 'warn' ? ' toast--warn' : level === 'err' ? ' toast--err' : ''}`, text: message });
  $('toasts').append(node);
  setTimeout(() => node.remove(), 5500);
}

function showFatal(code, title, text, { retry = true } = {}) {
  const box = $('fatal');
  box.replaceChildren(
    el('span', { class: 'fatal__code', text: code }),
    el('h2', { class: 'fatal__title', text: title }),
    el('p', { class: 'fatal__text', text }),
    retry ? el('button', { type: 'button', class: 'btn btn--primary', text: 'Reload', onclick: () => location.reload() }) : null,
  );
  box.hidden = false;
}

function startBasicClocks(settings) {
  const tick = () => {
    const s = settings.get();
    const now = new Date();
    $('clock-utc').textContent = `${formatClock(now, { utc: true })}Z`;
    $('clock-loc').textContent = formatClock(now, { hour12: s.clock12h, zoneName: true });
  };
  tick();
  setInterval(tick, 1000);
}

function applyUiPrefs(s) {
  document.documentElement.dataset.density = s.density;
}

// ---------------------------------------------------------------- panels (left drawer / right sheet)
function setPanel(side, open) {
  app.dataset[side] = open ? 'open' : 'closed';
  const panel = side === 'left' ? $('panel-layers') : $('panel-intel');
  panel.inert = !open;
  $('btn-layers').setAttribute('aria-expanded', String(app.dataset.left === 'open'));
  $('btn-intel').setAttribute('aria-pressed', String(app.dataset.right === 'open'));
  $('scrim').hidden = desktop.matches || app.dataset.left !== 'open';
}

function initPanels() {
  setPanel('left', desktop.matches);
  setPanel('right', desktop.matches);
}

function wireChrome() {
  initPanels();
  desktop.addEventListener('change', initPanels);
  $('btn-layers').addEventListener('click', () => setPanel('left', app.dataset.left !== 'open'));
  $('btn-layers-close').addEventListener('click', () => setPanel('left', false));
  $('btn-intel').addEventListener('click', () => setPanel('right', app.dataset.right !== 'open'));
  $('btn-intel-close').addEventListener('click', () => setPanel('right', false));
  $('scrim').addEventListener('click', () => setPanel('left', false));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !desktop.matches) { setPanel('left', false); }
  });

  const cmdbar = $('cmdbar');
  $('btn-search').addEventListener('click', () => {
    const open = cmdbar.dataset.search !== 'open';
    cmdbar.dataset.search = open ? 'open' : 'closed';
    $('btn-search').setAttribute('aria-expanded', String(open));
    if (open) $('search-input').focus();
  });

  const fs = $('btn-fullscreen');
  if (!document.fullscreenEnabled) fs.hidden = true;            // e.g. iOS Safari: don't show a dead button
  fs.addEventListener('click', async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
    } catch {
      toast('The browser blocked fullscreen.', 'warn');
    }
  });
  document.addEventListener('fullscreenchange', () => fs.setAttribute('aria-pressed', String(Boolean(document.fullscreenElement))));
}

// ---------------------------------------------------------------- main
function main() {
  const settings = createSettings();
  applyUiPrefs(settings.get());
  wireChrome();

  if (!window.Cesium) {
    showFatal('GLOBE ENGINE NOT LOADED', 'The 3D engine (CesiumJS) could not be downloaded.',
      'Check your internet connection. The globe needs to load CesiumJS from cesium.com. Nothing on this page is showing live data.');
    $('sys-status').className = 'chip chip--err';
    $('sys-status').textContent = 'Globe offline';
    $('btn-settings').disabled = true;
    startBasicClocks(settings);
    return;
  }

  let globe;
  try {
    globe = createGlobe({ container: $('globe'), settings });
  } catch (err) {
    console.error(err);
    showFatal('WEBGL UNAVAILABLE', 'The 3D globe could not start.',
      'Your browser or device did not give this page a WebGL graphics context. Try Chrome or Firefox, turn on hardware acceleration, or close other heavy tabs. (' + (err?.message ?? 'unknown error') + ')');
    $('sys-status').className = 'chip chip--err';
    $('sys-status').textContent = 'Globe error';
    startBasicClocks(settings);
    return;
  }

  const layers = createLayerManager({ viewer: globe.viewer, settings, requestRender: globe.requestRender });
  const store = createEntityStore({ layers, requestRender: globe.requestRender });
  const providers = createProviderManager({ sink: store });
  const locations = createLocalLocationsProvider();
  providers.register(locations);
  createSimulatedProviders().forEach((p) => providers.register(p));

  // ---- real data sources (Phase 2). Each decides for itself whether it can run (e.g. needs the proxy address).
  const getProxy = () => settings.get().proxyUrl;
  const getView = () => {
    const c = globe.centerCoordinates();
    return { lon: c?.lon ?? null, lat: c?.lat ?? null, heightM: globe.cameraHeight() };
  };
  const shown = (layer) => () => settings.get().visibleLayers[layer] !== false;
  providers.register(createUsgsProvider({ isVisible: shown('earthquakes') }));
  providers.register(createAdsbProvider({ getProxy, getView, isVisible: shown('aircraft') }));
  providers.register(createCelestrakProvider({ getProxy, isVisible: shown('satellites') }));

  const tracker = createTracker({ globe, store });

  // ---- panels
  const layerPanel = mountLayerPanel({ root: $('layer-list-host'), layers, store, providers, settings });
  mountTrackedList({ root: $('tracked-list'), tracker, store, globe, settings });
  createIntelPanel({
    root: $('intel-body'), store, tracker, globe, settings, locations, toast,
    onOpen: () => { if (!desktop.matches) setPanel('left', false); setPanel('right', true); },
  });
  mountTelemetry({ globe, layers, store, providers, settings });

  // ---- selected point (the unsaved pin)
  function setPin(lon, lat) {
    const now = Date.now();
    store.upsertMany([{
      id: 'pin', layerId: null, type: 'pin', name: 'Selected point',
      lon, lat, alt: 0, heading: null, updatedAt: now, observedAt: now,
      source: { id: 'pin', name: 'You', kind: 'user' }, attrs: {},
    }]);
    globe.select('pin');
  }
  globe.on('locationpick', ({ lon, lat }) => setPin(lon, lat));
  globe.on('select', (id) => {
    if (id !== 'pin' && store.get('pin')) store.remove('pin');   // the pin disappears when you select something else
    const rec = id ? store.get(id) : null;
    $('sr-status').textContent = rec ? `Selected ${rec.name}` : 'Selection cleared';
  });

  // ---- search
  mountSearch({
    form: $('search-form'), input: $('search-input'), resultsBox: $('search-results'),
    store, globe, setPin, toast,
  });

  // ---- settings dialog
  const settingsUi = mountSettingsDialog({
    dialog: $('settings'), settings, providers, catalog: CATALOG, toast,
    getCurrentView: () => globe.currentView(),
    flyToDefault: () => globe.flyToDefault(),
  });
  $('btn-settings').addEventListener('click', () => settingsUi.open());

  // ---- globe controls
  $('btn-home').addEventListener('click', () => globe.flyToDefault());
  $('btn-north').addEventListener('click', () => globe.resetNorth());

  // ---- keep everything in sync when settings change
  // Each reaction below is its own listener, so one failing step can never stop the others.
  function whenChanged(keys, fn) {
    let seen = keys.map((k) => JSON.stringify(settings.get()[k]));
    settings.on('change', ({ value }) => {
      const now = keys.map((k) => JSON.stringify(value[k]));
      if (now.every((v, i) => v === seen[i])) return;
      seen = now;
      fn(value);
    });
  }
  whenChanged(['density'], applyUiPrefs);
  whenChanged(['basemap'], (v) => globe.setBasemap(v.basemap, v.dimBasemap));
  whenChanged(['dimBasemap'], (v) => globe.setDim(v.dimBasemap));
  whenChanged(['lighting', 'atmosphere', 'resolution'], (v) => globe.applyRenderSettings(v));
  const reconcile = (v) => {
    providers.reconcile({ live: v.liveFeeds, simulation: v.simulation });
    providers.setSimulationInterval(v.refreshSec);
  };
  whenChanged(['simulation', 'liveFeeds'], reconcile);
  whenChanged(['proxyUrl'], (v) => {
    ['adsblol', 'celestrak'].forEach((id) => { const p = providers.get(id); if (p?.running) p.stop(); });   // restart with the new address
    reconcile(v);
  });
  whenChanged(['refreshSec'], (v) => providers.setSimulationInterval(v.refreshSec));
  whenChanged(['visibleLayers'], (v) => {
    reconcile(v);                         // real sources stop fetching while their layer is switched off
    for (const def of LAYER_DEFS) {
      if (layers.isVisible(def.id) !== v.visibleLayers[def.id]) layers.setVisible(def.id, v.visibleLayers[def.id]);
    }
  });
  settings.on('change', () => layerPanel.render());

  // ---- layer panel refresh (counts, feed state, "updated … ago")
  store.on('change', layerPanel.render);
  providers.on('change', () => {
    layerPanel.render();
    $('sim-badge').hidden = providers.summary().simulated === 0;
  });
  setInterval(() => { if (!document.hidden) layerPanel.render(); }, 1000);

  // ---- friendly messages from the globe
  globe.on('basemapfail', ({ key }) => toast(`Basemap "${key}" could not load. Using OpenStreetMap instead.`, 'warn'));
  globe.on('rendererror', () => showFatal('RENDER ERROR', 'The globe stopped rendering.',
    'The graphics layer hit an error and cannot continue. Reloading usually fixes it.'));

  // ---- save battery: pause simulated updates while the tab is hidden
  document.addEventListener('visibilitychange', () => { if (document.hidden) providers.pauseAll(); else providers.resumeAll(); });

  // ---- go
  providers.startKind('local');
  reconcile(settings.get());
  $('sim-badge').hidden = providers.summary().simulated === 0;

  // Handle for manual debugging from the browser console (e.g.  __gec.store.records ).
  window.__gec = { settings, globe, layers, store, providers, tracker, formatCoord };
}

main();
