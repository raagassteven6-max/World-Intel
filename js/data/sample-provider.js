// sample-provider.js — SIMULATED data for testing the globe (Phase 1 only).
//
// Everything produced here is fake on purpose:
//   * every name starts with "SIM",
//   * every record carries source.kind = 'simulated',
//   * the UI shows an amber "SIMULATED" banner and a dashed ring on the marker.
// Fields we cannot honestly supply (ICAO24, MMSI, NORAD id, origin, destination…) are left null,
// and the panel shows "NOT PROVIDED" instead of inventing something.

import { destination, normLon, rad, deg, clamp } from '../util.js';
import { STATE } from './provider-manager.js';

/** Small seeded random generator: the same sample scene every load (easier to test). */
function mulberry32(seed) {
  let a = seed;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const KTS_TO_MS = 0.514444;

/**
 * Factory for one simulated layer.
 * build(now)            → initial records
 * step(records, dt, now) → (optional) mutate records in place; return the ones that changed
 */
function createSimProvider({ layerId, name, build, step }) {
  const id = `sim-${layerId}`;
  const source = { id, name: 'Simulation (generated in this browser)', kind: 'simulated' };
  let ctx = null;
  let timer = null;
  let records = [];
  let lastTick = 0;

  function tick() {
    if (!step || !ctx) return;
    const now = Date.now();
    const dt = clamp((now - lastTick) / 1000, 0, 120);   // never jump more than 2 minutes after a pause
    lastTick = now;
    const changed = step(records, dt, now);
    if (changed?.length) ctx.sink.upsertMany(changed);
    provider.lastUpdate = now;
    ctx.notify();
  }

  function schedule() {
    clearInterval(timer);
    timer = null;
    if (step && provider.running) timer = setInterval(tick, provider.intervalMs);
  }

  const provider = {
    id, layerId, name, kind: 'simulated',
    attribution: 'Simulation — not real data',
    state: STATE.OFF, lastUpdate: null, error: null, running: false, intervalMs: 2000,

    start(c) {
      ctx = c;
      const now = Date.now();
      records = build(now).map((r) => ({ ...r, source }));
      provider.running = true;
      provider.state = STATE.SIMULATED;
      ctx.sink.upsertMany(records);
      provider.lastUpdate = now;
      lastTick = now;
      schedule();
      ctx.notify();
    },
    stop() {
      clearInterval(timer); timer = null;
      provider.running = false;
      provider.state = STATE.OFF;
      ctx?.sink.removeBySource(id);
      records = [];
      provider.lastUpdate = null;
      ctx?.notify();
    },
    pause() { clearInterval(timer); timer = null; },
    resume() { if (provider.running) { lastTick = Date.now(); tick(); schedule(); } },
    setIntervalMs(ms) { provider.intervalMs = ms; schedule(); },
  };
  return provider;
}

// ---------------------------------------------------------------- aircraft
const AIRCRAFT_SEEDS = [
  { lat: 14.6, lon: 121.1, hdg: 20,  kts: 440, alt: 10700 },   // near Manila
  { lat: 10.4, lon: 123.9, hdg: 200, kts: 380, alt: 9100 },    // near Cebu
  { lat: 22.3, lon: 114.2, hdg: 95,  kts: 470, alt: 11300 },
  { lat: 1.4,  lon: 103.9, hdg: 330, kts: 430, alt: 10000 },
  { lat: 35.6, lon: 139.7, hdg: 60,  kts: 480, alt: 11900 },
  { lat: -33.9, lon: 151.2, hdg: 170, kts: 450, alt: 10400 },
  { lat: 51.5, lon: -0.4,  hdg: 280, kts: 460, alt: 11000 },
  { lat: 33.9, lon: -118.4, hdg: 100, kts: 420, alt: 9700 },
];

function aircraftProvider() {
  return createSimProvider({
    layerId: 'aircraft', name: 'Simulated aircraft',
    build: (now) => AIRCRAFT_SEEDS.map((s, i) => ({
      id: `sim:aircraft:${i + 1}`, layerId: 'aircraft', type: 'aircraft',
      name: `SIM-AIR-${String(i + 1).padStart(2, '0')}`,
      lon: s.lon, lat: s.lat, alt: s.alt, heading: s.hdg,
      keepHistory: true, updatedAt: now, observedAt: now,
      attrs: { callsign: `SIMAIR${String(i + 1).padStart(2, '0')}`, icao24: null, speedKts: s.kts, vrateMs: 0, origin: null, destination: null },
    })),
    step(records, dt, now) {
      return records.map((r) => {
        const p = destination(r.lon, r.lat, r.heading, r.attrs.speedKts * KTS_TO_MS * dt);
        r.lon = p.lon; r.lat = p.lat; r.updatedAt = now; r.observedAt = now;
        return r;
      });
    },
  });
}

// ---------------------------------------------------------------- ships
const SHIP_SEEDS = [
  { lat: 13.2, lon: 124.5, hdg: 300, kts: 14, type: 'Cargo' },       // Philippine Sea
  { lat: 15.8, lon: 116.9, hdg: 20,  kts: 11, type: 'Tanker' },      // South China Sea
  { lat: 1.2,  lon: 103.7, hdg: 85,  kts: 9,  type: 'Container ship' },
  { lat: 50.2, lon: 0.5,   hdg: 60,  kts: 15, type: 'Cargo' },       // English Channel
  { lat: 8.9,  lon: -79.6, hdg: 200, kts: 10, type: 'Tanker' },      // Panama approach
  { lat: 34.5, lon: 135.0, hdg: 250, kts: 12, type: 'Passenger' },
];

function shipProvider() {
  return createSimProvider({
    layerId: 'ships', name: 'Simulated vessels',
    build: (now) => SHIP_SEEDS.map((s, i) => ({
      id: `sim:ship:${i + 1}`, layerId: 'ships', type: 'ship',
      name: `SIM-VESSEL-${i + 1}`,
      lon: s.lon, lat: s.lat, alt: 0, heading: s.hdg,
      keepHistory: true, updatedAt: now, observedAt: now,
      attrs: { mmsi: null, imo: null, shipType: s.type, speedKts: s.kts, destination: null, navStatus: 'Under way (simulated)' },
    })),
    step(records, dt, now) {
      return records.map((r) => {
        const p = destination(r.lon, r.lat, r.heading, r.attrs.speedKts * KTS_TO_MS * dt);
        r.lon = p.lon; r.lat = p.lat; r.updatedAt = now; r.observedAt = now;
        return r;
      });
    },
  });
}

// ---------------------------------------------------------------- satellites
// A perfectly circular orbit, calculated with textbook formulas. It looks like a satellite
// but it is NOT a real one (no real orbital elements), so there is no NORAD id.
const MU = 3.986004418e14;          // Earth's gravitational parameter, m^3/s^2
const R_E = 6378137;                // Earth radius, m
const W_E = 7.2921159e-5;           // Earth rotation, rad/s

const SAT_SEEDS = [
  { altKm: 420, inclDeg: 51.6, phase: 0.2, lon0: 100 },
  { altKm: 550, inclDeg: 53.0, phase: 2.0, lon0: -40 },
  { altKm: 700, inclDeg: 98.2, phase: 4.1, lon0: 20 },
  { altKm: 800, inclDeg: 98.6, phase: 1.1, lon0: 150 },
  { altKm: 600, inclDeg: 28.5, phase: 3.3, lon0: -100 },
  { altKm: 1200, inclDeg: 87.0, phase: 5.2, lon0: 60 },
];

function satelliteProvider() {
  const params = SAT_SEEDS.map((s) => {
    const a = R_E + s.altKm * 1000;
    return { ...s, a, n: Math.sqrt(MU / a ** 3), i: rad(s.inclDeg), t0: 0 };
  });
  const position = (p, nowMs) => {
    const t = (nowMs - p.t0) / 1000;
    const u = p.phase + p.n * t;                       // angle along the orbit
    const lat = deg(Math.asin(Math.sin(p.i) * Math.sin(u)));
    const lonInertial = Math.atan2(Math.cos(p.i) * Math.sin(u), Math.cos(u));
    return { lat, lon: normLon(p.lon0 + deg(lonInertial - W_E * t)) };
  };
  return createSimProvider({
    layerId: 'satellites', name: 'Simulated satellites',
    build: (now) => params.map((p, i) => {
      p.t0 = now;
      const pos = position(p, now);
      return {
        id: `sim:sat:${i + 1}`, layerId: 'satellites', type: 'satellite',
        name: `SIM-SAT-${i + 1}`,
        lon: pos.lon, lat: pos.lat, alt: p.altKm * 1000, heading: null,
        keepHistory: true, updatedAt: now, observedAt: now,
        attrs: {
          noradId: null, inclinationDeg: SAT_SEEDS[i].inclDeg, altitudeKm: p.altKm,
          velocityKms: Math.sqrt(MU / p.a) / 1000,
          model: 'Circular-orbit simulation (not a real satellite)',
        },
      };
    }),
    step(records, dt, now) {
      return records.map((r, i) => {
        const pos = position(params[i], now);
        r.lon = pos.lon; r.lat = pos.lat; r.updatedAt = now; r.observedAt = now;
        return r;
      });
    },
  });
}

// ---------------------------------------------------------------- earthquakes (static)
const QUAKE_SEEDS = [
  { lat: 10.2, lon: 126.8, mag: 5.4, depthKm: 38,  place: 'Philippine Sea',   hoursAgo: 2 },
  { lat: 38.3, lon: 142.4, mag: 6.1, depthKm: 24,  place: 'off east Japan',   hoursAgo: 9 },
  { lat: -20.5, lon: -70.2, mag: 4.9, depthKm: 55, place: 'northern Chile',   hoursAgo: 5 },
  { lat: -6.5, lon: 129.9, mag: 5.8, depthKm: 110, place: 'Banda Sea',        hoursAgo: 14 },
  { lat: 59.8, lon: -153.0, mag: 4.6, depthKm: 90, place: 'southern Alaska',  hoursAgo: 1 },
  { lat: -38.2, lon: 176.4, mag: 5.1, depthKm: 12, place: 'North Island, NZ', hoursAgo: 20 },
];

function earthquakeProvider() {
  return createSimProvider({
    layerId: 'earthquakes', name: 'Simulated earthquakes',
    build: (now) => QUAKE_SEEDS.map((q, i) => ({
      id: `sim:quake:${i + 1}`, layerId: 'earthquakes', type: 'earthquake',
      name: `SIM M${q.mag.toFixed(1)} — ${q.place}`,
      lon: q.lon, lat: q.lat, alt: 0, heading: null,
      updatedAt: now, observedAt: now - q.hoursAgo * 3600e3,
      attrs: { magnitude: q.mag, depthKm: q.depthKm, severity: q.mag >= 6 ? 'Strong' : q.mag >= 5 ? 'Moderate' : 'Light' },
    })),
  });
}

// ---------------------------------------------------------------- wildfires (static)
const FIRE_SEEDS = [
  { lat: 39.8, lon: -121.4, frp: 85,  conf: 'High',    place: 'northern California' },
  { lat: -31.6, lon: 149.3, frp: 40,  conf: 'Nominal', place: 'New South Wales' },
  { lat: -9.8, lon: -55.1, frp: 120,  conf: 'High',    place: 'Mato Grosso' },
  { lat: 61.4, lon: 104.0, frp: 30,   conf: 'Low',     place: 'central Siberia' },
];

function wildfireProvider() {
  return createSimProvider({
    layerId: 'wildfires', name: 'Simulated wildfires',
    build: (now) => FIRE_SEEDS.map((f, i) => ({
      id: `sim:fire:${i + 1}`, layerId: 'wildfires', type: 'wildfire',
      name: `SIM hotspot — ${f.place}`,
      lon: f.lon, lat: f.lat, alt: 0, heading: null,
      updatedAt: now, observedAt: now - (i + 1) * 5400e3,
      attrs: { confidence: f.conf, frpMw: f.frp, severity: null },
    })),
  });
}

// ---------------------------------------------------------------- weather (static)
const WEATHER_SEEDS = [
  { lat: 17.0, lon: 131.0, windKph: 120, cond: 'Simulated tropical cyclone', place: 'Philippine Sea' },
  { lat: 45.0, lon: -40.0, windKph: 85,  cond: 'Simulated storm system',     place: 'North Atlantic' },
  { lat: -15.0, lon: 70.0, windKph: 95,  cond: 'Simulated tropical cyclone', place: 'Indian Ocean' },
];

function weatherProvider() {
  return createSimProvider({
    layerId: 'weather', name: 'Simulated weather',
    build: (now) => WEATHER_SEEDS.map((w, i) => ({
      id: `sim:weather:${i + 1}`, layerId: 'weather', type: 'weather',
      name: `SIM weather — ${w.place}`,
      lon: w.lon, lat: w.lat, alt: 0, heading: null,
      updatedAt: now, observedAt: now,
      attrs: { condition: w.cond, windKph: w.windKph, severity: w.windKph >= 118 ? 'Severe' : 'Moderate' },
    })),
  });
}

// ---------------------------------------------------------------- cameras (static, deliberately no feed)
const CAMERA_SEEDS = [
  { lat: 14.55, lon: 120.98, place: 'Manila Bay', kind: 'Harbour view' },
  { lat: 10.31, lon: 123.89, place: 'Cebu City',  kind: 'Traffic' },
  { lat: 35.66, lon: 139.74, place: 'Tokyo Bay',  kind: 'Skyline' },
];

function cameraProvider() {
  return createSimProvider({
    layerId: 'cameras', name: 'Simulated cameras',
    build: (now) => CAMERA_SEEDS.map((c, i) => ({
      id: `sim:camera:${i + 1}`, layerId: 'cameras', type: 'camera',
      name: `SIM-CAM-${i + 1} — ${c.place}`,
      lon: c.lon, lat: c.lat, alt: 0, heading: null,
      updatedAt: now, observedAt: now,
      attrs: { cameraType: c.kind, feedUrl: null, availability: 'No feed configured', lastVerified: null },
    })),
  });
}

/** All simulated providers, in layer order. */
export function createSimulatedProviders() {
  return [
    aircraftProvider(), shipProvider(), satelliteProvider(), earthquakeProvider(),
    wildfireProvider(), weatherProvider(), cameraProvider(),
  ];
}
