// globe.js — everything that talks to CesiumJS directly for the view itself:
// creating the viewer, basemap, camera moves, picking (taps/clicks), coordinates.
// Other modules ask the globe to do things; they don't poke Cesium's viewer for camera work.
//
// Performance choices for phones:
//  * requestRenderMode: the GPU draws only when something changed (camera moved, data updated),
//    not 60 times a second while you read a panel. Any code that changes the scene calls requestRender().
//  * msaaSamples 1 and "browser recommended resolution": cheaper on mobile GPUs.

import { createEmitter, deg, frameThrottle } from './util.js';
import { BASEMAPS, FLY_HEIGHT } from './config.js';

const Cesium = window.Cesium;

export function createGlobe({ container, settings }) {
  const emitter = createEmitter();

  // We use no Cesium ion assets, so make sure nothing ever tries to use an ion token.
  Cesium.Ion.defaultAccessToken = '';

  const viewer = new Cesium.Viewer(container, {
    baseLayer: false,                 // we add the basemap ourselves (see setBasemap)
    baseLayerPicker: false,
    geocoder: false,                  // we have our own search box
    homeButton: false,                // we have our own Home button (uses YOUR default view)
    sceneModePicker: false,
    navigationHelpButton: false,
    fullscreenButton: false,          // our top bar has one
    animation: false,
    timeline: false,
    infoBox: false,                   // our right-hand panel replaces it
    selectionIndicator: true,
    scene3DOnly: true,
    shouldAnimate: false,
    requestRenderMode: true,
    maximumRenderTimeChange: Number.POSITIVE_INFINITY,
    msaaSamples: 1,
  });

  const scene = viewer.scene;
  const camera = viewer.camera;
  scene.backgroundColor = Cesium.Color.fromCssColorString('#05090f');
  scene.globe.baseColor = Cesium.Color.fromCssColorString('#0a1624');
  scene.screenSpaceCameraController.minimumZoomDistance = 1000;
  camera.percentageChanged = 0.02;

  // Cesium's default "double-click to lock camera onto entity" would trap touch users. We offer Follow instead.
  viewer.screenSpaceEventHandler.removeInputAction(Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK);

  const requestRender = () => scene.requestRender();

  // ------------------------------------------------------------------ basemap
  let basemapToken = 0;
  let currentBasemapKey = null;

  const makeProvider = {
    osm: async () => new Cesium.UrlTemplateImageryProvider({
      url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
      maximumLevel: 19,
      credit: new Cesium.Credit(BASEMAPS.osm.credit, true),   // true = show on screen (OSM licence requires visible attribution)
    }),
    natural: async () => Cesium.TileMapServiceImageryProvider.fromUrl(
      Cesium.buildModuleUrl('Assets/Textures/NaturalEarthII'),
      { credit: new Cesium.Credit(BASEMAPS.natural.credit, true) },
    ),
  };

  function applyDim(layer, dim) {
    layer.brightness = dim ? 0.55 : 1;
    layer.contrast = dim ? 1.15 : 1;
    layer.saturation = dim ? 0.7 : 1;
  }

  async function setBasemap(key, dim) {
    const token = ++basemapToken;
    let provider;
    try {
      provider = await (makeProvider[key] ?? makeProvider.osm)();
    } catch (error) {
      emitter.emit('basemapfail', { key, error });
      if (key !== 'osm') return setBasemap('osm', dim);
      return undefined;
    }
    if (token !== basemapToken) return undefined;           // a newer request superseded this one
    provider.errorEvent?.addEventListener((err) => emitter.emit('basemaperror', err));
    const layers = viewer.imageryLayers;
    const layer = layers.addImageryProvider(provider);
    const old = [];
    for (let i = 0; i < layers.length; i += 1) if (layers.get(i) !== layer) old.push(layers.get(i));
    old.forEach((l) => layers.remove(l, true));
    applyDim(layer, dim);
    currentBasemapKey = key;
    requestRender();
    return layer;
  }

  function setDim(dim) {
    const layers = viewer.imageryLayers;
    for (let i = 0; i < layers.length; i += 1) applyDim(layers.get(i), dim);
    requestRender();
  }

  // ------------------------------------------------------------------ rendering preferences
  function applyRenderSettings(s) {
    scene.globe.enableLighting = s.lighting;
    scene.globe.showGroundAtmosphere = s.atmosphere;
    if (scene.skyAtmosphere) scene.skyAtmosphere.show = s.atmosphere;
    scene.light = s.lighting ? new Cesium.SunLight() : new Cesium.DirectionalLight({ direction: new Cesium.Cartesian3(1, 0, -0.3) });
    if ('useBrowserRecommendedResolution' in viewer) viewer.useBrowserRecommendedResolution = s.resolution !== 'high';
    viewer.resolutionScale = s.resolution === 'battery' ? 0.75 : 1;
    requestRender();
  }

  function syncSunToNow() {
    viewer.clock.currentTime = Cesium.JulianDate.now();
    requestRender();
  }
  syncSunToNow();
  setInterval(() => { if (!document.hidden) syncSunToNow(); }, 60000);   // keep day/night roughly right

  // ------------------------------------------------------------------ camera helpers
  function flyTo({ lon, lat, height }, { duration = 1.6 } = {}) {
    camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(lon, lat, height),
      orientation: { heading: 0, pitch: -Cesium.Math.PI_OVER_TWO, roll: 0 },
      duration,
    });
  }

  function flyToDefault() {
    flyTo(settings.get().defaultView);
  }

  function flyToRecord(rec) {
    flyTo({ lon: rec.lon, lat: rec.lat, height: FLY_HEIGHT[rec.type] ?? 800000 });
  }

  function flyToRectangle(west, south, east, north) {
    const pad = 0.05;                                         // never zoom in absurdly far on a single point
    const w = Math.min(west, east - pad); const e = Math.max(east, west + pad);
    const s = Math.min(south, north - pad); const n = Math.max(north, south + pad);
    camera.flyTo({ destination: Cesium.Rectangle.fromDegrees(w, s, e, n), duration: 1.6 });
  }

  function resetNorth() {
    const c = camera.positionCartographic;
    camera.flyTo({
      destination: Cesium.Cartesian3.fromRadians(c.longitude, c.latitude, c.height),
      orientation: { heading: 0, pitch: camera.pitch, roll: 0 },
      duration: 0.6,
    });
  }

  function currentView() {
    const c = camera.positionCartographic;
    if (!c) return null;
    return { lon: deg(c.longitude), lat: deg(c.latitude), height: Math.max(200, Math.round(c.height)) };
  }

  function cameraHeight() { return camera.positionCartographic?.height ?? null; }

  /** lat/lon of the point under the middle of the screen, or null when looking at empty space. */
  function centerCoordinates() {
    const canvas = scene.canvas;
    const cart = camera.pickEllipsoid(new Cesium.Cartesian2(canvas.clientWidth / 2, canvas.clientHeight / 2), scene.globe.ellipsoid);
    if (!cart) return null;
    const c = Cesium.Cartographic.fromCartesian(cart);
    return { lon: deg(c.longitude), lat: deg(c.latitude) };
  }

  // ------------------------------------------------------------------ selection + picking
  const select = (idOrNull) => {
    if (!idOrNull) { viewer.selectedEntity = undefined; return; }
    const ent = findEntity(idOrNull);
    if (ent) viewer.selectedEntity = ent;
  };

  function findEntity(id) {
    const fromScratch = viewer.entities.getById(id);
    if (fromScratch) return fromScratch;
    for (let i = 0; i < viewer.dataSources.length; i += 1) {
      const e = viewer.dataSources.get(i).entities.getById(id);
      if (e) return e;
    }
    return undefined;
  }

  viewer.selectedEntityChanged.addEventListener((ent) => {
    emitter.emit('select', ent ? ent.id : null);
    requestRender();
  });

  function zoomToCluster(entities) {
    const time = viewer.clock.currentTime;
    const points = entities.map((e) => e.position?.getValue(time)).filter(Boolean);
    if (!points.length) return;
    const sphere = Cesium.BoundingSphere.fromPoints(points);
    camera.flyToBoundingSphere(sphere, {
      duration: 0.9,
      offset: new Cesium.HeadingPitchRange(0, -Cesium.Math.PI_OVER_TWO, Math.max(sphere.radius * 3, 400000)),
    });
  }

  const handler = new Cesium.ScreenSpaceEventHandler(scene.canvas);
  handler.setInputAction((click) => {
    const picked = scene.pick(click.position);
    if (Cesium.defined(picked)) {
      const id = picked.id;
      if (Array.isArray(id)) { zoomToCluster(id); return; }          // a cluster badge: zoom into it
      if (id instanceof Cesium.Entity) { viewer.selectedEntity = id; return; }
    }
    const cart = camera.pickEllipsoid(click.position, scene.globe.ellipsoid);
    if (cart) {                                                      // empty globe: report the tapped point
      const c = Cesium.Cartographic.fromCartesian(cart);
      emitter.emit('locationpick', { lon: deg(c.longitude), lat: deg(c.latitude) });
    } else {
      viewer.selectedEntity = undefined;                             // tapped space
    }
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

  const emitCursor = frameThrottle((pos) => {
    const cart = camera.pickEllipsoid(pos, scene.globe.ellipsoid);
    if (!cart) { emitter.emit('cursor', null); return; }
    const c = Cesium.Cartographic.fromCartesian(cart);
    emitter.emit('cursor', { lon: deg(c.longitude), lat: deg(c.latitude) });
  });
  handler.setInputAction((move) => emitCursor(move.endPosition), Cesium.ScreenSpaceEventType.MOUSE_MOVE);

  // ------------------------------------------------------------------ events out
  const emitCamera = frameThrottle(() => emitter.emit('camera'));
  camera.changed.addEventListener(emitCamera);
  camera.moveEnd.addEventListener(emitCamera);

  scene.renderError.addEventListener((_scene, error) => emitter.emit('rendererror', error));

  // Count real frames for the telemetry bar (with on-demand rendering this is 0 when idle — that's correct).
  let frames = 0;
  scene.postRender.addEventListener(() => { frames += 1; });
  const takeFrames = () => { const n = frames; frames = 0; return n; };

  // ------------------------------------------------------------------ first-time setup
  applyRenderSettings(settings.get());
  setBasemap(settings.get().basemap, settings.get().dimBasemap);
  camera.setView({
    destination: Cesium.Cartesian3.fromDegrees(
      settings.get().defaultView.lon, settings.get().defaultView.lat, settings.get().defaultView.height,
    ),
  });

  return {
    viewer, scene, camera, on: emitter.on,
    requestRender, setBasemap, setDim, applyRenderSettings,
    flyTo, flyToDefault, flyToRecord, flyToRectangle, resetNorth,
    currentView, cameraHeight, centerCoordinates,
    select, findEntity, takeFrames,
    get basemapKey() { return currentBasemapKey; },
  };
}
