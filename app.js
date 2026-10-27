/* FossilTrace proof of concept.
 * Museum specimens: GBIF occurrence API (basisOfRecord = FOSSIL_SPECIMEN), fetched live for the visible area.
 * Research sites: Paleobiology Database (PBDB) collections, with the fossils recorded at each.
 * Bedrock: Macrostrat geologic map tiles and point lookups. Protected areas: Protected Planet (WDPA).
 * Fallback pictures and wiki links: Wikipedia Action API (one batched query per click).
 * Every data API call goes through /api/proxy, which Vercel's CDN caches for 4 days.
 * Imagery: Esri World Imagery.
 */
(function () {
  "use strict";

  const GBIF = "https://api.gbif.org/v1";
  const GBIF_BACKBONE = "d7dddbf4-2cf0-4f39-9b2a-bb099caae36c";
  const PBDB = "https://paleobiodb.org/data1.2";
  const MACROSTRAT = "https://macrostrat.org/api/v2";
  const WDPA = "https://data-gis.unep-wcmc.org/server/rest/services/ProtectedSites/The_World_Database_of_Protected_Areas/MapServer";
  const POINTS_MIN_ZOOM = 4;     // below this, show the global density layer only
  // Finds load per fixed map square (a web-map tile at the current zoom), not per exact view, so the same
  // requests repeat across visitors and hit the cache. Per-square limits also spread dots evenly.
  const PER_TILE = 100;
  const SITES_PER_TILE = 150;
  const MAX_TILES = 8;
  const KINGDOMS = ["1", "3", "4", "5", "6", "7"]; // skips records with no identification (kingdom 0)
  const START = { center: [-79.4, 43.9], zoom: 6.4 }; // southern Ontario
  const TAXON_WORDS = /genus|species|famil|order|class|phylum|clade|taxon|extinct|fossil|animal|plant|fung|alga|bacteri|organism|fish|shark|reptile|dinosaur|mammal|bird|amphibian|mollus|snail|clam|bivalve|gastropod|cephalopod|ammon|nautil|coral|sponge|brachiopod|trilobite|crinoid|echinoderm|urchin|starfish|arthropod|insect|crustacean|worm|bryozoa|conifer|fern|tree/i;
  const cached = (url) => `/api/proxy?url=${encodeURIComponent(url)}`;

  const CATEGORIES = [
    { id: "trilobite", label: "Trilobites", color: "#ff7a45" },
    { id: "cephalopod", label: "Ammonites & squid kin", color: "#ffd23f" },
    { id: "mollusc", label: "Shells & snails", color: "#f4f1de" },
    { id: "brachiopod", label: "Brachiopods", color: "#9ad1ff" },
    { id: "coral", label: "Corals & sponges", color: "#ff5fa2" },
    { id: "echinoderm", label: "Crinoids & urchins", color: "#b388ff" },
    { id: "vertebrate", label: "Vertebrates", color: "#ff3b30" },
    { id: "arthropod", label: "Other arthropods", color: "#ffa94d" },
    { id: "plant", label: "Plants", color: "#7ee081" },
    { id: "other", label: "Other", color: "#c7c2b8" },
  ];
  const CAT_BY_ID = Object.fromEntries(CATEGORIES.map((c) => [c.id, c]));

  function categorize(o) {
    const k = o.kingdom, p = o.phylum, c = o["class"];
    if (c === "Trilobita") return "trilobite";
    if (c === "Cephalopoda") return "cephalopod";
    if (p === "Mollusca") return "mollusc";
    if (p === "Brachiopoda") return "brachiopod";
    if (p === "Cnidaria" || p === "Porifera") return "coral";
    if (p === "Echinodermata") return "echinoderm";
    if (p === "Chordata") return "vertebrate";
    if (p === "Arthropoda") return "arthropod";
    if (k === "Plantae" || /phyta$/.test(p || "")) return "plant";
    return "other";
  }

  // Geologic periods with their official ICS chart colors, oldest first. Ages in millions of years.
  const PERIODS = [
    { id: "Cambrian", abbr: "Cm", start: 538.8, end: 486.85, color: "#7fa056" },
    { id: "Ordovician", abbr: "O", start: 486.85, end: 443.1, color: "#009270" },
    { id: "Silurian", abbr: "S", start: 443.1, end: 419.62, color: "#b3e1b6" },
    { id: "Devonian", abbr: "D", start: 419.62, end: 358.86, color: "#cb8c37" },
    { id: "Carboniferous", abbr: "C", start: 358.86, end: 298.9, color: "#67a599" },
    { id: "Permian", abbr: "P", start: 298.9, end: 251.9, color: "#f04028" },
    { id: "Triassic", abbr: "Tr", start: 251.9, end: 201.4, color: "#812b92" },
    { id: "Jurassic", abbr: "J", start: 201.4, end: 143.1, color: "#34b2c9" },
    { id: "Cretaceous", abbr: "K", start: 143.1, end: 66, color: "#7fc64e" },
    { id: "Paleogene", abbr: "Pg", start: 66, end: 23.04, color: "#fd9a52" },
    { id: "Neogene", abbr: "N", start: 23.04, end: 2.58, color: "#ffe619" },
    { id: "Quaternary", abbr: "Q", start: 2.58, end: 0, color: "#f9f97f" },
  ];
  const PERIOD_BY_ID = Object.fromEntries(PERIODS.map((p) => [p.id, p]));
  const NO_AGE_COLOR = "#8a857c";
  // Names GBIF records use that aren't periods themselves.
  const PERIOD_ALIASES = [
    [/mississippian|pennsylvanian/i, "Carboniferous"], [/tertiary/i, "Paleogene"],
    [/paleocene|eocene|oligocene/i, "Paleogene"], [/miocene|pliocene/i, "Neogene"],
    [/pleistocene|holocene/i, "Quaternary"],
  ];
  function periodFromName(s) {
    if (!s) return null;
    const hit = PERIODS.find((p) => s.toLowerCase().includes(p.id.toLowerCase()));
    if (hit) return hit.id;
    const alias = PERIOD_ALIASES.find(([re]) => re.test(s));
    return alias ? alias[1] : null;
  }
  function periodFromMa(max, min) {
    if (typeof max !== "number") return null;
    const mid = typeof min === "number" ? (max + min) / 2 : max;
    const p = PERIODS.find((x) => mid <= x.start && mid >= x.end);
    return p ? p.id : null;
  }
  function gbifPeriod(r) {
    return periodFromName(r.earliestPeriodOrLowestSystem) || periodFromName(r.latestPeriodOrHighestSystem)
      || periodFromName(r.earliestEpochOrLowestSeries) || periodFromName(r.latestEpochOrHighestSeries);
  }

  // Famous places to start from. Each one is just a saved view, like a shared link.
  const TOURS = [
    { id: "burgess", label: "Burgess Shale, BC (Cambrian)", center: [-116.47, 51.43], zoom: 10.5, period: "Cambrian" },
    { id: "drumheller", label: "Drumheller dinosaurs, Alberta", center: [-112.71, 51.46], zoom: 9.2, period: "Cretaceous", taxon: { name: "Dinosauria", label: "dinosaurs" } },
    { id: "toronto", label: "Toronto's Ordovician sea floor", center: [-79.4, 43.75], zoom: 9, period: "Ordovician" },
    { id: "mazon", label: "Mazon Creek, Illinois", center: [-88.25, 41.2], zoom: 9, period: "Carboniferous" },
    { id: "jurassic-coast", label: "Jurassic Coast ammonites, England", center: [-2.95, 50.72], zoom: 10, period: "Jurassic", taxon: { name: "Ammonoidea", label: "ammonites" } },
    { id: "solnhofen", label: "Solnhofen limestone, Germany", center: [11.0, 48.9], zoom: 9.5, period: "Jurassic" },
    { id: "trilobites-ny", label: "Trilobites of New York", center: [-75.8, 42.9], zoom: 7, taxon: { name: "Trilobita", label: "trilobites" } },
  ];

  // ---------- state ----------
  const state = {
    photosOnly: false,
    enabled: new Set(CATEGORIES.map((c) => c.id)),
    layers: { gbif: true, pbdb: true, geo: false, pa: false },
    colorBy: "group",
    period: null,          // a PERIODS id, or null for all time
    taxon: null,           // { name, label, gbifKeys: [] | null while resolving }
    records: [],           // raw GBIF occurrences for the current view
    sites: [],             // PBDB collections for the current view
    total: 0,
    sitesTotal: 0,
    controller: null,
    selectedKey: null,
  };
  const byKey = new Map();
  const siteByNo = new Map();
  const wikiCache = new Map();
  const vernacularCache = new Map();

  // ---------- DOM ----------
  const $ = (id) => document.getElementById(id);
  const statusEl = $("status");
  const panel = $("panel");
  const panelBody = $("panel-body");

  function esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
  }
  function setStatus(html) { statusEl.innerHTML = html; }

  // ---------- link state (shareable URL) ----------
  // #map=zoom/lat/lng&period=Devonian&taxon=Trilobita&label=trilobites&layers=gbif,pbdb&color=age&photos=1
  function readHash() {
    const h = new URLSearchParams(location.hash.slice(1));
    const out = {};
    const m = (h.get("map") || "").split("/").map(Number);
    if (m.length === 3 && m.every(Number.isFinite)) out.view = { zoom: m[0], center: [m[2], m[1]] };
    if (PERIOD_BY_ID[h.get("period")]) state.period = h.get("period");
    if (h.get("taxon")) state.taxon = { name: h.get("taxon"), label: h.get("label") || h.get("taxon"), gbifKeys: null };
    if (h.get("layers") !== null) {
      const on = new Set((h.get("layers") || "").split(","));
      for (const k of Object.keys(state.layers)) state.layers[k] = on.has(k);
    }
    if (h.get("color") === "age") state.colorBy = "age";
    if (h.get("photos") === "1") state.photosOnly = true;
    return out;
  }
  let hashTimer = null;
  function writeHash() {
    clearTimeout(hashTimer);
    hashTimer = setTimeout(() => {
      const c = map.getCenter();
      const h = new URLSearchParams();
      h.set("map", `${map.getZoom().toFixed(2)}/${c.lat.toFixed(4)}/${c.lng.toFixed(4)}`);
      if (state.period) h.set("period", state.period);
      if (state.taxon) { h.set("taxon", state.taxon.name); if (state.taxon.label !== state.taxon.name) h.set("label", state.taxon.label); }
      const layers = Object.keys(state.layers).filter((k) => state.layers[k]).join(",");
      if (layers !== "gbif,pbdb") h.set("layers", layers);
      if (state.colorBy === "age") h.set("color", "age");
      if (state.photosOnly) h.set("photos", "1");
      history.replaceState(null, "", "#" + h.toString().replace(/%2F/g, "/").replace(/%2C/g, ","));
    }, 250);
  }
  const initial = readHash();

  // ---------- legend + time bar ----------
  function renderLegend() {
    const counts = {};
    for (const r of state.records) counts[r._cat] = (counts[r._cat] || 0) + 1;
    const chips = CATEGORIES.filter((c) => counts[c.id] || !state.records.length)
      .map((c) => `<button type="button" class="chip" data-cat="${c.id}" aria-pressed="${state.enabled.has(c.id)}">
        <span class="dot" style="background:${state.colorBy === "group" ? c.color : "transparent"};${state.colorBy === "group" ? "" : "box-shadow:inset 0 0 0 1.5px var(--ink-faint)"}"></span>${esc(c.label)}${counts[c.id] ? ` <span style="color:var(--ink-faint)">${counts[c.id]}</span>` : ""}</button>`)
      .join("");
    const ageNote = state.colorBy === "age"
      ? `<p class="note">Dot colors match the time bar. <span class="swatch" style="background:${NO_AGE_COLOR}"></span> grey means the record has no age.</p>` : "";
    $("legend").innerHTML = ageNote + chips;
    renderTimebar();
  }
  $("legend").addEventListener("click", (e) => {
    const chip = e.target.closest(".chip");
    if (!chip) return;
    const id = chip.dataset.cat;
    if (state.enabled.has(id)) state.enabled.delete(id); else state.enabled.add(id);
    renderLegend();
    pushData();
  });

  function renderTimebar() {
    const counts = {};
    for (const r of state.records) if (r._period) counts[r._period] = (counts[r._period] || 0) + 1;
    for (const s of state.sites) if (s._period) counts[s._period] = (counts[s._period] || 0) + 1;
    $("timebar").innerHTML = PERIODS.map((p) => {
      const n = counts[p.id] || 0;
      const title = `${p.id}, ${p.start}–${p.end} million years ago${n ? ` (${n} in view)` : ""}`;
      return `<button type="button" class="tb" data-period="${p.id}" aria-pressed="${state.period === p.id}" title="${esc(title)}" aria-label="${esc(title)}"
        style="--c:${p.color}"><span>${p.abbr}</span><i style="height:${n ? Math.max(2, Math.min(5, Math.round(Math.log2(n + 1) * 0.8))) : 0}px"></i></button>`;
    }).join("");
    $("time-label").textContent = state.period
      ? `${state.period} · ${PERIOD_BY_ID[state.period].start}–${PERIOD_BY_ID[state.period].end} Ma`
      : "All time";
    $("timebar").classList.toggle("filtered", !!state.period);
  }
  $("timebar").addEventListener("click", (e) => {
    const b = e.target.closest(".tb");
    if (!b) return;
    state.period = state.period === b.dataset.period ? null : b.dataset.period;
    renderTimebar();
    writeHash();
    loadView();
  });

  // ---------- map ----------
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const flyIn = !reduceMotion && !initial.view;
  const map = new maplibregl.Map({
    container: "map",
    center: initial.view ? initial.view.center : flyIn ? [-40, 25] : START.center,
    zoom: initial.view ? initial.view.zoom : flyIn ? 1.6 : START.zoom,
    maxPitch: 75,
    attributionControl: { compact: true },
    style: {
      version: 8,
      projection: { type: "globe" },
      glyphs: "https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf",
      sky: { "atmosphere-blend": ["interpolate", ["linear"], ["zoom"], 0, 1, 5, 1, 7, 0] },
      sources: {
        // Esri has no high-res tiles for remote areas (Greenland, open ocean) and by default serves a
        // "Map data not yet available" picture. blankTile=false makes those 404 instead, so the
        // overzoomed low-res layer underneath shows through.
        "imagery-base": {
          type: "raster",
          tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"],
          tileSize: 256, maxzoom: 12,
          attribution: "Imagery © Esri, Maxar, Earthstar Geographics",
        },
        imagery: {
          type: "raster",
          tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}?blankTile=false"],
          tileSize: 256, minzoom: 12, maxzoom: 19,
        },
        geology: {
          type: "raster",
          tiles: ["https://tiles.macrostrat.org/carto/{z}/{x}/{y}.png"],
          tileSize: 512, maxzoom: 16,
          attribution: 'Geology © <a href="https://macrostrat.org" target="_blank" rel="noopener">Macrostrat</a> (CC BY 4.0)',
        },
        protected: {
          type: "raster",
          tiles: [`${WDPA}/tile/{z}/{y}/{x}`],
          tileSize: 256, maxzoom: 19,
          attribution: 'Protected areas © UNEP-WCMC &amp; IUCN, <a href="https://www.protectedplanet.net" target="_blank" rel="noopener">Protected Planet</a>',
        },
        labels: {
          type: "raster",
          tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}"],
          tileSize: 256, maxzoom: 19,
        },
        density: {
          type: "raster",
          tiles: [densityTiles()],
          tileSize: 256,
          attribution: 'Fossil records © <a href="https://www.gbif.org" target="_blank" rel="noopener">GBIF</a> contributors · <a href="https://paleobiodb.org" target="_blank" rel="noopener">PBDB</a> (CC BY 4.0)',
        },
      },
      layers: [
        { id: "imagery-base", type: "raster", source: "imagery-base" },
        { id: "imagery", type: "raster", source: "imagery", minzoom: 12 },
        { id: "geology", type: "raster", source: "geology", layout: { visibility: state.layers.geo ? "visible" : "none" }, paint: { "raster-opacity": 0.6 } },
        { id: "protected", type: "raster", source: "protected", layout: { visibility: state.layers.pa ? "visible" : "none" }, paint: { "raster-opacity": 0.7 } },
        { id: "labels", type: "raster", source: "labels", paint: { "raster-opacity": 0.85 } },
        { id: "density", type: "raster", source: "density",
          paint: { "raster-opacity": ["interpolate", ["linear"], ["zoom"], 0, 0.95, POINTS_MIN_ZOOM, 0.7, POINTS_MIN_ZOOM + 2, 0] } },
      ],
    },
  });
  window.fossilMap = map; // handy for debugging in the console
  map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "bottom-right");
  map.addControl(new maplibregl.ScaleControl({ unit: "metric" }), "bottom-left");

  function densityTiles() {
    let url = `${GBIF.replace("/v1", "")}/v2/map/occurrence/density/{z}/{x}/{y}@1x.png?srs=EPSG:3857&basisOfRecord=FOSSIL_SPECIMEN&style=classic.point`;
    if (state.taxon && state.taxon.gbifKeys) for (const k of state.taxon.gbifKeys) url += `&taxonKey=${k}`;
    return url;
  }
  function refreshDensity() {
    const src = map.getSource("density");
    if (src) src.setTiles([densityTiles()]);
  }

  let placeMarker = null;
  // Layers whose dots answer a click themselves; finds.js adds its own.
  const CLICK_LAYERS = ["points", "clusters", "sites", "site-clusters"];

  map.on("load", () => {
    map.addSource("finds", {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
      cluster: true, clusterRadius: 38, clusterMaxZoom: 13,
    });
    map.addSource("sites", {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
      cluster: true, clusterRadius: 34, clusterMaxZoom: 12,
    });
    // Research sites (PBDB) sit under museum specimens and are drawn as hollow rings so the two never look alike.
    map.addLayer({
      id: "site-clusters", type: "circle", source: "sites", filter: ["has", "point_count"],
      paint: {
        "circle-color": "rgba(20,18,16,0.85)",
        "circle-stroke-color": "#f3ede2", "circle-stroke-width": 2.5,
        "circle-radius": ["step", ["get", "point_count"], 15, 10, 19, 50, 24, 200, 29],
      },
    });
    map.addLayer({
      id: "site-cluster-count", type: "symbol", source: "sites", filter: ["has", "point_count"],
      layout: { "text-field": ["get", "point_count_abbreviated"], "text-size": 13, "text-font": ["Open Sans Semibold"], "text-allow-overlap": true },
      paint: { "text-color": "#f3ede2" },
    });
    map.addLayer({
      id: "sites", type: "circle", source: "sites", filter: ["!", ["has", "point_count"]],
      paint: {
        "circle-color": "rgba(20,18,16,0.8)",
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 4, 6, 12, 8],
        "circle-stroke-color": ["get", "color"],
        "circle-stroke-width": 3,
      },
    });
    map.addLayer({
      id: "site-selected", type: "circle", source: "sites", filter: ["==", ["get", "no"], -1],
      paint: { "circle-color": "rgba(0,0,0,0)", "circle-radius": 14, "circle-stroke-color": "#fff", "circle-stroke-width": 3 },
    });
    map.addLayer({
      id: "clusters", type: "circle", source: "finds", filter: ["has", "point_count"],
      paint: {
        "circle-color": "#e3a03c",
        "circle-opacity": 0.9,
        "circle-stroke-color": "#1a1307", "circle-stroke-width": 2,
        "circle-radius": ["step", ["get", "point_count"], 17, 10, 21, 50, 26, 200, 32],
      },
    });
    map.addLayer({
      id: "cluster-count", type: "symbol", source: "finds", filter: ["has", "point_count"],
      layout: { "text-field": ["get", "point_count_abbreviated"], "text-size": 15, "text-font": ["Open Sans Semibold"], "text-allow-overlap": true },
      paint: { "text-color": "#1a1307" },
    });
    map.addLayer({
      id: "points", type: "circle", source: "finds", filter: ["!", ["has", "point_count"]],
      paint: {
        "circle-color": ["get", "color"],
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 4, 8, 12, 10],
        "circle-stroke-color": "#111",
        "circle-stroke-width": ["case", ["get", "hasPhoto"], 3, 1.5],
      },
    });
    map.addLayer({
      id: "selected", type: "circle", source: "finds", filter: ["==", ["get", "key"], -1],
      paint: { "circle-color": "rgba(0,0,0,0)", "circle-radius": 15, "circle-stroke-color": "#fff", "circle-stroke-width": 3 },
    });

    map.on("click", "clusters", (e) => onClusterClick(e, "finds"));
    map.on("click", "site-clusters", (e) => onClusterClick(e, "sites"));
    map.on("click", "points", (e) => {
      const f = e.features && e.features[0];
      if (f) showRecord(f.properties.key);
    });
    map.on("click", "sites", (e) => {
      // A specimen dot drawn on top of a site wins the click.
      if (map.queryRenderedFeatures(e.point, { layers: ["points", "clusters"] }).length) return;
      const f = e.features && e.features[0];
      if (f) showSite(f.properties.no);
    });
    // Tapping bare ground answers "what rock is this, and can I collect here?"
    map.on("click", (e) => {
      if (window.FossilTrace?.beforePlaceClick?.(e)) return; // finds.js tap-to-place
      const layers = CLICK_LAYERS.filter((l) => map.getLayer(l));
      if (map.queryRenderedFeatures(e.point, { layers }).length) return;
      if (map.getZoom() < POINTS_MIN_ZOOM) return;
      showPlace(e.lngLat);
    });
    for (const layer of ["clusters", "points", "sites", "site-clusters"]) {
      map.on("mouseenter", layer, () => { map.getCanvas().style.cursor = "pointer"; });
      map.on("mouseleave", layer, () => { map.getCanvas().style.cursor = ""; });
    }

    map.on("moveend", () => { scheduleLoad(); writeHash(); });
    if (state.taxon) resolveTaxon();
    if (flyIn) {
      setStatus("Flying to southern Ontario…");
      setTimeout(() => map.flyTo({ center: START.center, zoom: START.zoom, speed: 0.9, curve: 1.6, essential: true }), 600);
    } else {
      scheduleLoad();
    }
  });

  // ---------- data loading ----------
  let loadTimer = null;
  function scheduleLoad() {
    clearTimeout(loadTimer);
    loadTimer = setTimeout(loadView, 350);
  }

  const lon2x = (lon, z) => Math.floor(((lon + 180) / 360) * 2 ** z);
  const lat2y = (lat, z) => Math.floor(((1 - Math.asinh(Math.tan((lat * Math.PI) / 180)) / Math.PI) / 2) * 2 ** z);
  const x2lon = (x, z) => (x / 2 ** z) * 360 - 180;
  const y2lat = (y, z) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / 2 ** z))) * 180) / Math.PI;

  // Tiles covering the view. Crossing the antimeridian or a heavily tilted globe falls back to coarser tiles.
  function viewTiles() {
    const b = map.getBounds();
    const s = Math.max(-85, b.getSouth()), n = Math.min(85, b.getNorth());
    let w = b.getWest(), e = b.getEast();
    if (e - w >= 360 || w < -180 || e > 180) { w = -180; e = 179.999; }
    for (let z = Math.max(1, Math.floor(map.getZoom())); z >= 1; z--) {
      const x0 = lon2x(w, z), x1 = lon2x(e, z), y0 = lat2y(n, z), y1 = lat2y(s, z);
      if ((x1 - x0 + 1) * (y1 - y0 + 1) > MAX_TILES && z > 1) continue;
      const tiles = [];
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          tiles.push({ s: y2lat(y + 1, z), n: y2lat(y, z), w: x2lon(x, z), e: x2lon(x + 1, z) });
        }
      }
      // Load the squares nearest the middle of the view first.
      const cy = (s + n) / 2, cx = (w + e) / 2;
      return tiles.sort((a, b2) => Math.hypot((a.s + a.n) / 2 - cy, (a.w + a.e) / 2 - cx) - Math.hypot((b2.s + b2.n) / 2 - cy, (b2.w + b2.e) / 2 - cx));
    }
    return [];
  }

  function gbifUrl(t) {
    const q = new URLSearchParams({
      basisOfRecord: "FOSSIL_SPECIMEN",
      hasCoordinate: "true",
      hasGeospatialIssue: "false",
      decimalLatitude: `${t.s.toFixed(4)},${t.n.toFixed(4)}`,
      decimalLongitude: `${t.w.toFixed(4)},${t.e.toFixed(4)}`,
      limit: String(PER_TILE),
    });
    for (const k of KINGDOMS) q.append("kingdomKey", k);
    if (state.photosOnly) q.set("mediaType", "StillImage");
    if (state.period) q.set("geologicalTime", state.period);
    if (state.taxon) for (const k of state.taxon.gbifKeys || []) q.append("taxonKey", k);
    return cached(`${GBIF}/occurrence/search?${q}`);
  }

  function pbdbUrl(t) {
    const q = new URLSearchParams({
      lngmin: t.w.toFixed(4), lngmax: t.e.toFixed(4), latmin: t.s.toFixed(4), latmax: t.n.toFixed(4),
      limit: String(SITES_PER_TILE), order: "occs.desc", show: "loc,strat,ref", vocab: "pbdb", rowcount: "",
    });
    if (state.period) q.set("interval", state.period);
    if (state.taxon) q.set("base_name", state.taxon.name);
    return cached(`${PBDB}/colls/list.json?${q}`);
  }

  // Museum specimens can only be filtered once the group has a GBIF key; groups GBIF doesn't know get none.
  const gbifUsable = () => state.layers.gbif && (!state.taxon || (state.taxon.gbifKeys && state.taxon.gbifKeys.length > 0));

  async function loadView() {
    if (map.getZoom() < POINTS_MIN_ZOOM) {
      if (state.controller) state.controller.abort();
      state.records = []; state.sites = []; state.total = 0; state.sitesTotal = 0;
      pushData(); renderLegend();
      setStatus("Glow shows where fossils have been recorded.<br><strong>Zoom in</strong>, search a place or pick a famous site to see individual finds.");
      return;
    }
    if (state.taxon && state.taxon.gbifKeys === null) return; // resolveTaxon calls back when ready
    if (state.controller) state.controller.abort();
    const controller = new AbortController();
    state.controller = controller;
    setStatus("Loading fossil finds in view…");

    const tiles = viewTiles();
    const soft = (u) => fetchJSON(u, controller.signal).catch((err) => { if (err.name === "AbortError") throw err; return null; });
    try {
      // On a cold cache GBIF answers 429 to bursts of parallel searches, so keep only a few in flight.
      const [gbifPages, pbdbPages] = await Promise.all([
        gbifUsable() ? mapLimit(tiles.map(gbifUrl), 3, soft) : Promise.resolve(null),
        state.layers.pbdb ? mapLimit(tiles.map(pbdbUrl), 3, soft) : Promise.resolve(null),
      ]);
      if (controller.signal.aborted) return;

      byKey.clear();
      const gOk = (gbifPages || []).filter(Boolean);
      state.records = gOk.flatMap((p) => p.results || [])
        .filter((r) => typeof r.decimalLatitude === "number" && typeof r.decimalLongitude === "number" && !byKey.has(r.key) && byKey.set(r.key, r))
        .map((r) => { r._cat = categorize(r); r._photo = photoUrls(r); r._period = gbifPeriod(r); return r; });
      state.total = gOk.reduce((t, p) => t + (p.count || 0), 0);

      siteByNo.clear();
      const pOk = (pbdbPages || []).filter(Boolean);
      state.sites = pOk.flatMap((p) => p.records || [])
        .map((s) => ({ ...s, no: Number(s.collection_no), lat: Number(s.lat), lng: Number(s.lng), max_ma: Number(s.max_ma), min_ma: Number(s.min_ma) }))
        .filter((s) => Number.isFinite(s.lat) && Number.isFinite(s.lng) && !siteByNo.has(s.no) && siteByNo.set(s.no, s))
        .map((s) => { s._period = periodFromMa(s.max_ma, s.min_ma); return s; });
      state.sitesTotal = pOk.reduce((t, p) => t + (Number(p.records_found) || 0), 0);

      pushData();
      renderLegend();
      const gbifFailed = gbifPages && gbifPages.length && !gOk.length;
      const pbdbFailed = pbdbPages && pbdbPages.length && !pOk.length;
      if (gbifFailed && (pbdbFailed || !pbdbPages)) throw new Error("All requests failed");
      setStatus(statusText(gbifFailed, pbdbFailed));
    } catch (err) {
      if (err.name === "AbortError") return;
      console.error(err);
      setStatus("Could not reach the fossil databases. Check your connection and move the map to retry.");
    }
  }

  function statusText(gbifFailed, pbdbFailed) {
    const parts = [];
    const filter = [state.taxon && esc(state.taxon.label), state.period && esc(state.period)].filter(Boolean).join(", ");
    if (state.layers.gbif) {
      if (!gbifUsable()) parts.push("Museum specimens: not filterable by this group");
      else if (gbifFailed) parts.push("Museum specimens: GBIF didn't answer");
      else {
        const shown = state.records.length;
        parts.push(`<strong>${shown.toLocaleString()}</strong>${shown < state.total ? ` of ${state.total.toLocaleString()}` : ""} museum specimens`);
      }
    }
    if (state.layers.pbdb) {
      if (pbdbFailed) parts.push("Research sites: PBDB didn't answer");
      else {
        const shown = state.sites.length;
        parts.push(`<strong>${shown.toLocaleString()}</strong>${shown < state.sitesTotal ? ` of ${state.sitesTotal.toLocaleString()}` : ""} research sites`);
      }
    }
    if (!parts.length) return "Turn on museum specimens or research sites to see finds.";
    const none = !state.records.length && !state.sites.length;
    const more = state.records.length < state.total || state.sites.length < state.sitesTotal;
    return parts.join("<br>") + (filter ? `<br>Showing ${filter}.` : "")
      + (none ? "<br>Nothing recorded here" + (filter ? " for this filter" : "") + ". Try another area." : more ? "<br>Zoom in to see more." : "")
      + "<br>Tap bare ground to see the rock there.";
  }

  async function fetchJSON(url, signal, retries = 2) {
    const res = await fetch(url, { signal });
    if (res.status === 429 && retries > 0) {
      await new Promise((ok) => setTimeout(ok, 1200 * (3 - retries)));
      return fetchJSON(url, signal, retries - 1);
    }
    if (!res.ok) throw new Error(`${res.status} for ${url}`);
    return res.json();
  }

  async function mapLimit(items, limit, fn) {
    const out = new Array(items.length);
    let next = 0;
    const worker = async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i]); } };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return out;
  }

  const ageColor = (period) => (period ? PERIOD_BY_ID[period].color : NO_AGE_COLOR);

  function pushData() {
    const finds = map.getSource("finds");
    const sites = map.getSource("sites");
    if (!finds || !sites) return;
    finds.setData({
      type: "FeatureCollection",
      features: state.records
        .filter((r) => state.enabled.has(r._cat))
        .map((r) => ({
          type: "Feature",
          geometry: { type: "Point", coordinates: [r.decimalLongitude, r.decimalLatitude] },
          properties: { key: r.key, color: state.colorBy === "age" ? ageColor(r._period) : CAT_BY_ID[r._cat].color, hasPhoto: r._photo.length > 0 },
        })),
    });
    sites.setData({
      type: "FeatureCollection",
      features: state.sites.map((s) => ({
        type: "Feature",
        geometry: { type: "Point", coordinates: [s.lng, s.lat] },
        properties: { no: s.no, color: state.colorBy === "age" ? ageColor(s._period) : "#f3ede2" },
      })),
    });
  }

  // ---------- fossil group (taxon) filter ----------
  const RANKS = { 3: "species", 5: "genus", 8: "subfamily", 9: "family", 10: "superfamily", 12: "suborder", 13: "order", 14: "superorder", 16: "subclass", 17: "class", 18: "superclass", 19: "subphylum", 20: "phylum", 23: "kingdom", 25: "group" };
  const taxonInput = $("taxon-input");
  const taxonList = $("taxon-list");
  let suggestTimer = null, suggestSeq = 0, suggestions = [], activeIdx = -1;

  taxonInput.addEventListener("input", () => {
    clearTimeout(suggestTimer);
    const q = taxonInput.value.trim();
    if (q.length < 3) { hideSuggestions(); return; }
    suggestTimer = setTimeout(() => suggest(q), 250);
  });
  taxonInput.addEventListener("keydown", (e) => {
    if (taxonList.hidden) { if (e.key === "Enter") { e.preventDefault(); suggest(taxonInput.value.trim(), true); } return; }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      activeIdx = (activeIdx + (e.key === "ArrowDown" ? 1 : -1) + suggestions.length) % suggestions.length;
      renderSuggestions();
    } else if (e.key === "Enter") {
      e.preventDefault();
      pickTaxon(suggestions[Math.max(0, activeIdx)]);
    } else if (e.key === "Escape") {
      hideSuggestions();
    }
  });
  taxonInput.addEventListener("blur", () => setTimeout(hideSuggestions, 150));
  taxonList.addEventListener("mousedown", (e) => {
    const li = e.target.closest("li[data-i]");
    if (li) { e.preventDefault(); pickTaxon(suggestions[Number(li.dataset.i)]); }
  });
  $("taxon-clear").addEventListener("click", () => setTaxon(null));

  const band = (n) => Math.floor(Math.log(n + 1) * 4); // counts within ~25% of each other tie
  // PBDB's autocomplete knows fossil groups and many common names ("trilobite", "ammonite").
  async function suggest(q, pickFirst) {
    if (q.length < 3) return;
    const seq = ++suggestSeq;
    try {
      const j = await fetchJSON(cached(`${PBDB}/taxa/auto.json?name=${encodeURIComponent(q)}&limit=20`));
      if (seq !== suggestSeq) return;
      const byOid = new Map();
      for (const r of j.records || []) {
        if (r.typ !== "txn") continue;
        const e = byOid.get(r.oid) || { oid: r.oid, rank: RANKS[r.rnk] || "", rnk: Number(r.rnk) || 0, n: Number(r.noc) || 0, sci: null, common: null };
        if (/^[A-Z]/.test(r.nam)) e.sci = e.sci || r.nam; else e.common = e.common || r.nam;
        byOid.set(r.oid, e);
      }
      // A common name and its group can come back under different ids; pair them by occurrence count.
      // PBDB counts a group's occurrences on its synonyms and parents too, so ties are common: prefer
      // groups with a common name, then the broader rank, and show each scientific name once.
      const entries = [...byOid.values()].sort((a, b) => b.n - a.n || !!b.common - !!a.common || b.rnk - a.rnk);
      for (const e of entries.filter((x) => !x.sci)) {
        const twin = entries.find((x) => x.sci && x.n === e.n);
        if (twin) { twin.common = twin.common || e.common; e.drop = true; }
      }
      const seenSci = new Set();
      suggestions = entries.filter((e) => !e.drop && !(e.sci && seenSci.has(e.sci)) && (seenSci.add(e.sci), true))
        .sort((a, b) => band(b.n) - band(a.n) || !!b.common - !!a.common || b.n - a.n || b.rnk - a.rnk).slice(0, 8);
      activeIdx = suggestions.length ? 0 : -1;
      if (pickFirst && suggestions.length) { pickTaxon(suggestions[0]); return; }
      renderSuggestions();
    } catch (err) {
      console.error(err);
    }
  }

  function renderSuggestions() {
    if (!suggestions.length) {
      taxonList.innerHTML = `<li class="empty">No fossil group by that name</li>`;
    } else {
      taxonList.innerHTML = suggestions.map((s, i) => `<li role="option" data-i="${i}" aria-selected="${i === activeIdx}">
        <span>${s.common ? `${esc(s.common)} <i>${esc(s.sci || "")}</i>` : `<i>${esc(s.sci)}</i>`}</span>
        <small>${esc(s.rank)}${s.n ? ` · ${s.n.toLocaleString()}` : ""}</small></li>`).join("");
    }
    taxonList.hidden = false;
    taxonInput.setAttribute("aria-expanded", "true");
  }
  function hideSuggestions() {
    taxonList.hidden = true;
    taxonInput.setAttribute("aria-expanded", "false");
  }

  async function pickTaxon(s) {
    if (!s) return;
    hideSuggestions();
    let name = s.sci;
    if (!name) {
      try {
        const j = await fetchJSON(cached(`${PBDB}/taxa/single.json?id=txn:${s.oid}&vocab=pbdb`));
        name = j.records && j.records[0] && j.records[0].taxon_name;
      } catch (err) { /* fall through */ }
    }
    if (!name) return;
    setTaxon({ name, label: s.common || name });
  }

  function setTaxon(t) {
    state.taxon = t ? { ...t, gbifKeys: null } : null;
    resolveTaxon();
    writeHash();
  }

  function renderTaxonBox() {
    const t = state.taxon;
    taxonInput.value = t ? (t.label !== t.name ? `${t.label} (${t.name})` : t.name) : "";
    $("taxon-clear").hidden = !t;
    $("taxon-box").classList.toggle("active", !!t);
    const note = $("taxon-note");
    if (t && t.gbifKeys && !t.gbifKeys.length && state.layers.gbif) {
      note.textContent = `Museum records (GBIF) don't use the name ${t.name}, so only research sites are shown for it.`;
      note.hidden = false;
    } else if (t && t.gbifVia && t.gbifVia.length && state.layers.gbif) {
      note.textContent = `Museum records (GBIF) don't use the name ${t.name}, so specimens are matched through ${t.gbifVia.join(", ")} and some may be missing.`;
      note.hidden = false;
    } else {
      note.hidden = true;
    }
  }

  // Find the GBIF backbone key(s) for a group. Fossil clades like Ammonoidea aren't in GBIF's backbone,
  // so fall back to the group's largest sub-groups (from PBDB) that GBIF does know.
  const gbifKeyCache = new Map();
  async function gbifKeysFor(name) {
    if (gbifKeyCache.has(name)) return gbifKeyCache.get(name);
    const exact = async (n) => {
      try {
        const j = await fetchJSON(cached(`${GBIF}/species/search?q=${encodeURIComponent(n)}&datasetKey=${GBIF_BACKBONE}&limit=20`));
        const hit = (j.results || []).find((x) => x.canonicalName === n && x.taxonomicStatus === "ACCEPTED")
          || (j.results || []).find((x) => x.canonicalName === n);
        return hit ? (hit.acceptedKey || hit.key) : null;
      } catch (err) { return null; }
    };
    const p = (async () => {
      const key = await exact(name);
      if (key) return { keys: [key], via: [] };
      try {
        const j = await fetchJSON(cached(`${PBDB}/taxa/list.json?name=${encodeURIComponent(name)}&rel=children&vocab=pbdb`));
        const kids = (j.records || []).filter((r) => !r.difference && Number(r.n_occs) > 0)
          .sort((a, b) => Number(b.n_occs) - Number(a.n_occs)).slice(0, 10).map((r) => r.taxon_name);
        const keys = await mapLimit(kids, 3, exact);
        const via = kids.filter((k, i) => keys[i]);
        return { keys: [...new Set(keys.filter(Boolean))], via };
      } catch (err) { return { keys: [], via: [] }; }
    })();
    gbifKeyCache.set(name, p);
    return p;
  }

  async function resolveTaxon() {
    renderTaxonBox();
    const t = state.taxon;
    if (!t) { refreshDensity(); loadView(); return; }
    setStatus(`Looking up ${esc(t.label)}…`);
    const { keys, via } = await gbifKeysFor(t.name);
    if (state.taxon !== t) return;
    t.gbifKeys = keys;
    t.gbifVia = via;
    renderTaxonBox();
    refreshDensity();
    loadView();
  }

  // ---------- clusters ----------
  async function onClusterClick(e, sourceId) {
    const f = e.features && e.features[0];
    if (!f) return;
    const src = map.getSource(sourceId);
    const clusterId = f.properties.cluster_id;
    const zoom = await src.getClusterExpansionZoom(clusterId);
    // Many museum specimens share one locality; past this zoom they never split, so list them instead.
    if (zoom > 14 || map.getZoom() >= 13) {
      const leaves = await src.getClusterLeaves(clusterId, 200, 0);
      if (sourceId === "finds") showList(leaves.map((l) => byKey.get(l.properties.key)).filter(Boolean));
      else showSiteList(leaves.map((l) => siteByNo.get(l.properties.no)).filter(Boolean));
    } else {
      map.easeTo({ center: f.geometry.coordinates, zoom });
    }
  }

  function showList(records) {
    records.sort((a, b) => (a.scientificName || "").localeCompare(b.scientificName || ""));
    const locality = records[0] && (records[0].locality || records[0].stateProvince || records[0].country);
    panelBody.innerHTML = `
      <div class="list-head">
        <p class="eyebrow">One site</p>
        <h2>${records.length} finds here</h2>
        ${locality ? `<p>${esc(locality)}</p>` : ""}
      </div>
      <ul class="leaves">
        ${records.map((r) => `<li><button type="button" class="leaf" data-key="${r.key}">
          <span class="dot" style="background:${CAT_BY_ID[r._cat].color}"></span>
          <span><i>${esc(r.acceptedScientificName || r.scientificName || "Unidentified")}</i></span>
          <small>${r._photo.length ? "photo · " : ""}${esc(r.year || "")}</small>
        </button></li>`).join("")}
      </ul>`;
    openPanel();
    panelBody.querySelectorAll(".leaf").forEach((b) =>
      b.addEventListener("click", () => showRecord(Number(b.dataset.key), records)));
  }

  function showSiteList(sites) {
    sites.sort((a, b) => (a.collection_name || "").localeCompare(b.collection_name || ""));
    panelBody.innerHTML = `
      <div class="list-head">
        <p class="eyebrow eyebrow-site">Research sites</p>
        <h2>${sites.length} sites here</h2>
        <p>Places paleontologists have published fossil lists for.</p>
      </div>
      <ul class="leaves">
        ${sites.map((s) => `<li><button type="button" class="leaf" data-no="${s.no}">
          <span class="dot ring" style="border-color:${ageColor(s._period)}"></span>
          <span>${esc(s.collection_name)}</span>
          <small>${esc(s.early_interval || "")}</small>
        </button></li>`).join("")}
      </ul>`;
    openPanel();
    panelBody.querySelectorAll(".leaf").forEach((b) =>
      b.addEventListener("click", () => showSite(Number(b.dataset.no), sites)));
  }

  // ---------- detail panel ----------
  function openPanel() { panel.hidden = false; panel.scrollTop = 0; document.body.classList.add("panel-open"); }
  function clearSelection() {
    state.selectedKey = null;
    if (map.getLayer("selected")) map.setFilter("selected", ["==", ["get", "key"], -1]);
    if (map.getLayer("site-selected")) map.setFilter("site-selected", ["==", ["get", "no"], -1]);
    if (placeMarker) { placeMarker.remove(); placeMarker = null; }
  }
  function closePanel() {
    panel.hidden = true;
    document.body.classList.remove("panel-open");
    clearSelection();
  }
  $("panel-close").addEventListener("click", closePanel);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !panel.hidden) closePanel(); });

  function photoUrls(r) {
    const out = [];
    for (const m of r.media || []) {
      if (m.type !== "StillImage" || !m.identifier) continue;
      const id = m.identifier;
      // https images load directly; http ones would be blocked as mixed content, so try an https upgrade.
      const src = id.replace(/^http:/, "https:");
      out.push({ src, direct: null, credit: m.rightsHolder || m.creator || r.institutionCode || "", license: m.license || "" });
    }
    return out;
  }

  function taxonCandidates(r) {
    const species = r.species || (r.taxonRank === "SPECIES" ? r.acceptedScientificName : null);
    return [species, r.genus, r.family, r.order, r["class"]].filter(Boolean)
      .map((n) => n.replace(/\s*\(.*?\)\s*/g, " ").replace(/\s+[A-Z][a-zA-Z'\-]+,?\s*\d{4}.*$/, "").trim())
      .filter((v, i, a) => v && a.indexOf(v) === i);
  }

  // One Action API request per taxon chain (species, genus, family, order, class) instead of one REST call per name;
  // Wikipedia rate-limits bursts of REST summary calls. Link goes to the most specific article,
  // the reference picture comes from the most specific article that has one.
  async function wikiFor(r) {
    const names = taxonCandidates(r);
    if (!names.length) return null;
    const cacheKey = names.join("|");
    if (!wikiCache.has(cacheKey)) {
      const url = "https://en.wikipedia.org/w/api.php?" + new URLSearchParams({
        action: "query", format: "json", formatversion: "2", origin: "*", redirects: "1",
        prop: "pageimages|description|info|pageprops", inprop: "url", ppprop: "disambiguation",
        piprop: "thumbnail|original", pithumbsize: "800", titles: names.join("|"),
      });
      wikiCache.set(cacheKey, fetchJSON(cached(url)).then((j) => {
        const q = j.query || {};
        const alias = new Map();
        for (const x of (q.normalized || []).concat(q.redirects || [])) alias.set(x.from, x.to);
        const resolve = (n) => { let t = n; for (let i = 0; i < 3 && alias.has(t); i++) t = alias.get(t); return t; };
        const pages = new Map((q.pages || []).filter((p) => !p.missing && !(p.pageprops && "disambiguation" in p.pageprops)).map((p) => [p.title, p]));
        // Fossil genus names often match something else (Daedalus, the Greek myth); skip pages whose
        // short description says they aren't about a living thing.
        const isTaxon = (p) => !p.description || TAXON_WORDS.test(p.description);
        const found = names.map((name) => ({ name, p: pages.get(resolve(name)) })).filter((x) => x.p && isTaxon(x.p));
        if (!found.length) return null;
        const toPage = (p) => ({
          title: p.title, description: p.description || "",
          content_urls: { desktop: { page: p.canonicalurl || p.fullurl } },
          thumbnail: p.thumbnail, originalimage: p.original,
        });
        const withImg = found.find((x) => x.p.thumbnail || x.p.original);
        return {
          name: found[0].name, page: toPage(found[0].p),
          image: withImg ? { name: withImg.name, page: toPage(withImg.p) } : null,
        };
      }).catch(() => { wikiCache.delete(cacheKey); return null; }));
    }
    return wikiCache.get(cacheKey);
  }

  async function vernacularFor(r) {
    const key = r.speciesKey || r.genusKey || r.acceptedTaxonKey || r.taxonKey;
    if (!key) return null;
    if (!vernacularCache.has(key)) {
      vernacularCache.set(key, fetchJSON(cached(`${GBIF}/species/${key}/vernacularNames?limit=50`))
        .then((j) => {
          const en = (j.results || []).find((v) => v.language === "eng");
          return en ? en.vernacularName : null;
        })
        .catch(() => null));
    }
    return vernacularCache.get(key);
  }

  function formatDate(r) {
    if (r.eventDate) {
      const d = r.eventDate.split("/")[0];
      const m = d.match(/^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?/);
      if (m) {
        const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
        return [m[3] && String(Number(m[3])), m[2] && months[Number(m[2]) - 1], m[1]].filter(Boolean).join(" ");
      }
      return r.eventDate;
    }
    return r.year ? String(r.year) : null;
  }

  function geoAge(r) {
    const parts = [r.earliestEpochOrLowestSeries, r.earliestPeriodOrLowestSystem, r.earliestEraOrLowestErathem].filter(Boolean);
    return parts.length ? parts.map((p) => p.replace(/([a-z])([A-Z])/g, "$1 $2")).join(", ") : null;
  }

  function ageChip(period) {
    if (!period) return "";
    const p = PERIOD_BY_ID[period];
    return `<span class="agechip" style="--c:${p.color}">${esc(p.id)}</span>`;
  }

  function precision(meters) {
    if (!meters) return null;
    return meters >= 1000 ? `within about ${Math.round(meters / 1000).toLocaleString()} km` : `within about ${Math.round(meters)} m`;
  }

  function fact(label, value, missingText) {
    return value
      ? `<dt>${label}</dt><dd>${value}</dd>`
      : `<dt>${label}</dt><dd class="missing">${missingText || "Not recorded"}</dd>`;
  }

  async function showRecord(key, backList) {
    const r = byKey.get(key);
    if (!r) return;
    clearSelection();
    state.selectedKey = key;
    map.setFilter("selected", ["==", ["get", "key"], key]);
    const cat = CAT_BY_ID[r._cat];
    const sci = r.acceptedScientificName || r.scientificName || "Unidentified specimen";
    const sciShort = r.species || r.genus || sci;

    const render = (extra) => {
      const { wiki, vernacular, imgHtml } = extra;
      // A Wikipedia title only counts as a common name when it isn't just one of the record's Latin taxon names.
      const latin = [sciShort, r.genus, r.family, r.order, r["class"], r.phylum].filter(Boolean);
      const wikiTitle = wiki && !latin.some((n) => wiki.page.title.toLowerCase().startsWith(n.toLowerCase())) ? wiki.page.title : null;
      const title = vernacular || wikiTitle || sciShort;
      const place = [r.locality, r.county, r.stateProvince, r.country].filter(Boolean).join(", ");
      const strat = [r.formation, r.group, r.member].filter(Boolean).join(" · ");
      const institution = r.catalogNumber && r.institutionCode && r.catalogNumber.startsWith(r.institutionCode)
        ? r.catalogNumber : [r.institutionCode, r.catalogNumber].filter(Boolean).join(" ");
      const lineage = [r.phylum, r["class"], r.order].filter(Boolean).join(" › ");

      panelBody.innerHTML = `
        ${imgHtml}
        <div class="panel-content">
          ${backList ? `<button type="button" class="leaf" id="back" style="padding:4px 0;width:auto">‹ Back to this site's list</button>` : ""}
          <div>
            <p class="eyebrow" style="color:${cat.color}">${esc(cat.label)} · Museum specimen</p>
            <h2 class="common">${esc(title)}</h2>
            <p class="sci">${esc(sci)}</p>
            ${wiki && wiki.page.description ? `<p class="wikidesc">${esc(wiki.page.description)}</p>` : ""}
          </div>
          <dl class="facts">
            ${fact("Family", r.family ? esc(r.family) : null)}
            ${fact("Date found", formatDate(r) ? esc(formatDate(r)) : null)}
            ${fact("Found by", r.recordedBy ? esc(r.recordedBy) : null)}
            ${fact("Age", geoAge(r) ? `${ageChip(r._period)} ${esc(geoAge(r))}` : null, "Not in this record")}
            ${strat ? fact("Rock unit", esc(strat)) : ""}
            ${fact("Where", place ? esc(place) : `${r.decimalLatitude.toFixed(3)}, ${r.decimalLongitude.toFixed(3)}`)}
            ${precision(r.coordinateUncertaintyInMeters) ? fact("Location", esc(precision(r.coordinateUncertaintyInMeters))) : ""}
            ${fact("Held by", institution ? esc(institution) : null)}
          </dl>
          ${lineage ? `<p class="lineage">${esc(lineage)}</p>` : ""}
          <div class="links">
            ${wiki ? `<a href="${esc(wiki.page.content_urls.desktop.page)}" target="_blank" rel="noopener">Wikipedia: ${esc(wiki.page.title)} ↗</a>` : ""}
            <a href="https://www.gbif.org/occurrence/${r.key}" target="_blank" rel="noopener">Full record on GBIF ↗</a>
          </div>
          <div class="collect" data-collect></div>
        </div>`;
      const back = $("back");
      if (back) back.addEventListener("click", () => showList(backList));
      wireImage();
      fillCollecting(r.decimalLongitude, r.decimalLatitude, r.countryCode, r.stateProvince, () => state.selectedKey === key);
    };

    const loadingImg = `<div class="noimg"><div style="width:70%;display:grid;gap:8px"><div class="skeleton"></div><div class="skeleton" style="width:60%"></div></div></div>`;
    render({ wiki: null, vernacular: null, imgHtml: r._photo.length ? specimenFigure(r._photo[0]) : loadingImg });
    openPanel();

    const [wiki, vernacular] = await Promise.all([wikiFor(r), vernacularFor(r)]);
    if (state.selectedKey !== key) return;
    let imgHtml;
    if (r._photo.length) imgHtml = specimenFigure(r._photo[0]);
    else if (wiki && wiki.image) imgHtml = referenceFigure(wiki.image);
    else imgHtml = `<div class="noimg">No photo of this specimen,<br>and no reference picture found for ${esc(sciShort)}.</div>`;
    render({ wiki, vernacular, imgHtml });
  }

  // ---------- research sites (PBDB collections) ----------
  async function showSite(no, backList) {
    const s = siteByNo.get(no);
    if (!s) return;
    clearSelection();
    const selKey = `site:${no}`;
    state.selectedKey = selKey;
    map.setFilter("site-selected", ["==", ["get", "no"], no]);

    const interval = [s.early_interval, s.late_interval].filter(Boolean).join(" to ");
    const age = interval ? `${ageChip(s._period)} ${esc(interval)} <span class="dim">(${maRange(s.max_ma, s.min_ma)})</span>` : null;
    const strat = [s.formation && `${s.formation} Formation`, s.geological_group && `${s.geological_group} Group`, s.member && `${s.member} Member`].filter(Boolean).join(" · ");
    const place = [s.state, s.cc].filter(Boolean).join(", ");
    const prec = [s.latlng_basis, s.geogscale && `${s.geogscale} scale`].filter(Boolean).join(", ");

    let taxaCount = 0;
    const render = (imgHtml, occHtml) => {
      panelBody.innerHTML = `
        ${imgHtml}
        <div class="panel-content">
          ${backList ? `<button type="button" class="leaf" id="back" style="padding:4px 0;width:auto">‹ Back to the list</button>` : ""}
          <div>
            <p class="eyebrow eyebrow-site">Research site · Paleobiology Database</p>
            <h2 class="common site-title">${esc(s.collection_name)}</h2>
            ${s.collection_aka ? `<p class="wikidesc">${esc(s.collection_aka)}</p>` : ""}
          </div>
          <dl class="facts">
            ${fact("Age", age)}
            ${fact("Rock unit", strat ? esc(strat) : null)}
            ${fact("Where", place ? esc(place) : `${s.lat.toFixed(3)}, ${s.lng.toFixed(3)}`)}
            ${prec ? fact("Location", esc(prec)) : ""}
            ${fact("Published in", s.primary_reference ? esc(s.primary_reference) : null)}
          </dl>
          <div>
            <p class="eyebrow">Fossils recorded here${taxaCount ? ` · ${taxaCount}` : ""}</p>
            ${occHtml}
          </div>
          <div class="links">
            <a href="https://paleobiodb.org/classic/displayCollResults?collection_no=${s.no}" target="_blank" rel="noopener">Site on PBDB ↗</a>
          </div>
          <div class="collect" data-collect></div>
        </div>`;
      const back = $("back");
      if (back) back.addEventListener("click", () => showSiteList(backList));
      fillCollecting(s.lng, s.lat, s.cc, s.state, () => state.selectedKey === selKey);
    };

    const loadingImg = `<div class="noimg"><div style="width:70%;display:grid;gap:8px"><div class="skeleton"></div><div class="skeleton" style="width:60%"></div></div></div>`;
    render(loadingImg, `<div class="skeleton"></div>`);
    openPanel();

    let occs = [];
    try {
      const j = await fetchJSON(cached(`${PBDB}/occs/list.json?coll_id=${no}&show=class&vocab=pbdb&limit=300`));
      occs = j.records || [];
    } catch (err) { console.error(err); }
    if (state.selectedKey !== selKey) return;

    const seen = new Set();
    const taxa = occs.map((o) => ({
      name: o.accepted_name || o.identified_name, rank: o.accepted_rank || o.identified_rank,
      genus: o.genus, family: o.family, order: o.order, "class": o["class"], phylum: o.phylum,
      _cat: categorize(o),
    })).filter((t) => t.name && !seen.has(t.name) && seen.add(t.name))
      .sort((a, b) => CATEGORIES.findIndex((c) => c.id === a._cat) - CATEGORIES.findIndex((c) => c.id === b._cat) || a.name.localeCompare(b.name));
    taxaCount = taxa.length;
    const occHtml = taxa.length
      ? `<ul class="taxa">${taxa.map((t) => `<li><span class="dot" style="background:${CAT_BY_ID[t._cat].color}"></span>
          <a href="https://en.wikipedia.org/wiki/Special:Search?search=${encodeURIComponent(t.genus || t.name)}" target="_blank" rel="noopener"><i>${esc(t.name)}</i></a>
          <small>${esc([t["class"], t.rank !== "species" ? t.rank : ""].filter(Boolean).join(" · "))}</small></li>`).join("")}</ul>`
      : `<p class="dim">The fossil list couldn't be loaded. It's on the PBDB page.</p>`;

    // Picture: the first listed fossil that Wikipedia has a picture for, labelled as a reference.
    let imgHtml = `<div class="noimg">No reference picture for this site.</div>`;
    const pick = taxa.find((t) => t.genus) || taxa[0];
    if (pick) {
      const wiki = await wikiFor({ species: pick.rank === "species" ? pick.name : null, genus: pick.genus, family: pick.family, order: pick.order, "class": pick["class"] });
      if (state.selectedKey !== selKey) return;
      if (wiki && wiki.image) imgHtml = referenceFigure(wiki.image, "one of the fossils recorded at this site");
    }
    render(imgHtml, occHtml);
  }

  const fmtMa = (n) => (Number.isFinite(n) ? (n >= 10 ? Math.round(n) : n.toFixed(1)) : "?");
  function maRange(max, min) {
    const a = fmtMa(max), b = fmtMa(min);
    return a === b ? `about ${a} million years ago` : `${a}–${b} million years ago`;
  }

  // ---------- "what's here": bedrock + collecting status for any spot ----------
  async function showPlace(lngLat) {
    clearSelection();
    const lng = Number(lngLat.lng.toFixed(3)), lat = Number(lngLat.lat.toFixed(3));
    const selKey = `place:${lng},${lat}`;
    state.selectedKey = selKey;
    const el = document.createElement("div");
    el.className = "place-pin";
    placeMarker = new maplibregl.Marker({ element: el }).setLngLat([lng, lat]).addTo(map);

    panelBody.innerHTML = `
      <div class="panel-content">
        <div>
          <p class="eyebrow">This spot · ${lat.toFixed(3)}, ${lng.toFixed(3)}</p>
          <h2 class="common">What rock is here?</h2>
        </div>
        <div data-rock><div class="skeleton"></div><div class="skeleton" style="width:60%;margin-top:8px"></div></div>
        <div class="collect" data-collect></div>
      </div>`;
    openPanel();
    fillCollecting(lng, lat, null, null, () => state.selectedKey === selKey);

    const z = Math.max(3, Math.min(12, Math.round(map.getZoom())));
    let unit = null, macro = null;
    try {
      const j = await fetchJSON(cached(`${MACROSTRAT}/mobile/map_query?lat=${lat}&lng=${lng}&z=${z}`));
      const d = (j.success && j.success.data) || {};
      unit = (d.burwell || [])[0] || null;
      macro = d.macrostrat || null;
    } catch (err) { console.error(err); }
    if (state.selectedKey !== selKey) return;
    const rockEl = panelBody.querySelector("[data-rock]");
    if (!rockEl) return;
    if (!unit) {
      rockEl.innerHTML = `<p class="dim">No bedrock map covers this spot (or Macrostrat didn't answer). Coverage is best in North America.</p>`;
      return;
    }
    const top = unit.t_age ?? (macro && macro.t_age) ?? unit.t_int_age, bottom = unit.b_age ?? (macro && macro.b_age) ?? unit.b_int_age;
    const period = periodFromMa(Number(bottom), Number(top)) || periodFromName(unit.b_int_name);
    const ages = unit.b_int_name === unit.t_int_name ? unit.b_int_name : `${unit.b_int_name} to ${unit.t_int_name}`;
    const lith = [unit.lith, unit.descrip, unit.comments].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join(". ");
    const ref = unit.ref || {};
    // Map units often list every formation they lump together; lead with the first.
    const names = (unit.strat_name || unit.name || "").split(/;\s*/).filter(Boolean);
    rockEl.innerHTML = `
      <div class="rock-head"><span class="rock-swatch" style="background:${esc(unit.color || "#777")}"></span>
        <div><h3>${esc(names[0] || "Unnamed unit")}</h3>${names.length > 1 ? `<p class="dim">with ${esc(names.slice(1).join(", "))}</p>` : ""}</div></div>
      <dl class="facts">
        ${fact("Age", `${ageChip(period)} ${esc(ages)}${Number.isFinite(Number(bottom)) ? ` <span class="dim">(${maRange(Number(bottom), Number(top))})</span>` : ""}`)}
        ${fact("Rock", lith ? esc(lith) : null)}
        ${fact("Mapped by", ref.name ? `${ref.url ? `<a href="${esc(ref.url)}" target="_blank" rel="noopener">${esc(ref.ref_title || ref.name)}</a>` : esc(ref.ref_title || ref.name)}${ref.ref_year ? ` (${esc(ref.ref_year)})` : ""}` : null)}
      </dl>
      ${period ? `<p class="hint">Fossils in this rock would be ${esc(period)} in age. <button type="button" class="linklike" data-filter-period="${period}">Show only ${esc(period)} finds</button></p>` : ""}`;
    const btn = rockEl.querySelector("[data-filter-period]");
    if (btn) btn.addEventListener("click", () => { state.period = btn.dataset.filterPeriod; renderTimebar(); writeHash(); loadView(); });
  }

  // ---------- collecting rules ----------
  // Short, general summaries. Not legal advice; every one ends by pointing to the local authority.
  const RULES = {
    US: { name: "United States", text: "On federal land, vertebrate fossils (bones, teeth, tracks) need a permit, under the Paleontological Resources Preservation Act. National parks and national monuments allow no collecting at all. On Bureau of Land Management and National Forest land you can usually collect a reasonable amount of common invertebrate and plant fossils for personal use. State land rules vary by state. On private land the fossils belong to the landowner, so ask first." },
    CA: { name: "Canada", text: "Fossil rules are set by each province. National and provincial parks allow no collecting. Private land needs the owner's permission.",
      regions: {
        alberta: "Alberta: all fossils belong to the Crown. You may pick up fossils from the surface on public land without a permit, but not dig for them, and they can't be sold or taken out of the province.",
        "british columbia": "British Columbia: significant fossils (vertebrates, rare or scientifically important specimens) are protected; sites like the Burgess Shale are off limits without a permit.",
        ontario: "Ontario: no collecting in provincial parks or conservation reserves. Road cuts and quarries need permission from whoever controls them.",
      } },
    GB: { name: "United Kingdom", text: "Collecting loose fossils on beaches and many public places is generally allowed. Sites of Special Scientific Interest can restrict hammering or digging. Follow the local fossil code (for example the West Dorset Fossil Collecting Code on the Jurassic Coast) and ask landowners first." },
  };
  const GENERAL_RULES = "Laws differ a lot between countries. Some (for example Argentina, Brazil, China and Mongolia) treat all fossils as state property and ban collecting or export. Wherever you are: never collect in a protected area without a permit, get the landowner's permission, and report anything unusual, especially bones, to a museum or university.";

  const STRICT_AREAS = /national park|provincial park|state park|nature reserve|wilderness|national monument|ecological reserve|conservation reserve/i;

  const placeCache = new Map();
  function protectedAt(lng, lat) {
    const k = `pa:${lng.toFixed(3)},${lat.toFixed(3)}`;
    if (!placeCache.has(k)) {
      const url = `${WDPA}/1/query?` + new URLSearchParams({
        geometry: `${lng.toFixed(3)},${lat.toFixed(3)}`, geometryType: "esriGeometryPoint", inSR: "4326",
        spatialRel: "esriSpatialRelIntersects", outFields: "name,desig_eng,iucn_cat,own_type", returnGeometry: "false", f: "json",
      });
      placeCache.set(k, fetchJSON(cached(url)).then((j) => (j.features || []).map((f) => f.attributes)).catch(() => { placeCache.delete(k); return null; }));
    }
    return placeCache.get(k);
  }
  function countryAt(lng, lat) {
    const k = `cc:${lng.toFixed(2)},${lat.toFixed(2)}`;
    if (!placeCache.has(k)) {
      const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=5&accept-language=en&lat=${lat.toFixed(2)}&lon=${lng.toFixed(2)}`;
      placeCache.set(k, fetchJSON(cached(url)).then((j) => j.address ? { cc: (j.address.country_code || "").toUpperCase(), region: j.address.state || "" } : null).catch(() => null));
    }
    return placeCache.get(k);
  }

  function rulesFor(cc, region) {
    const r = RULES[(cc || "").toUpperCase()];
    if (!r) return `<p>${esc(GENERAL_RULES)}</p>`;
    const regionText = r.regions && region ? r.regions[region.toLowerCase()] : null;
    return `<p><strong>${esc(r.name)}.</strong> ${esc(r.text)}</p>${regionText ? `<p>${esc(regionText)}</p>` : ""}`;
  }

  async function fillCollecting(lng, lat, cc, region, stillCurrent) {
    const box = () => panelBody.querySelector("[data-collect]");
    if (!box()) return;
    box().innerHTML = `<p class="eyebrow">Can I collect here?</p><div class="skeleton"></div>`;
    const [areas, where] = await Promise.all([protectedAt(lng, lat), cc ? Promise.resolve({ cc, region }) : countryAt(lng, lat)]);
    if (!stillCurrent() || !box()) return;
    let status;
    if (areas && areas.length) {
      const names = areas.slice(0, 3).map((a) => `${esc(a.name)} <span class="dim">(${esc(a.desig_eng)})</span>`).join("<br>");
      // Parks and reserves ban collecting; landscape designations (e.g. a UK AONB, IUCN category V) often don't.
      const strict = areas.some((a) => ["Ia", "Ib", "II", "III"].includes(a.iucn_cat) || STRICT_AREAS.test(a.desig_eng || ""));
      status = strict
        ? `<p class="verdict no"><strong>Inside a park or reserve.</strong> Collecting is almost certainly not allowed without a permit.<br>${names}</p>`
        : `<p class="verdict maybe"><strong>Inside a protected landscape.</strong> Collecting may be restricted here; check the area's rules.<br>${names}</p>`;
    } else if (areas) {
      status = `<p class="verdict maybe"><strong>Not in a mapped protected area.</strong> That doesn't make it legal: the land may be private or have other rules.</p>`;
    } else {
      status = `<p class="verdict maybe">Protected-area check unavailable right now.</p>`;
    }
    box().innerHTML = `<p class="eyebrow">Can I collect here?</p>${status}${rulesFor(where && where.cc, where && where.region)}
      <p class="dim small">General guidance, not legal advice. Check with the local land manager before collecting.</p>`;
  }

  function showRules() {
    clearSelection();
    panelBody.innerHTML = `
      <div class="panel-content">
        <div>
          <p class="eyebrow">Before you go</p>
          <h2 class="common">Collecting rules</h2>
          <p class="wikidesc">A spot on this map means a fossil was found there, not that you may collect there. Turn on <em>Protected areas</em> to see parks and reserves, or tap any spot to check it.</p>
        </div>
        <div class="collect">
          ${Object.values(RULES).map((r) => `<p><strong>${esc(r.name)}.</strong> ${esc(r.text)}</p>${r.regions ? Object.values(r.regions).map((t) => `<p>${esc(t)}</p>`).join("") : ""}`).join("")}
          <p><strong>Everywhere else.</strong> ${esc(GENERAL_RULES)}</p>
          <p class="dim small">General guidance, not legal advice.</p>
        </div>
      </div>`;
    openPanel();
  }
  $("rules").addEventListener("click", showRules);

  function specimenFigure(p) {
    const credit = [p.credit, shortLicense(p.license)].filter(Boolean).join(" · ");
    return `<figure class="figure">
      <img alt="Photo of this specimen" src="${esc(p.src)}" data-fallback="${esc(p.direct || "")}">
      <figcaption><span class="badge specimen">This specimen</span><span>${esc(credit)}</span></figcaption>
    </figure>`;
  }

  function referenceFigure(wiki, what) {
    const img = wiki.page.thumbnail || wiki.page.originalimage;
    return `<figure class="figure">
      <img alt="Reference picture of ${esc(wiki.page.title)} from Wikipedia" src="${esc(img.source)}">
      <figcaption><span class="badge reference">Reference</span><span>Picture of ${esc(wiki.name)} from Wikipedia, ${what ? esc(what) : "not this specimen"}</span></figcaption>
    </figure>`;
  }

  function shortLicense(l) {
    if (!l) return "";
    const m = l.match(/licenses\/([a-z\-]+)\/([\d.]+)/i);
    if (m) return `CC ${m[1].toUpperCase()} ${m[2]}`;
    if (/publicdomain/i.test(l)) return "Public domain";
    return l.length > 30 ? "" : l;
  }

  function wireImage() {
    const img = panelBody.querySelector(".figure img[data-fallback]");
    if (!img) return;
    img.addEventListener("error", async function onErr() {
      const fb = img.dataset.fallback;
      if (fb && img.src !== fb) { img.src = fb; return; }
      img.removeEventListener("error", onErr);
      // Specimen photo failed entirely: fall back to a reference picture.
      const r = byKey.get(state.selectedKey);
      const wiki = r && (await wikiFor(r));
      const fig = img.closest(".figure");
      if (!fig) return;
      if (wiki && wiki.image) fig.outerHTML = referenceFigure(wiki.image);
      else fig.outerHTML = `<div class="noimg">The specimen photo could not be loaded.</div>`;
    });
  }

  // ---------- controls ----------
  $("photos-only").checked = state.photosOnly;
  $("photos-only").addEventListener("change", (e) => {
    state.photosOnly = e.target.checked;
    writeHash();
    loadView();
  });

  for (const [id, key] of [["layer-gbif", "gbif"], ["layer-pbdb", "pbdb"], ["layer-geo", "geo"], ["layer-pa", "pa"]]) {
    const box = $(id);
    box.checked = state.layers[key];
    box.addEventListener("change", () => {
      state.layers[key] = box.checked;
      if (key === "geo" || key === "pa") {
        const layer = key === "geo" ? "geology" : "protected";
        if (map.getLayer(layer)) map.setLayoutProperty(layer, "visibility", box.checked ? "visible" : "none");
      } else {
        renderTaxonBox();
        loadView();
      }
      writeHash();
    });
  }

  const segButtons = document.querySelectorAll(".seg [data-color]");
  const renderSeg = () => segButtons.forEach((b) => b.setAttribute("aria-checked", String(b.dataset.color === state.colorBy)));
  segButtons.forEach((b) => b.addEventListener("click", () => {
    state.colorBy = b.dataset.color;
    renderSeg(); renderLegend(); pushData(); writeHash();
  }));
  renderSeg();

  const tourSelect = $("tour");
  tourSelect.insertAdjacentHTML("beforeend", TOURS.map((t) => `<option value="${t.id}">${esc(t.label)}</option>`).join(""));
  tourSelect.addEventListener("change", () => {
    const t = TOURS.find((x) => x.id === tourSelect.value);
    tourSelect.value = "";
    if (!t) return;
    closePanel();
    state.period = t.period || null;
    renderTimebar();
    const taxon = t.taxon || null;
    if ((taxon && taxon.name) !== (state.taxon && state.taxon.name)) setTaxon(taxon); // reloads when ready
    const opts = { center: t.center, zoom: t.zoom, speed: 1.2, curve: 1.5, essential: true };
    if (reduceMotion) opts.duration = 0;
    map.flyTo(opts);
  });

  $("share").addEventListener("click", async () => {
    writeHash();
    await new Promise((ok) => setTimeout(ok, 300));
    const btn = $("share");
    try {
      await navigator.clipboard.writeText(location.href);
      btn.textContent = "Link copied";
    } catch (err) {
      window.prompt("Copy this link:", location.href);
    }
    setTimeout(() => { btn.textContent = "Copy link"; }, 2000);
  });

  $("search").addEventListener("submit", async (e) => {
    e.preventDefault();
    const q = $("search-input").value.trim();
    if (!q) return;
    setStatus(`Searching for “${esc(q)}”…`);
    try {
      const res = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=${encodeURIComponent(q)}`, { headers: { "Accept-Language": "en" } });
      const [hit] = await res.json();
      if (!hit) { setStatus(`No place called “${esc(q)}” found. Try a town, park or region.`); return; }
      const [s, n, w, ea] = hit.boundingbox.map(Number);
      map.fitBounds([[w, s], [ea, n]], { padding: 40, maxZoom: 11, minZoom: POINTS_MIN_ZOOM + 1, duration: reduceMotion ? 0 : 2500 });
    } catch (err) {
      setStatus("Place search is unavailable right now. Pan and zoom the map instead.");
    }
  });

  // On phones the filter card folds down to the status line so the map stays visible.
  const controls = document.querySelector(".controls");
  if (window.matchMedia("(max-width: 720px)").matches) controls.classList.add("collapsed");
  $("filters-toggle").addEventListener("click", () => {
    const open = controls.classList.toggle("collapsed") === false;
    $("filters-toggle").setAttribute("aria-expanded", String(open));
    $("filters-toggle").textContent = open ? "Hide filters" : "Filters";
  });

  renderLegend();
  renderTaxonBox();

  // Shared with finds.js (amateur find logging).
  window.FossilTrace = {
    map, cached, fetchJSON, esc, fact, ageChip, periodFromMa, periodFromName, maRange, CLICK_LAYERS,
    openPanel, closePanel, clearSelection, fillCollecting, panelBody, setStatus,
    select(key) { clearSelection(); state.selectedKey = key; },
    isSelected: (key) => state.selectedKey === key,
  };
  document.dispatchEvent(new Event("fossiltrace:ready"));
})();
