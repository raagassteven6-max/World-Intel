# God's Eye Control

An interactive 3D geospatial observation console that runs entirely in the browser: a CesiumJS globe, switchable data layers, an entity-intelligence panel, tracking, search, and a live telemetry bar. Built with plain HTML, CSS and JavaScript, so it deploys to **GitHub Pages** with no build step, and it is designed to be developed from a phone.

> **Status: Phase 3 — more real data.** Earthquakes (USGS) and weather points (Open-Meteo) are live with no setup. Aircraft, satellites, ships and wildfires go live through your own small data proxy (see [Optional data proxy](#optional-data-proxy)); ships and wildfires also need free API keys stored as proxy secrets. Anything not connected shows amber *simulated* sample data, clearly labelled. Cameras are not connected yet. See the [roadmap](#roadmap).

---

## The one rule: it never pretends

Every layer shows its true feed state, and the system status in the top bar is computed from facts, not hard-coded.

| Label | Meaning |
|---|---|
| **Live** (green) | A real feed is connected and delivering recent data. |
| **Connecting** | A real feed has started but has not delivered anything yet. |
| **Simulated** (amber) | Fake sample data for testing. Names start with `SIM`, markers have a dashed amber ring, and the details panel carries a banner. |
| **Local** (cyan) | Your own data, saved in this browser only. |
| **Not connected** (grey) | A real source is planned but not wired up. No data is shown for it. |
| **Stale** (amber) | The latest refresh failed; the last good data is still shown, labelled as old. |
| **Error** (red) | A feed is failing and there is no recent data. The layer stays empty — **it never falls back to fake data.** |

If a data source does not supply a field (an aircraft's ICAO24, a vessel's MMSI, a satellite's NORAD ID, origin and destination…), the panel says **NOT PROVIDED** rather than inventing one.

---

A real source and the simulation never share a layer: the moment a real feed runs on a layer, the simulated stand-in on that layer is removed. Satellite positions are **calculated** from orbital elements (and say so); aircraft are a **regional** snapshot around the middle of your screen (up to 250 nautical miles), not the whole world.

---

## Optional data proxy

Browsers cannot read CelesTrak or AISStream directly, adsb.lol does not document browser access, and NASA FIRMS needs a secret key, so these go through a tiny relay you run yourself on Cloudflare Workers (free plan). It only forwards four allow-listed requests, caches them, and only answers your own site. Aircraft and satellites need no key; ships and wildfires do.

1. Cloudflare dashboard → **Workers & Pages → Create → Worker**, name it e.g. `gec-proxy`, **Deploy**, then **Edit code**.
2. Paste the contents of `worker/worker.js`, **Deploy**.
3. Worker **Settings → Variables**: add `ALLOWED_ORIGIN` = `https://<your-username>.github.io` (no path, no trailing slash). Deploy again.
4. Open `https://<your-worker>.workers.dev/health` — you should see `{"ok":true}` only when opened from your site; directly it may say "Origin not allowed", which is fine.
5. In the app: **Settings → Data proxy address** → paste the `https://…workers.dev` address. Aircraft and Satellites go live.

6. Press **Test proxy** under the address box. It tells you which step is wrong.

**If aircraft/satellites show "Could not reach the data provider":** the page could not talk to your Worker at all. Check in this order:
- The address is the exact `https://….workers.dev` address from the Cloudflare dashboard (no extra path).
- The Worker is **deployed** (press Deploy after pasting the code *and* after adding the variable).
- `ALLOWED_ORIGIN` equals your site's origin exactly, e.g. `https://yourname.github.io` — not `https://yourname.github.io/gods-eye-control/`, no trailing slash. Updated Worker code now explains this problem in plain words, so re-paste the latest `worker/worker.js`.
- Open `<your-worker-address>/health?deep=1` in a browser tab. Seeing a message about the allowed origin is normal there; the **Test proxy** button runs the same check from your real site.

### Keys for ships and wildfires (optional)

1. Get a free key at [aisstream.io](https://aisstream.io) and a free MAP_KEY from [NASA FIRMS](https://firms.modaps.eosdis.nasa.gov/api/map_key/).
2. Worker **Settings → Variables and Secrets** → add `AISSTREAM_KEY` and `FIRMS_MAP_KEY`, each with type **Secret** (never *Text*). Deploy.
3. Press **Test proxy**. It shows only whether each key exists, never the key.

Until a key is added, that layer shows simulated sample data and says which key is missing. Ships are a **regional sample** of the area on screen; wildfire hotspots are satellite detections from the last 24 h with a confidence level, not damage or severity. Weather shows the screen centre and your saved locations only, from a model grid (not a sensor).

Without the proxy everything else still works; those two layers just stay simulated and say why.

---

## What works

- **3D globe** (CesiumJS 1.132): drag to rotate, pinch/scroll to zoom, tap a marker to select, tap empty globe to select a point.
- **Real earthquakes** (USGS, M2.5+ past day, refreshed every 2 minutes), **real aircraft** and **calculated satellite positions** (with the proxy).
- **Eight toggleable layers**: Aircraft, Ships, Satellites, Earthquakes, Wildfires, Weather, My locations, Cameras. Each shows its entity count, feed state, last update, and source attribution. Toggles really show/hide the layer on the globe and are remembered.
- **Clustering**: crowded markers merge into a numbered badge; tap it to zoom in.
- **Distinct marker shapes** per type (not just colours).
- **Entity intelligence panel**: changes with the selected type (aircraft, vessel, satellite, earthquake, wildfire, weather, camera, saved location, selected point).
- **Tracking**: pin entities to a watch list, keep their names visible, follow one with the camera, and draw their **observed** path (only positions the source actually reported; nothing is interpolated).
- **Saved locations**: tap the globe, name the point, save it. Stored in your browser, never uploaded.
- **Search**: coordinates (`12.5, 122.1` or `12.5N 122.1E`), entities already on the globe, and place names (OpenStreetMap Nominatim, on Enter only).
- **Top command bar**: UTC and local clocks, honest system status, search, settings, fullscreen.
- **Telemetry bar**: centre coordinates, cursor coordinates (desktop), camera altitude, layer and entity counts, feed summary, refresh status, last sync, and render performance.
- **Settings**: basemap, dimming, day/night lighting, atmosphere, render quality, default view, simulation on/off, refresh interval, UI density, clock format, timestamp zone, and a read-only reference of every planned data source.
- **Responsive**: phone layout with a layers drawer and a details bottom-sheet; three-column layout on desktop.

---

## Deploy to GitHub Pages (from a phone)

1. On the GitHub mobile website, create a repository (e.g. `gods-eye-control`).
2. Add the files keeping this exact folder structure (see [Project structure](#project-structure)). In the browser's **Desktop site** mode you can use **Add file → Upload files**; otherwise use **Add file → Create new file** and type the path with slashes (for example `css/main.css`) so GitHub creates the folder.
3. Go to **Settings → Pages**. Under *Build and deployment*, choose **Deploy from a branch**, branch `main`, folder `/ (root)`, then **Save**.
4. After a minute or two your site is live at `https://<your-username>.github.io/<repository-name>/`.

Everything uses relative paths, so it works from a sub-path like that without changes. After editing a file, a hard refresh (or reopening the tab) picks up the new version.

**Requirements for visitors:** a modern browser with WebGL (current Chrome, Edge, Firefox or Safari) and an internet connection (CesiumJS, fonts and map tiles load from the network).

---

## Project structure

```
gods-eye-control/
├── index.html                  Page skeleton, icon sprite, settings dialog
├── README.md                   This file
├── INTERNAL.md                 Developer notes (architecture, tests, next steps)
├── THIRD_PARTY_NOTICES.md      Credits and licences
├── worker/
│   ├── worker.js               Optional Cloudflare Worker data proxy
│   └── wrangler.toml           Only for command-line deploys
├── css/
│   ├── main.css                Cascade-layer order, design tokens, base, buttons/chips/switches
│   ├── layout.css              Command bar, stage grid, telemetry bar, mobile vs desktop
│   ├── panels.css              Side panels, layer list, intelligence panel, search, settings
│   └── globe.css               Globe container, on-globe controls, toasts, fallback screens
└── js/
    ├── app.js                  Starts everything and connects the modules
    ├── config.js               Layer definitions, marker styles, basemaps
    ├── util.js                 Formatting, coordinate parsing, geometry, tiny helpers
    ├── settings.js             Saved preferences + the Settings dialog
    ├── globe.js                CesiumJS viewer, basemap, camera, picking
    ├── layers.js               Layer manager (+ clustering) and the layers panel
    ├── entities.js             The entity store (one list of everything on the map)
    ├── markers.js              Draws marker icons on a canvas
    ├── tracking.js             Tracking, camera follow, observed paths, tracked list
    ├── intel-panel.js          The entity intelligence panel
    ├── search.js               Global search
    ├── telemetry.js            Clocks, system status, bottom bar
    └── data/
        ├── provider-manager.js     Which sources exist and their true state
        ├── provider-catalog.js     Documented real sources (descriptions only)
        ├── net.js                  Safe fetching: timeout, rate-limit, error types
        ├── live-provider.js        Shared engine for every real source (state machine)
        ├── usgs-provider.js        Real earthquakes
        ├── adsb-provider.js        Real aircraft (via proxy)
        ├── celestrak-provider.js   Calculated satellites (via proxy)
        ├── ais-provider.js         Real ships (via proxy, key is a secret)
        ├── firms-provider.js       Real wildfire hotspots (via proxy, key is a secret)
        ├── weather-provider.js     Real weather points (Open-Meteo)
        ├── sample-provider.js      Simulated sample data
        └── local-locations-provider.js   Your saved locations
```

Data providers are plug-in modules: the globe and panels never depend on any specific source, so real feeds can be added without touching the interface.

---

## Data sources

Phase 3 connects USGS and Open-Meteo (direct), adsb.lol, CelesTrak, AISStream and FIRMS (via the proxy). The rest are planned. Limits that matter are listed; items marked *verify* must be confirmed from a real browser.

| Layer | Source | Key needed? | Notable limits | Needs a proxy? |
|---|---|---|---|---|
| Aircraft | [adsb.lol](https://api.adsb.lol/docs) (**active with proxy**) | No | Volunteer service, no published limit; we poll every 15 s for one area ≤250 nm; ODbL | Yes (Worker, no secret) |
| Aircraft (alt.) | [OpenSky Network](https://opensky-network.org/) | Anonymous allowed; OAuth2 for more | Anonymous: 400 credits/day. *Not implemented* | Browser CORS: *verify* |
| Ships | [AISStream.io](https://aisstream.io) WebSocket | Free API key | Max 3 connections; the provider says **direct browser connections are not permitted** | **Yes** (Cloudflare Worker relay) |
| Satellites | [CelesTrak](https://celestrak.org/) GP elements (**active with proxy**) | No | Elements cached 6 h; positions calculated in the browser (SGP4) | **Yes** — no CORS headers |
| Earthquakes | [USGS feeds](https://earthquake.usgs.gov/earthquakes/feed/) (**active**) | No | M2.5+ past day, polled every 2 min | No |
| Wildfires | [NASA FIRMS](https://firms.modaps.eosdis.nasa.gov/) | Free MAP_KEY | Per-key transaction limit | **Yes** (key is a secret) |
| Weather | [Open-Meteo](https://open-meteo.com/) | No | Free tier: 600/min, 5,000/h, 10,000/day; **non-commercial only**; CC-BY 4.0 | No |
| Place search | [Nominatim](https://nominatim.org/) (OpenStreetMap) | No | **Max 1 request/second, no search-as-you-type**, attribution required. Active now, on Enter only | No |
| Cameras | None chosen yet | — | Only legitimately public feeds; each camera will carry a “last verified” status | — |

No API key or secret is ever stored in the browser or the repository. Providers that need a secret will go through an optional Cloudflare Worker.

---

## Roadmap

| Phase | Scope | State |
|---|---|---|
| 1 | Foundation: layout, globe, layers, selection, telemetry, simulated samples | **Done** |
| 2 | Real data: USGS earthquakes, adsb.lol aircraft, CelesTrak satellites, timeouts / rate-limit / stale handling, optional proxy | **Done (needs your phone test)** |
| 3 | Tracking depth, ships (AIS relay), wildfires (FIRMS), weather points | **Done (needs your phone test)** |
| 4 | Event feed, filters, regional observation, richer geographic search | Next |
| 5 | AI analyst (structured scene context, simulation-labelled mock first) | Planned |
| 6 | Mobile optimisation, clustering polish, error recovery, Android pass | Planned |

---

## Attribution and credits

- 3D engine: [CesiumJS](https://cesium.com/platform/cesiumjs/) (Apache-2.0).
- Basemap: © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors (shown on the globe); optional Natural Earth II bundled with Cesium.
- Place search: © OpenStreetMap contributors, via Nominatim.
- Inspired by [gods-eye-view](https://github.com/bilawalsidhu/gods-eye-view) (MIT). This is a separate application; some feed-handling *ideas* were adapted — see `THIRD_PARTY_NOTICES.md`.
- Aircraft: adsb.lol contributors (ODbL). Earthquakes: USGS. Orbits: CelesTrak. Orbit maths: satellite.js (MIT). Weather: Open-Meteo.com (CC BY 4.0). Ships: AISStream.io. Fires: NASA FIRMS.
- Fonts: Barlow Semi Condensed and IBM Plex Mono via Google Fonts (system fonts are used if they cannot load).

Add a `LICENSE` file of your choice before sharing the repository publicly.
