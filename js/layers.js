// layers.js — the layer manager (one Cesium "data source" per layer, with clustering)
// and the left-hand "Data layers" panel.
//
// Why a data source per layer: toggling a layer is then a single `show = false`, the globe keeps
// every other layer untouched, and clustering is applied per layer (aircraft cluster with aircraft only).

import { el, icon, formatTime, formatAge } from './util.js';
import { LAYER_DEFS } from './config.js';
import { clusterIcon } from './markers.js';
import { STATE_LABEL, STATE_CHIP } from './data/provider-manager.js';

const Cesium = window.Cesium;

export function createLayerManager({ viewer, settings, requestRender }) {
  const sources = new Map();

  for (const def of LAYER_DEFS) {
    const ds = new Cesium.CustomDataSource(def.id);
    ds.show = settings.get().visibleLayers[def.id] !== false;
    ds.clustering = new Cesium.EntityCluster({
      enabled: def.cluster,
      pixelRange: 42,
      minimumClusterSize: 3,
      clusterBillboards: true,
      clusterLabels: false,
      clusterPoints: false,
    });
    // Replace Cesium's default cluster look with our own badge showing the count.
    ds.clustering.clusterEvent.addEventListener((clustered, cluster) => {
      cluster.label.show = false;
      cluster.point.show = false;
      cluster.billboard.show = true;
      cluster.billboard.id = clustered;                         // globe.js turns a tap on this into "zoom in"
      cluster.billboard.image = clusterIcon(clustered.length);
      cluster.billboard.width = 34;
      cluster.billboard.height = 34;
      cluster.billboard.verticalOrigin = Cesium.VerticalOrigin.CENTER;
      cluster.billboard.disableDepthTestDistance = 1.0e5;
    });
    viewer.dataSources.add(ds);
    sources.set(def.id, ds);
  }

  // Scratch source: the unsaved map pin lives here (not a user-visible layer, never clustered).
  const scratch = new Cesium.CustomDataSource('scratch');
  viewer.dataSources.add(scratch);

  return {
    defs: LAYER_DEFS,
    def: (id) => LAYER_DEFS.find((d) => d.id === id),
    dataSource: (id) => (id ? sources.get(id) : scratch),
    isVisible: (id) => sources.get(id)?.show ?? false,
    setVisible(id, visible) {
      const ds = sources.get(id);
      if (!ds) return;
      ds.show = visible;
      settings.setLayerVisible(id, visible);
      requestRender();
    },
    visibleIds: () => LAYER_DEFS.filter((d) => sources.get(d.id).show).map((d) => d.id),
  };
}

/** Renders the layer list and keeps counts / feed status / timestamps honest. */
export function mountLayerPanel({ root, layers, store, providers, settings }) {
  const refs = new Map();

  const list = el('ul', { class: 'layer-list' });
  for (const def of layers.defs) {
    const input = el('input', {
      type: 'checkbox', role: 'switch', checked: layers.isVisible(def.id),
      'aria-label': `${def.name} layer visible`,
      onchange: (e) => layers.setVisible(def.id, e.target.checked),
    });
    input.checked = layers.isVisible(def.id);

    const count = el('span', { class: 'layer__count', text: '0', title: 'Entities in this layer' });
    const chip = el('span', { class: 'chip chip--off', text: '…' });
    const updated = el('dd', { text: '—' });
    const source = el('dd', { text: '—' });

    list.append(el('li', { class: 'layer', style: `--layer-color:${def.color}`, dataset: { layer: def.id } },
      el('div', { class: 'layer__head' },
        icon(def.icon, 'icon layer__icon'),
        el('span', { class: 'layer__name', text: def.name }),
        count,
        el('label', { class: 'switch' }, input, el('span', { class: 'switch__ui' }))),
      el('dl', { class: 'layer__meta' },
        el('dt', { text: 'Feed' }), el('dd', {}, chip),
        el('dt', { text: 'Updated' }), updated,
        el('dt', { text: 'Source' }), source)));
    refs.set(def.id, { input, count, chip, updated, source });
  }
  root.replaceChildren(list);

  function render() {
    const s = settings.get();
    const counts = store.countsByLayer();
    for (const def of layers.defs) {
      const r = refs.get(def.id);
      const st = providers.statusOf(def.id);
      r.count.textContent = String(counts.get(def.id) ?? 0);
      r.chip.className = `chip ${STATE_CHIP[st.state]}`;
      r.chip.textContent = STATE_LABEL[st.state];
      r.updated.textContent = st.lastUpdate ? `${formatTime(st.lastUpdate, s)} · ${formatAge(st.lastUpdate)}` : '—';
      r.source.textContent = st.attribution;
      if (r.input.checked !== layers.isVisible(def.id)) r.input.checked = layers.isVisible(def.id);
    }
  }

  render();
  return { render };
}
