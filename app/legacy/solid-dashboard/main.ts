import * as maplibregl from "maplibre-gl";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
maplibregl.setWorkerUrl(workerUrl);
import "maplibre-gl/dist/maplibre-gl.css";
import "./style.css";
import { createClient } from "@mudskipper/core/client";
import { detectability } from "@mudskipper/core";

const client =
  import.meta.env.VITE_DATA_SOURCE === "fixtures"
    ? createClient({
        source: "fixtures",
        load: (await import("@mudskipper/core/fixtures-vite"))
          .viteFixtureLoader,
      })
    : createClient({
        source: "api",
        baseUrl:
          import.meta.env.VITE_API_BASE_URL ||
          "https://mudskipper-nisar.pages.dev",
      });
const root = document.querySelector<HTMLDivElement>("#app")!;
type Data = Awaited<ReturnType<typeof loadData>>;
let data: Data,
  map: maplibregl.Map | undefined,
  field: any = null,
  selected = "",
  fieldError = "",
  request = 0,
  auditRequest = 0,
  playTimer: number | undefined,
  tourTimers: number[] = [];
let route = location.pathname,
  tile = new URLSearchParams(location.search).get("tile") || "",
  layer = new URLSearchParams(location.search).get("layer") || "pass",
  pass = 0,
  playing = false;
let perspective = false,
  radar = false;
let overlayIndex: Awaited<ReturnType<typeof client.getOverlaysIndex>> = null;
let overlayStatus = "Loading";
const esc = (v: unknown) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
const tag = (kind: string, source: string) =>
  `<span class="tag ${kind.toLowerCase()}" title="${esc(source)}">${kind[0] + kind.slice(1).toLowerCase()}</span>`;
const date = (s: string) =>
  new Date(s).toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
