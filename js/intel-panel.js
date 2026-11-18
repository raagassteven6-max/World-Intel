// intel-panel.js — the right-hand "Entity intelligence" panel.
//
// It changes shape with the selected type. Golden rule: if a source did not supply a field, the row says
// NOT PROVIDED. We never fill gaps with guesses.

import { el, icon, formatCoord, formatAltitude, formatNumber, formatHeading, formatDateTime, formatLat, formatLon } from './util.js';
import { TYPE_LABEL } from './config.js';

const kts = (v) => (v == null ? null : `${formatNumber(v, 0)} kn (${formatNumber(v * 1.852, 0)} km/h)`);
const pos = (r) => formatCoord(r.lon, r.lat);
const when = (ms, s) => formatDateTime(ms, s);

// Each row: [label, (record, settings) => string | null]   (null → "NOT PROVIDED")
const FIELDS = {
  aircraft: [
    ['Callsign', (r) => r.attrs.callsign],
    ['ICAO24', (r) => r.attrs.icao24],
    ['Registration', (r) => r.attrs.registration],
    ['Aircraft type', (r) => r.attrs.aircraftType],
    ['Position', pos],
    ['Altitude', (r) => formatAltitude(r.alt)],
    ['Ground speed', (r) => kts(r.attrs.speedKts)],
    ['Heading', (r) => formatHeading(r.heading)],
    ['Vertical rate', (r) => (r.attrs.vrateMs == null ? null : `${formatNumber(r.attrs.vrateMs, 1)} m/s`)],
    ['Origin', (r) => r.attrs.origin],
    ['Destination', (r) => r.attrs.destination],
    ['Last position', (r, s) => when(r.updatedAt, s)],
    ['Data source', (r) => r.source?.name],
  ],
  ship: [
    ['Vessel name', (r) => r.name],
    ['MMSI', (r) => r.attrs.mmsi],
    ['IMO', (r) => r.attrs.imo],
    ['Vessel type', (r) => r.attrs.shipType],
    ['Position', pos],
    ['Speed', (r) => kts(r.attrs.speedKts)],
    ['Heading', (r) => formatHeading(r.heading)],
    ['Destination', (r) => r.attrs.destination],
    ['Nav status', (r) => r.attrs.navStatus],
    ['Last update', (r, s) => when(r.updatedAt, s)],
    ['Data source', (r) => r.source?.name],
  ],
  satellite: [
    ['Name', (r) => r.name],
    ['NORAD ID', (r) => r.attrs.noradId],
    ['Altitude', (r) => (r.attrs.altitudeKm == null ? null : `${formatNumber(r.attrs.altitudeKm, 0)} km`)],
    ['Velocity', (r) => (r.attrs.velocityKms == null ? null : `${formatNumber(r.attrs.velocityKms, 2)} km/s`)],
    ['Latitude', (r) => formatLat(r.lat)],
    ['Longitude', (r) => formatLon(r.lon)],
    ['Inclination', (r) => (r.attrs.inclinationDeg == null ? null : `${formatNumber(r.attrs.inclinationDeg, 1)}°`)],
    ['Model', (r) => r.attrs.model],
    ['Last calculated', (r, s) => when(r.updatedAt, s)],
    ['Data source', (r) => r.source?.name],
  ],
  earthquake: [
    ['Event type', () => 'Earthquake'],
    ['Magnitude', (r) => (r.attrs.magnitude == null ? null : `M ${formatNumber(r.attrs.magnitude, 1)}`)],
    ['Depth', (r) => (r.attrs.depthKm == null ? null : `${formatNumber(r.attrs.depthKm, 0)} km`)],
    ['Position', pos],
    ['Severity', (r) => r.attrs.severity],
    ['Event time', (r, s) => when(r.observedAt, s)],
    ['Source', (r) => r.source?.name],
  ],
  wildfire: [
    ['Event type', () => 'Wildfire hotspot'],
    ['Position', pos],
    ['Confidence', (r) => r.attrs.confidence],
    ['Fire power', (r) => (r.attrs.frpMw == null ? null : `${formatNumber(r.attrs.frpMw, 0)} MW`)],
    ['Severity', (r) => r.attrs.severity],
    ['Detected', (r, s) => when(r.observedAt, s)],
    ['Source', (r) => r.source?.name],
  ],
  weather: [
    ['Event type', () => 'Weather'],
    ['Condition', (r) => r.attrs.condition],
    ['Position', pos],
    ['Wind', (r) => (r.attrs.windKph == null ? null : `${formatNumber(r.attrs.windKph, 0)} km/h`)],
    ['Severity', (r) => r.attrs.severity],
    ['Observed', (r, s) => when(r.observedAt, s)],
    ['Source', (r) => r.source?.name],
  ],
  camera: [
    ['Name', (r) => r.name],
    ['Camera type', (r) => r.attrs.cameraType],
    ['Position', pos],
    ['Feed', (r) => r.attrs.availability],
    ['Last verified', (r, s) => when(r.attrs.lastVerified, s)],
    ['Source', (r) => r.source?.name],
  ],
  location: [
    ['Name', (r) => r.name],
    ['Position', pos],
    ['Saved', (r, s) => when(r.attrs.savedAt, s)],
    ['Stored', () => 'This browser only'],
  ],
  pin: [
    ['Position', pos],
    ['Status', () => 'Not saved'],
  ],
};

