// provider-manager.js — the one place that knows which data sources exist and what state they are in.
//
// Plain-English model:
//   * A PROVIDER is a small object that knows how to fetch (or generate) records for ONE layer.
//   * The MANAGER starts/stops providers, and answers "what is the true status of the Aircraft layer?".
//   * Providers never touch the globe. They hand records to a SINK (the entity store),
//     so the globe code is not tied to any one data source.  <- this is what lets us swap in
//     OpenSky, USGS, etc. in Phase 2 without rewriting the UI.
//
// A provider looks like this:
//   {
//     id, layerId, name, kind: 'live' | 'local' | 'simulated',
//     attribution,            // text shown in the layer panel
//     state, lastUpdate, error, running,   // maintained by the provider
//     start(ctx), stop(),     // ctx = { sink, notify }
//     pause?(), resume?(), setIntervalMs?(ms)   // optional
//   }

import { createEmitter } from '../util.js';
import { catalogByLayer } from './provider-catalog.js';

export const STATE = {
  LIVE: 'live',
  SIMULATED: 'simulated',
  LOCAL: 'local',
  STALE: 'stale',
  ERROR: 'error',
  OFF: 'off',
  NOT_CONNECTED: 'not_connected',
  ON_DEMAND: 'on_demand',
  CONNECTING: 'connecting',
};

export const STATE_LABEL = {
  live: 'Live', simulated: 'Simulated', local: 'Local', stale: 'Stale',
  error: 'Error', off: 'Off', not_connected: 'Not connected', on_demand: 'On demand', connecting: 'Connecting',
};

export const STATE_CHIP = {
  live: 'chip--live', simulated: 'chip--sim', local: 'chip--local', stale: 'chip--warn',
  error: 'chip--err', off: 'chip--off', not_connected: 'chip--off', on_demand: 'chip--local', connecting: 'chip--off',
};

const KIND_PRIORITY = { live: 0, local: 1, simulated: 2 };

export function createProviderManager({ sink }) {
  const providers = [];
  const emitter = createEmitter();
  const ctx = { sink, notify: () => emitter.emit('change') };

  function active(layerId) {
    return providers
      .filter((p) => p.layerId === layerId && p.running)
      .sort((a, b) => KIND_PRIORITY[a.kind] - KIND_PRIORITY[b.kind])[0];
  }

  return {
    register(provider) { providers.push(provider); },
    get: (id) => providers.find((p) => p.id === id),
    list: () => [...providers],

    startKind(kind) { providers.filter((p) => p.kind === kind && !p.running).forEach((p) => p.start(ctx)); emitter.emit('change'); },

    /**
     * Make reality match the settings. Safe to call any time.
     *   live        true  -> try to start every live source (a source missing something, e.g. the proxy, stays idle and says why)
     *   simulation  true  -> run simulated stand-ins, but NEVER on a layer where a real source is running:
     *                        real data and fake data must not be mixed on one layer.
     */
    reconcile({ live, simulation }) {
      for (const p of providers.filter((x) => x.kind === 'live')) {
        if (!live) { if (p.running) p.stop(); p.idleReason = null; continue; }
        const missing = p.requires?.() ?? null;          // e.g. no proxy address yet, or the layer is switched off
        if (missing) { if (p.running) p.stop(); p.idleReason = missing; }
        else if (!p.running) p.start(ctx);
      }
      const liveLayers = new Set(providers.filter((x) => x.kind === 'live' && (x.running || x.layerHidden?.())).map((x) => x.layerId));
      for (const p of providers.filter((x) => x.kind === 'simulated')) {
        const want = simulation && !liveLayers.has(p.layerId);
        if (want && !p.running) p.start(ctx);
        else if (!want && p.running) p.stop();
      }
      emitter.emit('change');
    },

    startAll() { providers.filter((p) => !p.running).forEach((p) => p.start(ctx)); emitter.emit('change'); },

    setSimulationInterval(sec) { providers.forEach((p) => p.setIntervalMs?.(sec * 1000)); },
    pauseAll() { providers.forEach((p) => p.running && p.pause?.()); },
    resumeAll() { providers.forEach((p) => p.running && p.resume?.()); },

    /** The honest status of a layer right now. */
    statusOf(layerId) {
      const p = active(layerId);
      if (p) {
        const idle = p.kind !== 'live' ? providers.find((x) => x.kind === 'live' && x.layerId === layerId && x.idleReason) : null;
        const attribution = idle ? `${p.attribution}. Real source idle: ${idle.idleReason}` : p.attribution;
        return { state: p.state, provider: p, source: p.name, attribution, lastUpdate: p.lastUpdate, error: p.error ?? null };
      }
      const desc = catalogByLayer(layerId);
      const idle = providers.find((x) => x.kind === 'live' && x.layerId === layerId && x.idleReason);
      if (idle) {
        return { state: STATE.NOT_CONNECTED, provider: idle, source: idle.name, attribution: idle.idleReason, lastUpdate: null, error: null };
      }
      if (desc?.onDemand) return { state: STATE.ON_DEMAND, provider: null, source: desc.name, attribution: desc.attribution, lastUpdate: null, error: null };
      return {
        state: desc ? STATE.NOT_CONNECTED : STATE.OFF,
        provider: null,
        source: desc ? desc.name : '—',
        attribution: desc ? `Planned source: ${desc.name}. Not connected.` : 'No source',
        lastUpdate: null,
        error: null,
      };
    },

    /** Counts used by the top bar and the telemetry bar. */
    summary() {
      const running = providers.filter((p) => p.running);
      const count = (state) => running.filter((p) => p.state === state).length;
      const times = running.map((p) => p.lastUpdate).filter(Boolean);
      return {
        live: count(STATE.LIVE),
        simulated: count(STATE.SIMULATED),
        local: count(STATE.LOCAL),
        stale: count(STATE.STALE),
        connecting: count(STATE.CONNECTING),
        error: count(STATE.ERROR),
        running: running.length,
        lastSync: times.length ? Math.max(...times) : null,
        intervalMs: running.find((p) => p.kind === 'simulated')?.intervalMs ?? null,
      };
    },

    on: emitter.on,
  };
}