const icon = (name: string) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${({ play: '<path d="m8 5 11 7-11 7z"/>', pause: '<path d="M8 5v14M16 5v14"/>', close: '<path d="M6 6l12 12M18 6 6 18"/>', search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.5 15.5 4 4"/>', reset: '<path d="M4 11a8 8 0 1 1 2 5.3M4 5v6h6"/>', external: '<path d="M7 17 17 7M8 7h9v9"/>' } as Record<string, string>)[name] || ""}</svg>`;
const pct = (n: number) => `${Math.round(n * 100)}%`;
const words = (s: string) => {
  const value = s.replaceAll("_", " ");
  return value[0].toUpperCase() + value.slice(1);
};
const evidence = (
  text: unknown,
  kind = "INFERRED",
  source = "Current run data",
) => `${esc(text)} ${tag(kind, source)}`;
async function loadData() {
  const [meta, story, passes, states, geo, sim] = await Promise.all([
    client.getMeta(),
    client.getStory(),
    client.getPasses(),
    client.getStates(),
    client.getFieldsGeoJson(),
    client.getDetectability(),
  ]);
  const rows = [];
  let page: number | null = 1;
  while (page !== null) {
    const p = await client.getFields({ page });
    if (p.run_id !== meta.run_id || p.fixture !== meta.fixture)
      throw new Error("The field pages belong to a different run.");
    rows.push(...p.fields);
    page = p.next_page;
  }
  const ids = [
    story.run_id,
    passes.run_id,
    states.run_id,
    geo.run_id,
    sim.run_id,
  ];
  if (
    ids.some((id) => id !== meta.run_id) ||
    [story.fixture, passes.fixture, states.fixture, sim.fixture].some(
      (f) => f !== meta.fixture,
    ) ||
    Boolean(geo.fixture) !== meta.fixture
  )
    throw new Error(
      "The data service returned mixed runs. Retry when publishing is complete.",
    );
  return { meta, story, passes, states, geo, sim, rows };
}
function query(push = true) {
  if (route.startsWith("/field/"))
    route = selected ? `/field/${encodeURIComponent(selected)}` : "/map";
  const q = new URLSearchParams(location.search);
  q.set("tile", tile);
  q.set("layer", layer);
  if (data?.states.pass_ids[pass]) q.set("pass", data.states.pass_ids[pass]);
  if (selected) q.set("field", selected);
  else q.delete("field");
  const url = `${route}?${q}`;
  history[push ? "pushState" : "replaceState"]({}, "", url);
}
function navigate(path: string) {
  route = path;
  request++;
  auditRequest++;
  if (path.startsWith("/field/")) selected = decodeURIComponent(path.slice(7));
  query();
  render();
  window.scrollTo(0, 0);
}
function shell(content: string) {
  const mapView =
    route === "/" || route === "/map" || route.startsWith("/field/");
  return `<div class="shell ${mapView ? "map-view" : "content-view"}"><header class="top"><a href="/" data-nav="/" class="brand">MUDSKIPPER<span>Field intelligence</span></a><nav aria-label="Main navigation"><a data-nav="/" class="${mapView ? "active" : ""}" href="/">Explore</a><a data-nav="/lab" class="${route === "/lab" ? "active" : ""}" href="/lab">Lab</a><a data-nav="/scarecrow" class="${route === "/scarecrow" ? "active" : ""}" href="/scarecrow">Inspection</a><a data-nav="/evidence" class="${route === "/evidence" ? "active" : ""}" href="/evidence">Evidence</a></nav><div class="topright">${data.meta.fixture ? '<span class="sample">Sample run</span>' : ""}<a href="/methods" data-nav="/methods">Methods</a></div></header><main>${content}</main>${new URLSearchParams(location.search).has("tour") ? '<button class="exit-tour" id="exit-tour">Exit tour</button>' : ""}</div>`;
}
function heading(_kicker: string, title: string, text: string) {
  return `<div class="page-head"><div><h1>${esc(title.replace(/\.$/, ""))}</h1><p>${esc(text.replace(/\.$/, ""))}</p></div><div class="page-index">Run / ${esc(data.meta.run_id)}</div></div>`;
}
function mapPage() {
  const tileInfo = data.meta.tiles.find((t) => t.id === tile);
  return `<section class="explorer"><div class="explorer-head"><div><span class="eyebrow">Punjab, India</span><h1>Field intelligence</h1></div><div class="run-summary"><span>Kharif ${esc(data.meta.season.start.slice(0, 4))}</span><span>${data.rows.length} fields</span><span>${data.states.pass_ids.length} passes</span><button id="start-tour" class="button light">Start tour</button></div></div><div class="map-layout"><div class="map-area"><div class="toolbar"><label class="sr-only" for="district">Study area</label><select id="district">${data.meta.tiles.map((t) => `<option value="${esc(t.id)}" ${tile === t.id ? "selected" : ""}>${esc(t.district)}</option>`).join("")}</select><div class="segmented" aria-label="Map layer"><button data-layer="pass" aria-pressed="${layer === "pass"}" class="${layer === "pass" ? "on" : ""}">Model state</button><button data-layer="season" aria-pressed="${layer === "season"}" class="${layer === "season" ? "on" : ""}">Season</button></div><button id="radar-toggle" class="radar-toggle" aria-pressed="false" title="Radar image for this pass">Radar</button><div class="camera-controls"><button id="camera-toggle" aria-label="${perspective ? "Enable flat view" : "Enable perspective view"}" aria-pressed="${perspective}" title="${perspective ? "Flat view" : "Perspective view"}">${perspective ? "2D" : "3D"}</button><button id="camera-reset" aria-label="Reset map view" title="Reset map view">${icon("reset")}</button></div></div><div class="map-frame"><div id="map" aria-label="Interactive map of study fields"></div><div class="map-context"><span>Study area</span><strong>${esc(tileInfo?.district || tile)}</strong></div><div class="map-source"><span id="coords"></span></div></div><div class="map-key" id="map-key"></div><div class="timeline"><button id="play" class="play" aria-label="Play season">${icon("play")}</button><div class="timeline-left"><span class="eyebrow">Selected pass</span><strong id="pass-date"></strong><span id="pass-id"></span></div><div class="track-wrap"><div class="track" id="track"></div><div class="track-labels"><span>${esc(date(data.meta.season.start))}</span><span>Acquisition dates</span><span>${esc(date(data.meta.season.end))}</span></div></div></div></div><aside class="inspector" id="inspector"></aside></div></section>`;
}
function fieldHTML() {
  if (!selected)
    return `<div class="inspector-head"><span class="eyebrow">Field inspector</span></div><h3>Select a field</h3><p>Select a boundary on the map or enter an ID</p><form id="search"><label class="sr-only" for="search-id">Field ID</label><div class="search"><input id="search-id" placeholder="Search field ID" required><button aria-label="Find field">${icon("search")}</button></div></form><div class="browse-fields"><div class="browse-head"><span>Fields in this area</span><span>${data.rows.filter((r) => r.tile === tile).length}</span></div>${data.rows
      .filter((r) => r.tile === tile)
      .slice(0, 8)
      .map(
        (r) =>
          `<button class="field-row" data-field-id="${esc(r.field_id)}"><span>${esc(r.field_id)}</span><span>${Number(r.area_ha).toFixed(2)} ha</span></button>`,
      )
      .join(
        "",
      )}<p class="browse-note">Showing 8 fields · search by ID for more</p></div>`;
  if (fieldError)
    return `<div class="inspector-head"><span class="eyebrow">Field inspector</span><button id="close-field" aria-label="Close field">${icon("close")}</button></div><h3>Field unavailable</h3><p role="alert">${esc(fieldError)}</p><button class="button primary" id="retry-field">Retry field</button>`;
  if (!field)
    return `<div class="inspector-head"><span class="eyebrow">Field inspector</span><button id="close-field" aria-label="Close field">${icon("close")}</button></div><p>Loading field evidence</p>`;
  const s = field.summary,
    o = field.observations.find(
      (x: any) => x.pass_id === data.states.pass_ids[pass],
    );
  const measurement = (v: unknown) =>
    v === null || v === undefined ? "Unavailable" : `${esc(v)} dB`;
  return `<div class="inspector-head"><span class="eyebrow">Selected field</span><button id="close-field" aria-label="Close field">${icon("close")}</button></div><div class="field-title"><div><h3>${esc(selected)}</h3><p>${esc(field.field.properties.district)} / ${Number(field.field.properties.area_ha).toFixed(2)} ha</p></div><span class="selected-marker" aria-label="Selected field"></span></div><div class="field-state"><div><span>Model state</span><strong>${esc(o?.inferred.state || "No observation")}</strong></div><span class="state-date">${o ? esc(date(o.datetime)) : "No observation"}</span></div><div class="telemetry"><div><span>Model probability</span><b>${o?.inferred.p_flooded == null ? "Unavailable" : pct(o.inferred.p_flooded)}</b><small>Flooded</small></div><div><span>Clear looks</span><b>${s?.awd.clear_looks ?? "Unavailable"}</b><small>Season</small></div></div><div class="detail-row"><span>Season assessment</span><b>${esc(s ? words(s.awd.verdict) : "Unavailable")}</b><p>${esc(s?.awd.reason || "")}</p></div><div class="detail-row"><span>DSR signal</span><b>${esc(s ? words(s.dsr.signal) : "Unavailable")}</b><p>${esc(s?.dsr.reason || "")}</p></div><div class="detail-row"><span>Pass history</span><div class="chips">${field.observations.map((x: any) => `<button class="chip ${esc(x.inferred.state)} ${x.pass_id === data.states.pass_ids[pass] ? "current" : ""}" data-pass-id="${esc(x.pass_id)}" aria-label="${esc(date(x.datetime) + " " + x.inferred.state)}" title="${esc(date(x.datetime) + " / " + x.inferred.state)}">${esc(x.inferred.state[0].toUpperCase())}</button>`).join("")}</div><p>F flooded / D drained / U uncertain</p></div><details class="field-details"><summary>Radar and model details</summary><div class="measurement-grid"><span>HH</span><b>${measurement(o?.observed.hh_db)}</b><span>HV</span><b>${measurement(o?.observed.hv_db)}</b><span>Surface (Ps)</span><b>${measurement(o?.observed.ps_db)}</b><span>Double bounce (Pd)</span><b>${measurement(o?.observed.pd_db)}</b><span>Volume (Pv)</span><b>${measurement(o?.observed.pv_db)}</b><span>Classifier</span><b>${esc(o?.inferred.method || "Unavailable")}</b><span>Flags</span><b>${esc(o?.flags?.length ? o.flags.join(", ") : "None reported")}</b><span>Boundary</span><b>${esc(field.field.properties.source)}</b></div><p>Radar measurements are observed; states and model probability are inferred.</p></details>`;
}
function updateInspector() {
  const el = document.querySelector("#inspector");
  if (!el) return;
  const detailsOpen = el.querySelector("details")?.open ?? false;
  el.classList.toggle("has-field", !!selected);
  el.innerHTML = fieldHTML();
  const details = el.querySelector("details");
  if (details) details.open = detailsOpen;
  bindLocal();
}
async function choose(id: string, push = true) {
  stopPlayback();
  selected = id;
  field = null;
  fieldError = "";
  const seq = ++request;
  query(push);
  updateInspector();
  updateMap();
  try {
    const f = await client.getField(id);
    if (seq !== request) return;
    if (f.run_id !== data.meta.run_id || f.fixture !== data.meta.fixture)
      throw new Error("Field belongs to a different run.");
    field = f;
    const row = data.rows.find((r) => r.field_id === id);
    if (row && tile !== row.tile) {
      tile = row.tile;
      query(false);
      fitTile();
    }
    updateInspector();
    updateMap();
  } catch (e) {
    if (seq === request) {
      fieldError = e instanceof Error ? e.message : String(e);
      updateInspector();
    }
  }
}
function features() {
  const idx = new Map(data.states.field_ids.map((id, i) => [id, i]));
  const rows = new Map(data.rows.map((r) => [r.field_id, r]));
  return {
    ...data.geo,
    features: data.geo.features
      .filter((f) => f.properties.tile === tile)
      .map((f) => {
        const i = idx.get(f.properties.field_id);
        const row = rows.get(f.properties.field_id);
        return {
          ...f,
          properties: {
            ...f.properties,
            code: i === undefined ? "-" : data.states.states[i]?.[pass] || "-",
            verdict: row?.awd_verdict || "none",
            selected: f.properties.field_id === selected,
          },
        };
      }),
  };
}
function updateMap() {
  const district = document.querySelector<HTMLSelectElement>("#district");
  if (district) district.value = tile;
  const context = document.querySelector(".map-context strong");
  if (context)
    context.textContent =
      data.meta.tiles.find((t) => t.id === tile)?.district || tile;
  if (!map?.getSource("fields")) return;
  (map.getSource("fields") as maplibregl.GeoJSONSource).setData(
    features() as any,
  );
  const color =
    layer === "pass"
      ? [
          "match",
          ["get", "code"],
          "F",
          "#b49bdd",
          "D",
          "#d6c65c",
          "U",
          "#bec5b8",
          "#8b9386",
        ]
      : [
          "match",
          ["get", "verdict"],
          "consistent",
          "#b49bdd",
          "inconsistent",
          "#d6c65c",
          "not_enough_evidence",
          "#bec5b8",
          "#8b9386",
        ];
  map.setPaintProperty("fill", "fill-color", color as any);
  map.setPaintProperty("outline", "line-color", color as any);
  map.setFilter(
    "uncertainty",
    layer === "pass"
      ? ["==", ["get", "code"], "U"]
      : ["==", ["get", "verdict"], "not_enough_evidence"],
  );
  updateRadar();
  updateTimeline();
}
function updateRadar() {
  const status = document.querySelector("#overlay-status");
  if (status) status.textContent = overlayStatus;
  const item = overlayIndex?.overlays.find(
    (o) => o.tile === tile && o.pass_id === data.states.pass_ids[pass],
  );
  const button = document.querySelector<HTMLButtonElement>("#radar-toggle");
  if (button) {
    button.disabled = !item;
    button.classList.toggle("on", Boolean(item && radar));
    button.setAttribute("aria-pressed", String(Boolean(item && radar)));
    button.title = item
      ? "Toggle radar image for this pass"
      : "No radar image for this pass";
  }
  if (!map?.getLayer("fill")) return;
  if (map.getLayer("radar-image")) map.removeLayer("radar-image");
  if (map.getSource("radar-image")) map.removeSource("radar-image");
  if (!item || !radar || !data.meta.assets.overlays_index) return;
  const base =
    import.meta.env.VITE_API_BASE_URL || "https://mudskipper-nisar.pages.dev";
  const indexUrl = new URL(data.meta.assets.overlays_index, base);
  const runUrl = new URL("../", indexUrl);
  const url = new URL(item.url, runUrl).href;
  map.addSource("radar-image", {
    type: "image",
    url,
    coordinates: item.coordinates as [
      [number, number],
      [number, number],
      [number, number],
      [number, number],
    ],
  });
  map.addLayer(
    {
      id: "radar-image",
      type: "raster",
      source: "radar-image",
      paint: { "raster-opacity": 0.8 },
    },
    "fill",
  );
}
async function loadOverlays() {
  try {
    const result = await client.getOverlaysIndex();
    if (
      result &&
      (result.run_id !== data.meta.run_id ||
        Boolean(result.fixture) !== data.meta.fixture)
    )
      throw new Error("Overlay index belongs to a different run");
    overlayIndex = result;
    overlayStatus = result
      ? `${result.overlays.length} indexed images`
      : "No index available";
  } catch {
    overlayIndex = null;
    overlayStatus = "Index unavailable";
  }
  updateRadar();
}
function fitTile() {
  const t = data.meta.tiles.find((t) => t.id === tile);
  if (!t || !map) return;
  const bounds = new maplibregl.LngLatBounds();
  const addCoordinates = (coordinates: unknown): void => {
    if (!Array.isArray(coordinates)) return;
    if (
      coordinates.length >= 2 &&
      typeof coordinates[0] === "number" &&
      typeof coordinates[1] === "number"
    )
      bounds.extend([coordinates[0], coordinates[1]]);
    else coordinates.forEach(addCoordinates);
  };
  data.geo.features
    .filter((f) => f.properties.tile === tile)
    .forEach((f) => addCoordinates(f.geometry.coordinates));
  const target = bounds.isEmpty()
    ? new maplibregl.LngLatBounds(
        [t.bbox[0], t.bbox[1]],
        [t.bbox[2], t.bbox[3]],
      )
    : bounds;
  map.fitBounds(target, {
    padding: matchMedia("(max-width: 700px)").matches ? 28 : 64,
    duration: matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 600,
    maxZoom: 16,
    bearing: perspective ? -15 : 0,
    pitch: perspective ? 40 : 0,
  });
}
function initMap() {
  const t = data.meta.tiles.find((t) => t.id === tile)!;
  map = new maplibregl.Map({
    container: "map",
    style: {
      version: 8,
      sources: {
        imagery: {
          type: "raster",
          tiles: [
            import.meta.env.VITE_BASEMAP_URL ||
              "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
          ],
          tileSize: 256,
          attribution: "Tiles © Esri and contributors",
        },
      },
      layers: [
        {
          id: "background",
          type: "background",
          paint: { "background-color": "#30263a" },
        },
        {
          id: "imagery",
          type: "raster",
          source: "imagery",
          paint: {
            "raster-saturation": -0.2,
            "raster-brightness-max": 0.88,
            "raster-contrast": 0.06,
          },
        },
      ],
    },
    center: [(t.bbox[0] + t.bbox[2]) / 2, (t.bbox[1] + t.bbox[3]) / 2],
    zoom: 11,
    attributionControl: { compact: true },
    pitch: perspective ? 40 : 0,
    bearing: perspective ? -15 : 0,
  });
  map.addControl(
    new maplibregl.NavigationControl({ showCompass: false }),
    "bottom-right",
  );
  map.on("load", () => {
    map!.addSource("fields", { type: "geojson", data: features() as any });
    map!.addLayer({
      id: "fill",
      type: "fill",
      source: "fields",
      paint: {
        "fill-color": "#b49bdd",
        "fill-opacity": ["case", ["get", "selected"], 0.28, 0.13],
      },
    });
    map!.addLayer({
      id: "outline",
      type: "line",
      source: "fields",
      paint: {
        "line-color": [
          "match",
          ["get", "code"],
          "F",
          "#b49bdd",
          "D",
          "#ded17a",
          "#d3d3cc",
        ],
        "line-width": 1,
        "line-opacity": 0.8,
      },
    });
    const hatch = new Uint8Array(8 * 8 * 4);
    for (let y = 0; y < 8; y++)
      for (let x = 0; x < 8; x++) {
        if ((x + y) % 8 < 2) hatch.set([230, 232, 220, 160], (y * 8 + x) * 4);
      }
    map!.addImage("uncertain-hatch", { width: 8, height: 8, data: hatch });
    map!.addLayer({
      id: "uncertainty",
      type: "fill",
      source: "fields",
      filter: ["==", ["get", "code"], "U"],
      paint: { "fill-pattern": "uncertain-hatch", "fill-opacity": 0.45 },
    });
    map!.addLayer({
      id: "selected",
      type: "line",
      source: "fields",
      filter: ["==", ["get", "selected"], true],
      paint: { "line-color": "#e35e52", "line-width": 3 },
    });
    updateMap();
    fitTile();
  });
  map.on("click", "fill", (e) => {
    const id = e.features?.[0]?.properties?.field_id;
    if (id) void choose(String(id));
  });
  map.on("mouseenter", "fill", () => {
    map!.getCanvas().style.cursor = "pointer";
  });
  map.on("mouseleave", "fill", () => {
    map!.getCanvas().style.cursor = "";
  });
  map.on("move", () => {
    const c = map!.getCenter();
    const el = document.querySelector("#coords");
    if (el)
      el.textContent = `${c.lat.toFixed(4)}° N  /  ${c.lng.toFixed(4)}° E`;
  });
}
function updateTimeline() {
  const d = document.querySelector("#pass-date"),
    id = document.querySelector("#pass-id"),
    track = document.querySelector("#track"),
    key = document.querySelector("#map-key");
  if (!d || !id || !track || !key) return;
  const current = data.passes.passes.find(
    (p) => p.pass_id === data.states.pass_ids[pass],
  );
  d.textContent = current ? date(current.datetime) : "No pass";
  id.textContent = current?.pass_id || "";
  const start = Date.parse(data.meta.season.start),
    end = Date.parse(data.meta.season.end),
    pos = (x: string) =>
      Math.max(
        0,
        Math.min(100, (100 * (Date.parse(x) - start)) / (end - start)),
      );
  track.innerHTML = `<div class="track-line"></div>${data.meta.gaps.map((g) => `<div class="gap" style="left:${pos(g.start)}%;width:${pos(g.end) - pos(g.start)}%" title="No data: ${esc(date(g.start))}–${esc(date(g.end))}"><span>No data</span></div>`).join("")}${data.states.pass_ids
    .map((p, i) => {
      const x = data.passes.passes.find((v) => v.pass_id === p);
      return x
        ? `<button class="tick ${i === pass ? "current" : ""}" style="left:${pos(x.datetime)}%" data-pass="${i}" aria-label="${esc(date(x.datetime))}" title="${esc(date(x.datetime))}"></button>`
        : "";
    })
    .join("")}`;
  const count: Record<string, number> = {};
  features().features.forEach((f) => {
    const k = layer === "pass" ? f.properties.code : f.properties.verdict;
    count[k] = (count[k] || 0) + 1;
  });
  const items =
    layer === "pass"
      ? [
          ["F", "Flooded"],
          ["D", "Drained"],
          ["U", "Uncertain"],
          ["-", "No observation"],
        ]
      : [
          ["consistent", "Consistent"],
          ["inconsistent", "Not consistent"],
          ["not_enough_evidence", "Not enough evidence"],
          ["none", "No summary"],
        ];
  key.innerHTML = `<div class="key-title">${layer === "pass" ? "Model state" : "Season assessment"} </div>${items.map(([k, v], i) => `<span><i class="swatch s${i}"></i>${v} <b>${count[k] || 0}</b></span>`).join("")}`;
  bindLocal();
}
function setPass(i: number, push = true) {
  if (push) stopPlayback();
  pass = Math.max(0, Math.min(i, data.states.pass_ids.length - 1));
  query(push);
  updateMap();
  if (selected) updateInspector();
}
function stopPlayback() {
  if (playing) togglePlay();
}
function togglePlay() {
  playing = !playing;
  const btn = document.querySelector<HTMLButtonElement>("#play");
  if (btn) {
    btn.innerHTML = icon(playing ? "pause" : "play");
    btn.setAttribute("aria-label", playing ? "Pause season" : "Play season");
  }
  if (playing) step();
  else clearTimeout(playTimer);
}
function step() {
  if (!playing) return;
  const next = (pass + 1) % data.states.pass_ids.length;
  const a = data.passes.passes.find(
    (p) => p.pass_id === data.states.pass_ids[pass],
  );
  const b = data.passes.passes.find(
    (p) => p.pass_id === data.states.pass_ids[next],
  );
  const gap =
    a &&
    b &&
    data.meta.gaps.some(
      (g) =>
        Date.parse(a.datetime) < Date.parse(g.start) &&
        Date.parse(b.datetime) > Date.parse(g.end),
    );
  playTimer = window.setTimeout(
    () => {
      setPass(next, false);
      step();
    },
    gap ? 1600 : 600,
  );
}
function labPage() {
  return `${heading("02 / DETECTABILITY LAB", "Detectability lab", "Explore the pass schedule under different assumptions.")}<div class="lab-grid"><div class="panel controls"><div class="eyebrow">Model inputs ${tag("ASSUMED", "detectability.json · param_sources")}</div><h2>Simulation parameters</h2><p>Inputs are applied to the current pass dates and fixed simulation seed.</p><label>Drainage cycle <output id="cycle-value"></output><input type="range" id="cycle" min="4" max="14" step="1" value="${data.sim.params.cycle_days[1]}"></label><small>${esc(data.sim.param_sources.cycle_days?.citation || "Source not provided")} <a href="${esc(data.sim.param_sources.cycle_days?.url || "#")}" target="_blank" rel="noreferrer">Source</a></small><label>Per-pass classification assumption <output id="accuracy-value"></output><input type="range" id="accuracy" min="50" max="99" step="1" value="${Math.round(data.sim.params.per_pass_accuracy.mid * 100)}"></label><small>${esc(data.sim.param_sources.per_pass_accuracy?.citation || "Source not provided.")} <a href="${esc(data.sim.param_sources.per_pass_accuracy?.url || "#")}" target="_blank" rel="noreferrer">Source</a></small><div class="notice">Drained fraction: ${data.sim.params.drained_fraction_of_cycle.map(pct).join("–")} of each cycle. ${tag("ASSUMED", "detectability.json · drained_fraction_of_cycle")}</div></div><div class="panel results"><div class="eyebrow">Simulation output ${tag("INFERRED", "core detectability simulation · detectability.json assumptions")}</div><h2>Simulation results</h2><p id="sim-sentence" class="sim-sentence"></p><div class="charts" id="charts"></div></div></div>`;
}
function runLab() {
  const c = document.querySelector<HTMLInputElement>("#cycle"),
    a = document.querySelector<HTMLInputElement>("#accuracy");
  if (!c || !a) return;
  const cycle = Number(c.value),
    accuracy = Number(a.value) / 100;
  document.querySelector("#cycle-value")!.textContent =
    `${data.sim.params.cycle_days[0]}–${cycle} days`;
  document.querySelector("#accuracy-value")!.textContent = pct(accuracy);
  const params = {
    ...data.sim.params,
    cycle_days: [data.sim.params.cycle_days[0], cycle] as [number, number],
    per_pass_accuracy: { early: accuracy, mid: accuracy, late: accuracy },
  };
  const result = detectability(
    data.passes.passes,
    params,
    data.sim.n_sim,
    data.sim.seed,
  );
  document.querySelector("#sim-sentence")!.textContent = result.sentence;
  const groups = [
    ["AWD: drainage looks", result.results.awd.dist],
    ["Continuous flooding: false drainage looks", result.results.cf.dist],
  ] as const;
  document.querySelector("#charts")!.innerHTML = groups
    .map(
      ([title, values]) =>
        `<div><h3>${title}</h3><div class="bars">${values.map((v, i) => `<div class="bar-col"><span>${Math.round(v * 100)}%</span><div class="bar" style="--probability:${v}"></div><small>${i}</small></div>`).join("")}</div><div class="chart-label">Number of drained labels · ${tag("INFERRED", "core detectability simulation")}</div></div>`,
    )
    .join("");
}
function inspectionPage() {
  return `${heading("03 / INSPECTION PLANNING", "Inspection planning", "Rank field claims against the current run.")}<div class="inspection-layout"><div class="panel"><div class="eyebrow">Sample program <span class="sample">Synthetic claims</span></div><h2>Sample program</h2><p>Choose an inspection budget and generate a ranked queue.</p><label class="input-label" for="budget">Inspection budget ${tag("ASSUMED", "User-selected inspection budget")}</label><input id="budget" type="number" min="1" max="5000" value="20"><button class="button primary wide" id="audit">Generate inspection list</button><div id="audit-message" class="notice">Ready to generate an inspection queue.</div></div><div class="panel"><div class="eyebrow">Ranked queue ${tag("INFERRED", "core ranking through audit API")}</div><h2>Inspection list</h2><div id="audit-results" class="placeholder"><span></span><p>Run the sample program to generate a ranked list.</p></div></div></div>`;
}
async function audit() {
  const generation = ++auditRequest;
  const el = document.querySelector<HTMLButtonElement>("#audit")!,
    msg = document.querySelector("#audit-message")!,
    results = document.querySelector("#audit-results")!,
    budget = Number(document.querySelector<HTMLInputElement>("#budget")!.value);
  if (!el || !msg || !results) return;
  if (!Number.isInteger(budget) || budget < 1 || budget > 5000) {
    msg.textContent = "Enter a whole-number budget from 1 to 5,000.";
    return;
  }
  el.disabled = true;
  msg.textContent = "Generating list…";
  try {
    const claims = await client.getClaimsSample();
    const out = await client.postAudit({ claims, budget, seed: 7 });
    if (generation !== auditRequest || !results.isConnected) return;
    if (out.run_id !== data.meta.run_id)
      throw new Error("Audit belongs to a different run. Reload to continue.");
    msg.textContent = "Inspection list generated";
    results.innerHTML = `<div class="audit-meta">${evidence(out.matched + " matched · " + out.unmatched + " unmatched", "INFERRED", "audit response")} ${out.synthetic ? '<span class="sample">SYNTHETIC</span>' : ""}</div>${out.ranked.map((r) => `<div class="audit-row"><span>${String(r.rank).padStart(2, "0")}</span><div><b>${esc(r.field_id || r.claim_id)}</b><p>${esc(r.reason)}</p></div><small>${esc(r.pick)}<br>${esc(r.score.toFixed(2))} ${tag("INFERRED", "audit response · ranking score")}</small></div>`).join("")}`;
  } catch (e) {
    if (generation === auditRequest && msg.isConnected)
      msg.textContent = `Could not generate list: ${e instanceof Error ? e.message : String(e)}`;
  } finally {
    el.disabled = false;
  }
}
function evidencePage() {
  return `${heading("04 / EVIDENCE", "Evidence", "Checks and provenance for the current run.")}<div id="evidence-content" class="panel">Loading checks and provenance…</div>`;
}
async function loadEvidence() {
  const el = document.querySelector("#evidence-content");
  if (!el) return;
  try {
    const [checks, prov] = await Promise.all([
      client.getChecks(),
      client.getProvenance(),
    ]);
    if (
      checks.run_id !== data.meta.run_id ||
      prov.run_id !== data.meta.run_id ||
      checks.fixture !== data.meta.fixture ||
      prov.fixture !== data.meta.fixture
    )
      throw new Error("Checks and provenance belong to a different run.");
    if (!document.querySelector("#evidence-content")) return;
    el.innerHTML = `<div class="evidence-grid"><div><div class="eyebrow">Season shape ${tag("INFERRED", "checks.json · season_shape")}</div><h2>${checks.season_shape ? (checks.season_shape.pass ? "Check passed" : "Check did not pass") : "Not run"}</h2><p>${esc(checks.season_shape?.rule || "No season-shape check is available for this run.")}</p>${
      checks.season_shape
        ? Object.entries(checks.season_shape.pct_flooded_by_stage)
            .map(
              ([k, v]) =>
                `<div class="evidence-line"><span>${esc(k)}</span><strong>${esc(v)}%</strong></div>`,
            )
            .join("")
        : ""
    }</div><div><div class="eyebrow">OPERA cross-check ${tag("INFERRED", "checks.json · opera")}</div><h2>${checks.opera ? esc(checks.opera.product) : "Not run"}</h2><p>${checks.opera ? esc(checks.opera.version) : "No OPERA comparison is available for this run."}</p>${checks.opera ? `<p>${evidence(checks.opera.n_dates + " comparison dates", "INFERRED", "checks.json · opera")}</p>` : ""}</div></div><div class="source-status"><span>Radar imagery</span><strong id="overlay-status">${esc(overlayStatus)}</strong><span>Run</span><strong>${esc(data.meta.run_id)}</strong></div><div class="evidence-grid"><div><div class="eyebrow">District context ${tag("INFERRED", "checks.json · district")}</div>${checks.district ? `<p>District reference / ${esc(checks.district.year)}</p>${checks.district.rows.map((r) => `<div class="evidence-line"><span>${esc(r.district)}</span><strong>${r.tile_dsr_signal_frac === null ? "No tile" : pct(r.tile_dsr_signal_frac)}</strong></div>`).join("")}` : "<p>District comparison not run.</p>"}</div><div><div class="eyebrow">Provenance</div><h2>Trace the inputs</h2><p>Run ${esc(prov.run_id)} · created ${esc(prov.created_at)} · revision ${esc(prov.git_sha)}</p><details><summary>Granules and artifact hashes</summary>${prov.granules.map((g) => `<p class="hash">${esc(g.granule_id)}<br>${esc(g.crid)} · ${esc(g.subset_sha256)}</p>`).join("")}${prov.artifacts.map((a) => `<p class="hash">${esc(a.path)}<br>${esc(a.sha256)}</p>`).join("")}</details></div></div>`;
  } catch (e) {
    el.innerHTML = `<p>Checks could not be loaded: ${esc(e instanceof Error ? e.message : String(e))}</p><button id="retry-evidence" class="button light">Retry</button>`;
    bindLocal();
  }
}
function methodsPage() {
  return `${heading("Methods", "Radar to field evidence", "Processing and model sources for this run")}<div class="panel prose"><h2>Processing sequence</h2><p>NISAR GCOV radar observations are summarized within mapped field boundaries. The pipeline infers flooded, drained or uncertain states from the available radar features. Season rules combine clear looks with a detectability simulation to assess alternate wetting and drying.</p><p>Polarization modes determine which features are available. Per-pass states, season assessments and model probabilities are inferred; radar backscatter is observed.</p><details><summary>Simulation parameters and sources</summary>${Object.entries(
    data.sim.param_sources,
  )
    .map(
      ([key, source]) =>
        `<div class="evidence-line"><span>${esc(words(key))}</span><span>${esc(source?.citation || "Source unavailable")} ${source?.url ? `<a href="${esc(source.url)}" target="_blank" rel="noreferrer">Source</a>` : ""}</span></div>`,
    )
    .join(
      "",
    )}</details><a class="text-link" href="/evidence" data-nav="/evidence">View provenance</a></div>`;
}
function judgesPage() {
  return `${heading("FOR JUDGES", "The evidence trail.", "Explore the map, model outputs and inspection workflow.")}<div class="panel judges">${[
    [
      "Impact",
      "A field-level view to guide inspection resources.",
      "/scarecrow",
    ],
    [
      "Creativity",
      "The Lab measures the blind spots in the pass schedule.",
      "/lab",
    ],
    [
      "Validity",
      "Inspect checks, input sources and artifact provenance.",
      "/evidence",
    ],
    [
      "Relevance",
      "Radar observations form the basis for field-level evidence.",
      "/methods",
    ],
    ["Presentation", "Explore the map and take the guided tour.", "/"],
  ]
    .map(
      ([a, b, c], i) =>
        `<a href="${c}" data-nav="${c}"><span>0${i + 1}</span><strong>${a}</strong><p>${b}</p><b></b></a>`,
    )
    .join("")}</div>`;
}
function render() {
  clearTimeout(playTimer);
  playing = false;
  map?.remove();
  map = undefined;
  let content =
    route === "/lab"
      ? labPage()
      : route === "/scarecrow"
        ? inspectionPage()
        : route === "/evidence"
          ? evidencePage()
          : route === "/methods"
            ? methodsPage()
            : route === "/judges"
              ? judgesPage()
              : mapPage();
  root.innerHTML = shell(content);
  bindLocal();
  if (route === "/lab") runLab();
  else if (route === "/evidence") void loadEvidence();
  else if (route === "/" || route === "/map" || route.startsWith("/field/")) {
    initMap();
    updateInspector();
    updateTimeline();
    if (route.startsWith("/field/"))
      void choose(decodeURIComponent(route.slice(7)), false);
  }
}
function bindLocal() {
  const inspector = document.querySelector<HTMLElement>("#inspector");
  if (inspector) {
    inspector.addEventListener("focusin", stopPlayback);
    inspector.onpointerdown = stopPlayback;
  }
  document
    .querySelectorAll<HTMLButtonElement>("[data-field-id]")
    .forEach((button) => {
      button.onclick = () => void choose(button.dataset.fieldId!);
    });
  const retryField = document.querySelector<HTMLButtonElement>("#retry-field");
  if (retryField) retryField.onclick = () => void choose(selected, false);
  document.querySelectorAll<HTMLAnchorElement>("[data-nav]").forEach(
    (a) =>
      (a.onclick = (e) => {
        e.preventDefault();
        navigate(a.dataset.nav!);
      }),
  );
  document.querySelectorAll<HTMLButtonElement>("[data-layer]").forEach(
    (b) =>
      (b.onclick = () => {
        layer = b.dataset.layer!;
        query();
        document
          .querySelectorAll("[data-layer]")
          .forEach((x) =>
            x.classList.toggle(
              "on",
              (x as HTMLElement).dataset.layer === layer,
            ),
          );
        document
          .querySelectorAll<HTMLButtonElement>("[data-layer]")
          .forEach((x) =>
            x.setAttribute("aria-pressed", String(x.dataset.layer === layer)),
          );
        updateMap();
      }),
  );
  document
    .querySelectorAll<HTMLButtonElement>("[data-pass]")
    .forEach((b) => (b.onclick = () => setPass(Number(b.dataset.pass))));
  document.querySelectorAll<HTMLButtonElement>("[data-pass-id]").forEach(
    (b) =>
      (b.onclick = () => {
        const i = data.states.pass_ids.indexOf(b.dataset.passId!);
        if (i >= 0) setPass(i);
      }),
  );
  const district = document.querySelector<HTMLSelectElement>("#district");
  if (district)
    district.onchange = () => {
      tile = district.value;
      selected = "";
      field = null;
      request++;
      query();
      fitTile();
      updateMap();
      updateInspector();
    };
  const search = document.querySelector<HTMLFormElement>("#search");
  if (search)
    search.onsubmit = (e) => {
      e.preventDefault();
      void choose(
        document.querySelector<HTMLInputElement>("#search-id")!.value.trim(),
      );
    };
  const close = document.querySelector<HTMLButtonElement>("#close-field");
  if (close)
    close.onclick = () => {
      selected = "";
      field = null;
      request++;
      query();
      updateMap();
      updateInspector();
    };
  const camera = document.querySelector<HTMLButtonElement>("#camera-toggle");
  if (camera)
    camera.onclick = () => {
      perspective = !perspective;
      camera.textContent = perspective ? "2D" : "3D";
      camera.setAttribute(
        "aria-label",
        perspective ? "Enable flat view" : "Enable perspective view",
      );
      camera.setAttribute(
        "title",
        perspective ? "Flat view" : "Perspective view",
      );
      camera.setAttribute("aria-pressed", String(perspective));
      map?.easeTo({
        pitch: perspective ? 40 : 0,
        bearing: perspective ? -15 : 0,
        duration: matchMedia("(prefers-reduced-motion: reduce)").matches
          ? 0
          : 500,
      });
    };
  const reset = document.querySelector<HTMLButtonElement>("#camera-reset");
  if (reset) reset.onclick = fitTile;
  const legendButton =
    document.querySelector<HTMLButtonElement>("#legend-toggle");
  if (legendButton)
    legendButton.onclick = () => {
      const key = document.querySelector("#map-key");
      const open = key?.classList.toggle("is-open") ?? false;
      legendButton.setAttribute("aria-expanded", String(open));
    };
  const radarButton =
    document.querySelector<HTMLButtonElement>("#radar-toggle");
  if (radarButton)
    radarButton.onclick = () => {
      radar = !radar;
      updateRadar();
    };
  const play = document.querySelector<HTMLButtonElement>("#play");
  if (play) play.onclick = togglePlay;
  const auditButton = document.querySelector<HTMLButtonElement>("#audit");
  if (auditButton) auditButton.onclick = () => void audit();
  const retry = document.querySelector<HTMLButtonElement>("#retry-evidence");
  if (retry) retry.onclick = () => void loadEvidence();
  ["cycle", "accuracy"].forEach((id) => {
    const x = document.querySelector<HTMLInputElement>("#" + id);
    if (x) x.oninput = runLab;
  });
  const start = document.querySelector<HTMLButtonElement>("#start-tour");
  if (start) start.onclick = startTour;
  const exit = document.querySelector<HTMLButtonElement>("#exit-tour");
  if (exit) exit.onclick = exitTour;
}
function exitTour() {
  tourTimers.forEach(clearTimeout);
  tourTimers = [];
  const q = new URLSearchParams(location.search);
  q.delete("tour");
  history.replaceState({}, "", `${route}?${q}`);
  document.querySelector("#exit-tour")?.remove();
}
function startTour() {
  exitTour();
  tile = data.story.hero_tile;
  pass = 0;
  layer = "pass";
  selected = "";
  field = null;
  fieldError = "";
  request++;
  auditRequest++;
  route = "/";
  const q = new URLSearchParams(location.search);
  q.set("tour", "1");
  history.pushState({}, "", `/?${q}`);
  render();
  if (!matchMedia("(prefers-reduced-motion: reduce)").matches) togglePlay();
  tourTimers = [
    window.setTimeout(() => void choose(data.story.hero_field_id), 10000),
    window.setTimeout(() => navigate("/lab"), 21000),
    window.setTimeout(() => navigate("/scarecrow"), 33000),
    window.setTimeout(() => void audit(), 35000),
    window.setTimeout(exitTour, 45000),
  ];
}
window.onpopstate = () => {
  if (!data) return;
  request++;
  auditRequest++;
  route = location.pathname;
  const q = new URLSearchParams(location.search);
  tile = q.get("tile") || data.meta.tiles[0]!.id;
  layer = q.get("layer") || "pass";
  selected = q.get("field") || "";
  const p = data.states.pass_ids.indexOf(q.get("pass") || "");
  pass = p < 0 ? 0 : p;
  field = null;
  render();
  if (selected && !route.startsWith("/field/")) void choose(selected, false);
};
async function boot() {
  root.innerHTML = '<div class="loading"><p>Loading field evidence</p></div>';
  try {
    data = await loadData();
    void loadOverlays();
    tile = data.meta.tiles.some((t) => t.id === tile)
      ? tile
      : data.story.hero_tile;
    const q = new URLSearchParams(location.search);
    selected = q.get("field") || "";
    const p = data.states.pass_ids.indexOf(q.get("pass") || "");
    pass = p < 0 ? 0 : p;
    render();
    if (selected && !route.startsWith("/field/")) void choose(selected, false);
    if (q.has("tour")) startTour();
    else if (
      (route === "/" || route === "/map") &&
      !q.has("pass") &&
      !selected &&
      !matchMedia("(prefers-reduced-motion: reduce)").matches
    )
      togglePlay();
  } catch (e) {
    root.innerHTML = `<div class="loading"><span class="brandmark"></span><h2>Evidence unavailable</h2><p>${esc(e instanceof Error ? e.message : String(e))}</p><button class="button primary" id="retry">Retry connection</button></div>`;
    document.querySelector<HTMLButtonElement>("#retry")!.onclick = () =>
      void boot();
  }
}
void boot();
