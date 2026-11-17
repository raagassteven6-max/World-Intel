// telemetry.js — the top-bar clocks / system status and the bottom telemetry bar.
//
// "System status" is computed from facts (is the browser online? did the globe crash? are tiles failing?
// what are the data sources actually doing?). It is never a hard-coded "ONLINE".

import { formatClock, formatCoord, formatAltitude, formatTime, formatAge } from './util.js';

export function mountTelemetry({ globe, layers, store, providers, settings }) {
  const $ = (id) => document.getElementById(id);
  const ui = {
    utc: $('clock-utc'), loc: $('clock-loc'),
    status: $('sys-status'), srcCount: $('src-count'),
    ctr: $('t-ctr'), cur: $('t-cur'), alt: $('t-alt'), lyr: $('t-lyr'),
    ent: $('t-ent'), feed: $('t-feed'), ref: $('t-ref'), sync: $('t-sync'), perf: $('t-perf'),
  };

  const health = { rendererError: false, tileErrors: 0, tileErrorAt: 0 };

  // ------------------------------------------------------------ clocks
  function tickClocks() {
    const s = settings.get();
    const now = new Date();
    ui.utc.textContent = `${formatClock(now, { utc: true })}Z`;
    ui.loc.textContent = formatClock(now, { hour12: s.clock12h, zoneName: true });
    renderStatus();   // cheap; keeps "stale"/offline honest without extra timers
  }

  // ------------------------------------------------------------ system status
  function computeStatus() {
    const sum = providers.summary();
    if (health.rendererError) return { cls: 'chip--err', label: 'Globe error', detail: 'The 3D globe stopped rendering. Reload the page.' };
    if (!navigator.onLine) return { cls: 'chip--err', label: 'Offline', detail: 'No network connection. Simulated and saved data still work; map tiles may not load.' };
    if (sum.error > 0) return { cls: 'chip--warn', label: 'Degraded', detail: `${sum.error} data source(s) reporting errors.` };
    const recentTileErrors = health.tileErrors >= 5 && Date.now() - health.tileErrorAt < 30000;
    if (recentTileErrors) return { cls: 'chip--warn', label: 'Basemap issue', detail: 'Map tiles are failing to load. Check your connection or choose another basemap in Settings.' };
    if (sum.live > 0) return { cls: 'chip--live', label: 'Live', detail: `${sum.live} live source(s) connected.` };
    if (sum.simulated > 0) return { cls: 'chip--sim', label: 'Simulation', detail: 'No live feeds connected. Showing simulated sample data.' };
    return { cls: 'chip--off', label: 'No feeds', detail: 'No live feeds connected and simulation is off.' };
  }

  function renderStatus() {
    const st = computeStatus();
    ui.status.className = `chip ${st.cls}`;
    ui.status.textContent = st.label;
    ui.status.title = st.detail;
    ui.status.setAttribute('aria-label', `System status: ${st.label}. ${st.detail}`);
  }

  // ------------------------------------------------------------ bottom bar
  function renderCamera() {
    const c = globe.centerCoordinates();
    ui.ctr.textContent = c ? formatCoord(c.lon, c.lat, 3) : '— (looking at space)';
    ui.alt.textContent = formatAltitude(globe.cameraHeight()) ?? '—';
  }

  function renderCounts() {
    const s = settings.get();
    const sum = providers.summary();
    ui.lyr.textContent = `${layers.visibleIds().length}/${layers.defs.length}`;
    ui.ent.textContent = String(store.visibleCount());
    ui.srcCount.textContent = `${sum.live} live · ${sum.simulated} sim · ${sum.local} local`;
    ui.feed.textContent = `${sum.live}L ${sum.simulated}S ${sum.local}Lo`;
    ui.feed.title = 'Data sources running: live / simulated / local';
    ui.ref.textContent = sum.intervalMs ? `simulation every ${sum.intervalMs / 1000} s` : 'no polling';
    ui.sync.textContent = sum.lastSync ? `${formatTime(sum.lastSync, s)} (${formatAge(sum.lastSync)})` : 'never';
    renderStatus();
  }

  // ------------------------------------------------------------ performance
  let lastPerf = performance.now();
  function renderPerf() {
    const now = performance.now();
    const frames = globe.takeFrames();
    const fps = Math.round((frames * 1000) / Math.max(1, now - lastPerf));
    lastPerf = now;
    const heap = performance.memory?.usedJSHeapSize;
    const parts = [frames === 0 ? 'idle' : `${fps} fps`];
    if (heap) parts.push(`${Math.round(heap / 1048576)} MB`);
    ui.perf.textContent = parts.join(' · ');
  }

  // ------------------------------------------------------------ wiring
  globe.on('camera', renderCamera);
  globe.on('cursor', (c) => { ui.cur.textContent = c ? formatCoord(c.lon, c.lat, 3) : '—'; });
  globe.on('rendererror', () => { health.rendererError = true; renderStatus(); });
  globe.on('basemaperror', () => {
    const now = Date.now();
    if (now - health.tileErrorAt > 30000) health.tileErrors = 0;
    health.tileErrors += 1;
    health.tileErrorAt = now;
    renderStatus();
  });
  store.on('change', renderCounts);
  providers.on('change', renderCounts);
  settings.on('change', () => { tickClocks(); renderCounts(); });
  window.addEventListener('online', renderStatus);
  window.addEventListener('offline', renderStatus);

  let clockTimer = null;
  let perfTimer = null;
  function startTimers() {
    stopTimers();
    tickClocks(); renderCounts(); renderCamera(); renderPerf();
    clockTimer = setInterval(() => { tickClocks(); renderCounts(); }, 1000);
    perfTimer = setInterval(renderPerf, 3000);
  }
  function stopTimers() { clearInterval(clockTimer); clearInterval(perfTimer); }
  document.addEventListener('visibilitychange', () => { if (document.hidden) stopTimers(); else startTimers(); });
  startTimers();

  return { renderAll() { renderCounts(); renderCamera(); } };
}
