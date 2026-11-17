// config.js — the fixed facts about the app: which layers exist and how they look.
// To add a layer later, add one entry here and (in Phase 2+) register a provider for it.

export const LAYER_DEFS = [
  { id: 'aircraft',    name: 'Aircraft',     icon: 'i-plane',   color: '#38d6f5', cluster: true,  rotates: true  },
  { id: 'ships',       name: 'Ships',        icon: 'i-ship',    color: '#2dd4bf', cluster: true,  rotates: true  },
  { id: 'satellites',  name: 'Satellites',   icon: 'i-sat',     color: '#e2e8f0', cluster: true,  rotates: false },
  { id: 'earthquakes', name: 'Earthquakes',  icon: 'i-quake',   color: '#ff6b6b', cluster: true,  rotates: false },
  { id: 'wildfires',   name: 'Wildfires',    icon: 'i-fire',    color: '#ff9a3d', cluster: true,  rotates: false },
  { id: 'weather',     name: 'Weather',      icon: 'i-cloud',   color: '#7ab8ff', cluster: true,  rotates: false },
  { id: 'locations',   name: 'My locations', icon: 'i-pin',     color: '#f5b83d', cluster: false, rotates: false },
  { id: 'cameras',     name: 'Cameras',      icon: 'i-camera',  color: '#b4e33d', cluster: true,  rotates: false },
];

/** Entity types (what a record IS) → marker colour. Layers and types are 1:1 here, plus the unsaved map pin. */
export const TYPE_STYLE = {
  aircraft:   { color: '#38d6f5', size: 26 },
  ship:       { color: '#2dd4bf', size: 26 },
  satellite:  { color: '#e2e8f0', size: 28 },
  earthquake: { color: '#ff6b6b', size: 28 },
  wildfire:   { color: '#ff9a3d', size: 26 },
  weather:    { color: '#7ab8ff', size: 30 },
  location:   { color: '#f5b83d', size: 26 },
  camera:     { color: '#b4e33d', size: 24 },
  pin:        { color: '#f5b83d', size: 30 },
};

/** Human names for the "TYPE" line in the intelligence panel. */
export const TYPE_LABEL = {
  aircraft: 'Aircraft', ship: 'Vessel', satellite: 'Satellite', earthquake: 'Earthquake',
  wildfire: 'Wildfire', weather: 'Weather event', location: 'Saved location',
  camera: 'Camera', pin: 'Selected point',
};

/** How close the camera flies when you press "Center camera" (metres above ground). */
export const FLY_HEIGHT = {
  aircraft: 600000, ship: 300000, satellite: 6000000, earthquake: 900000,
  wildfire: 400000, weather: 1500000, location: 300000, camera: 40000, pin: 800000,
};

export const BASEMAPS = {
  osm:     { label: 'OpenStreetMap streets', credit: '© OpenStreetMap contributors' },
  natural: { label: 'Natural Earth II (bundled)', credit: 'Natural Earth / Cesium' },
};

export const REFRESH_CHOICES = [1, 2, 5, 10];