export function createIntelPanel({ root, store, tracker, globe, settings, locations, toast, onOpen }) {
  let selectedId = null;
  let valueNodes = [];
  let buttons = {};

  const sourceBanner = (rec) => {
    const kind = rec.source?.kind;
    if (kind === 'simulated') return el('div', { class: 'intel__banner intel__banner--sim', role: 'note' }, icon('i-warn'), el('span', { text: 'SIMULATED — not real-world data.' }));
    if (kind === 'local') return el('div', { class: 'intel__banner intel__banner--local', role: 'note' }, icon('i-pin'), el('span', { text: 'Your own data, saved in this browser.' }));
    if (kind === 'live') return el('div', { class: 'intel__banner intel__banner--live', role: 'note' }, icon('i-link'), el('span', { text: `Live data: ${rec.source.name}` }));
    return null;
  };

  function showEmpty() {
    selectedId = null; valueNodes = []; buttons = {};
    root.replaceChildren(el('div', { class: 'intel__empty' },
      el('p', { class: 'note', text: 'Nothing selected. Tap a marker to read its details, or tap empty globe to select a point.' })));
  }

  function renderValues() {
    const rec = store.get(selectedId);
    if (!rec) return;
    const s = settings.get();
    for (const { dd, fn } of valueNodes) {
      let value = null;
      try { value = fn(rec, s); } catch { value = null; }
      if (value === null || value === undefined || value === '') {
        dd.textContent = 'NOT PROVIDED';
        dd.dataset.missing = 'true';
      } else {
        dd.textContent = String(value);
        delete dd.dataset.missing;
      }
    }
  }

  function refreshButtons() {
    const rec = store.get(selectedId);
    if (!rec) return;
    // Not every type has every button (a selected map point can't be tracked; an earthquake has no path).
    if (buttons.track) {
      const isTracked = tracker.isTracked(rec.id);
      buttons.track.setAttribute('aria-pressed', String(isTracked));
      buttons.track.querySelector('span').textContent = isTracked ? 'Tracked' : 'Track';
      buttons.follow.hidden = !isTracked;
      buttons.follow.setAttribute('aria-pressed', String(tracker.isFollowing(rec.id)));
      buttons.follow.querySelector('span').textContent = tracker.isFollowing(rec.id) ? 'Following' : 'Follow';
    }
    if (buttons.path) {
      const canPath = tracker.canShowPath(rec.id) || tracker.hasPath(rec.id);
      buttons.path.hidden = !canPath;
      buttons.path.setAttribute('aria-pressed', String(tracker.hasPath(rec.id)));
    }
    if (buttons.pathNote) buttons.pathNote.hidden = !tracker.hasPath(rec.id);
  }

  function btn(label, iconId, onclick, extra = {}) {
    return el('button', { type: 'button', class: 'btn', onclick, ...extra }, icon(iconId), el('span', { text: label }));
  }

  function render(id) {
    const rec = store.get(id);
    if (!rec) { showEmpty(); return; }
    selectedId = id;
    buttons = {};
    valueNodes = [];

    const rows = (FIELDS[rec.type] ?? FIELDS.pin).map(([label, fn]) => {
      const dd = el('dd', { text: '' });
      valueNodes.push({ dd, fn });
      return [el('dt', { text: label }), dd];
    });

    const parts = [
      sourceBanner(rec),
      el('div', { class: 'intel__title' },
        el('div', { class: 'intel__type', text: TYPE_LABEL[rec.type] ?? 'Entity' }),
        el('h3', { class: 'intel__name', text: rec.type === 'pin' ? 'Selected point' : rec.name })),
      el('dl', { class: 'kv' }, rows.flat()),
    ];

    const actions = el('div', { class: 'intel__actions' });
    if (rec.type !== 'pin') {
      buttons.track = btn('Track', 'i-target', () => { tracker.toggle(rec.id); }, { 'aria-pressed': 'false' });
      buttons.follow = btn('Follow', 'i-follow', () => { tracker.follow(tracker.isFollowing(rec.id) ? null : rec.id); }, { hidden: true, 'aria-pressed': 'false' });
      actions.append(buttons.track, buttons.follow);
    }
    actions.append(btn('Center camera', 'i-center', () => globe.flyToRecord(store.get(rec.id) ?? rec)));
    if (rec.keepHistory) {
      buttons.path = btn('Show path', 'i-path', () => { tracker.togglePath(rec.id); }, { hidden: true, 'aria-pressed': 'false' });
      actions.append(buttons.path);
    }
    if (rec.type === 'camera') {
      const url = rec.attrs.feedUrl;
      if (url && /^https:\/\//i.test(url)) {
        actions.append(el('a', { class: 'btn', href: url, target: '_blank', rel: 'noopener noreferrer' }, icon('i-link'), el('span', { text: 'Open feed' })));
      } else {
        actions.append(el('button', { type: 'button', class: 'btn', disabled: true, 'aria-disabled': 'true' }, icon('i-link'), el('span', { text: 'No feed available' })));
      }
    }
    if (rec.type === 'location') {
      actions.append(btn('Delete', 'i-trash', () => { locations.remove(rec.id); globe.select(null); toast('Location deleted.'); }, { class: 'btn btn--danger' }));
    }
    actions.append(btn('Clear', 'i-close', () => globe.select(null)));
    parts.push(actions);

    if (rec.keepHistory) {
      buttons.pathNote = el('p', { class: 'note intel__pathnote', hidden: true, text: 'Path shows OBSERVED positions only — points this session received from the source. Nothing is interpolated.' });
      parts.push(buttons.pathNote);
    }

    if (rec.type === 'pin') {
      const input = el('input', { class: 'field', id: 'save-name', type: 'text', maxlength: '60', placeholder: 'e.g. Cebu office', autocomplete: 'off' });
      const save = () => {
        const res = locations.add({ name: input.value, lon: rec.lon, lat: rec.lat });
        if (!res.ok) { toast(res.reason, 'warn'); return; }
        globe.select(null);
        store.remove('pin');
        globe.select(res.id);
        toast(res.stored === false ? 'Saved for this session only (browser storage unavailable).' : 'Location saved.', res.stored === false ? 'warn' : undefined);
      };
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); save(); } });
      parts.push(el('div', { class: 'intel__save' },
        el('label', { for: 'save-name', text: 'Save this point as' }),
        input,
        btn('Save location', 'i-save', save, { class: 'btn btn--primary' })));
    }

    root.replaceChildren(...parts.filter(Boolean));
    renderValues();
    refreshButtons();
  }

  globe.on('select', (id) => {
    if (id) { render(id); onOpen?.(); } else showEmpty();
  });
  store.on('change', () => {
    if (!selectedId) return;
    if (!store.get(selectedId)) { showEmpty(); return; }
    renderValues();
    refreshButtons();
  });
  tracker.on('change', refreshButtons);
  settings.on('change', renderValues);

  showEmpty();
  return { render, showEmpty };
}
