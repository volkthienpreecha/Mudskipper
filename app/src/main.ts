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
const esc = (v: unknown) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
const tag = (kind: string, source: string) =>
  `<span class="tag ${kind.toLowerCase()}" title="${esc(source)}">${kind}</span>`;
const date = (s: string) =>
  new Date(s).toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
const pct = (n: number) => `${Math.round(n * 100)}%`;
const words = (s: string) => s.replaceAll("_", " ");
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
  return `<div class="shell"><header class="top"><a href="/" data-nav="/" class="brand"><span class="brandmark">◈</span><span>MUDSKIPPER<small>FIELD INTELLIGENCE</small></span></a><nav aria-label="Main navigation"><a data-nav="/" class="${route === "/" || route === "/map" || route.startsWith("/field/") ? "active" : ""}" href="/">Explore</a><a data-nav="/lab" class="${route === "/lab" ? "active" : ""}" href="/lab">Lab</a><a data-nav="/scarecrow" class="${route === "/scarecrow" ? "active" : ""}" href="/scarecrow">Inspection</a><a data-nav="/evidence" class="${route === "/evidence" ? "active" : ""}" href="/evidence">Evidence</a></nav><div class="topright">${data.meta.fixture ? '<span class="sample">● SAMPLE DATA</span>' : ""}<a href="/methods" data-nav="/methods">Methods ↗</a></div></header><main>${content}</main><footer><span>NASA–ISRO NISAR / FIELD EVIDENCE</span><span>Built to show what the data can and cannot say.</span><a href="/judges" data-nav="/judges">For judges ↗</a></footer>${new URLSearchParams(location.search).has("tour") ? '<button class="exit-tour" id="exit-tour">Exit tour ×</button>' : ""}</div>`;
}
function heading(kicker: string, title: string, text: string) {
  return `<div class="page-head"><div><div class="eyebrow">${kicker}</div><h1>${title}</h1><p>${text}</p></div><div class="page-index">M / ${esc(data.meta.run_id)}<br>FIELD NOTES</div></div>`;
}
function mapPage() {
  return `<section class="intro"><div><div class="eyebrow"><span class="dot"></span> PUNJAB, INDIA <span class="divider">/</span> KHARIF SEASON</div><h1>Was this rice field<br><em>really drained?</em></h1><p>Satellite evidence for a closer look at rice-field irrigation.</p></div><div class="intro-right"><div class="headline">${esc(data.story.headline.text)}</div>${tag(data.story.headline.tag, "story.json · current run")}<div class="intro-actions"><button id="start-tour" class="button primary">See the tour <span>↗</span></button><a href="/judges" data-nav="/judges" class="button light">For judges ↗</a></div></div></section><section class="explorer"><div class="sectionbar"><div><div class="eyebrow">01 / EXPLORE THE EVIDENCE</div><h2>Field intelligence <span class="arrow">↗</span></h2></div><div class="toolbar"><label class="sr-only" for="district">Study area</label><select id="district">${data.meta.tiles.map((t) => `<option value="${esc(t.id)}" ${tile === t.id ? "selected" : ""}>${esc(t.district)}</option>`).join("")}</select><div class="segmented"><button data-layer="pass" class="${layer === "pass" ? "on" : ""}">Pass state</button><button data-layer="season" class="${layer === "season" ? "on" : ""}">Season assessment</button></div></div></div><div class="map-layout"><div class="map-frame"><div id="map" aria-label="Interactive map of study fields"></div><div class="map-tint"></div><div class="map-top"><div><span class="map-label">STUDY AREA / ${esc(tile.toUpperCase())}</span><strong>Punjab, India</strong></div><div class="map-cross">⌖</div></div><div class="map-bottom-note">BASEMAP IMAGERY IS CONTEXTUAL, NOT NISAR OBSERVATION DATE</div><div class="map-coords" id="coords">⌖</div><div class="map-key" id="map-key"></div></div><aside class="inspector" id="inspector"></aside></div><div class="timeline"><div class="timeline-left"><div class="eyebrow">SEASON PLAYBACK ${tag("INFERRED", "states.json · current run")}</div><strong id="pass-date"></strong><span id="pass-id"></span></div><button id="play" class="play" aria-label="Play season">▶</button><div class="track-wrap"><div class="track" id="track"></div><div class="track-labels"><span>${esc(date(data.meta.season.start))}</span><span>TIME BETWEEN PASSES IS TO SCALE</span><span>${esc(date(data.meta.season.end))}</span></div></div></div></section><section class="lower"><div><div class="eyebrow">THE QUESTION</div><h2>Water leaves a signal.<br>Certainty takes more.</h2></div><p>NISAR radar can look through clouds, but a pass is only a glimpse. Explore the field states, then use the Lab to see what the gaps can hide.</p><a class="text-link" href="/methods" data-nav="/methods">Read the methods ↗</a></section>`;
}
function fieldHTML() {
  if (!selected)
    return `<div class="inspector-head"><span class="eyebrow">FIELD INSPECTOR</span><span>↗</span></div><div class="empty-icon">⌖</div><h3>Select a field</h3><p>Choose an outlined field on the map or search by field ID to inspect its season.</p><form id="search"><label for="search-id">FIELD ID</label><div class="search"><input id="search-id" placeholder="e.g. fazilka-00001" required><button aria-label="Find field">↗</button></div></form><div class="inspector-foot">FIELD-LEVEL SATELLITE EVIDENCE<br><span>Results are signals, not proof.</span></div>`;
  if (fieldError)
    return `<div class="inspector-head"><span class="eyebrow">FIELD INSPECTOR</span><button id="close-field" aria-label="Close field">×</button></div><h3>Field unavailable</h3><p role="alert">${esc(fieldError)}</p><button class="button primary" id="retry-field">Retry field</button>`;
  if (!field)
    return `<div class="inspector-head"><span class="eyebrow">FIELD INSPECTOR</span><button id="close-field">×</button></div><p>Loading field evidence…</p>`;
  const s = field.summary,
    o = field.observations.find(
      (x: any) => x.pass_id === data.states.pass_ids[pass],
    );
  return `<div class="inspector-head"><span class="eyebrow">FIELD INSPECTOR / SELECTED</span><button id="close-field" aria-label="Close field">×</button></div><div class="field-title"><div><h3>${esc(selected)}</h3><p>${esc(field.field.properties.district)} · ${evidence(field.field.properties.area_ha + " ha", "ASSUMED", "fields.geojson · field boundary area")}</p></div><span class="target">⌖</span></div><div class="field-state"><span>THIS PASS ${tag("INFERRED", "observations · state classifier")}</span><strong>${esc(o?.inferred.state || "No observation")}</strong><small>${o ? esc(date(o.datetime)) : "No observation for this pass"}</small></div><div class="detail-row"><span>SEASON ASSESSMENT ${tag("INFERRED", "field_summary · AWD rule")}</span><b>${esc(s ? words(s.awd.verdict) : "Not available")}</b><p>${esc(s?.awd.reason || "No season summary available.")}</p></div><div class="detail-row"><span>DSR SIGNAL ${tag("INFERRED", "field_summary · DSR rule")}</span><b>${esc(s ? words(s.dsr.signal) : "Not available")}</b><p>${esc(s?.dsr.reason || "")}</p></div><div class="detail-row"><span>PASS HISTORY ${tag("INFERRED", "observations · state classifier")}</span><div class="chips">${field.observations.map((x: any) => `<button class="chip ${esc(x.inferred.state)}" data-pass-id="${esc(x.pass_id)}" title="${esc(date(x.datetime) + " · " + x.inferred.state)}">${esc(x.inferred.state[0].toUpperCase())}</button>`).join("")}</div><p>F flooded · D drained · U uncertain</p></div><div class="detail-row"><span>RADAR MEASUREMENTS ${tag("OBSERVED", "observations · radar backscatter")}</span><b>${o ? `HH ${esc(o.observed.hh_db)} dB · HV ${esc(o.observed.hv_db)} dB` : "No measurement for this pass"}</b><p>Measurements are per-field summaries for the selected pass.</p></div><div class="detail-row"><span>BOUNDARY SOURCE</span><b>${esc(field.field.properties.source)}</b></div><a class="text-link" href="/field/${encodeURIComponent(selected)}" data-nav="/field/${encodeURIComponent(selected)}">Open field details ↗</a>`;
}
function updateInspector() {
  const el = document.querySelector("#inspector");
  if (!el) return;
  el.classList.toggle("has-field", !!selected);
  el.innerHTML = fieldHTML();
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
  const label = document.querySelector(".map-label");
  if (label) label.textContent = `STUDY AREA / ${tile.toUpperCase()}`;
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
          "#aa8bff",
          "D",
          "#e8f725",
          "U",
          "#a2a1a8",
          "#62616a",
        ]
      : [
          "match",
          ["get", "verdict"],
          "consistent",
          "#aa8bff",
          "inconsistent",
          "#e8f725",
          "not_enough_evidence",
          "#a2a1a8",
          "#62616a",
        ];
  map.setPaintProperty("fill", "fill-color", color as any);
  updateTimeline();
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
    padding: 45,
    duration: matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 600,
    maxZoom: 16,
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
            "raster-saturation": -0.65,
            "raster-brightness-max": 0.57,
            "raster-contrast": 0.12,
          },
        },
      ],
    },
    center: [(t.bbox[0] + t.bbox[2]) / 2, (t.bbox[1] + t.bbox[3]) / 2],
    zoom: 11,
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
      paint: { "fill-color": "#aa8bff", "fill-opacity": 0.66 },
    });
    map!.addLayer({
      id: "outline",
      type: "line",
      source: "fields",
      paint: {
        "line-color": "#eee8ff",
        "line-width": 0.8,
        "line-opacity": 0.8,
      },
    });
    map!.addLayer({
      id: "selected",
      type: "line",
      source: "fields",
      filter: ["==", ["get", "selected"], true],
      paint: { "line-color": "#ffff35", "line-width": 3.5 },
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
      el.textContent = `⌖ ${c.lat.toFixed(4)}° N  /  ${c.lng.toFixed(4)}° E`;
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
  track.innerHTML = `<div class="track-line"></div>${data.meta.gaps.map((g) => `<div class="gap" style="left:${pos(g.start)}%;width:${pos(g.end) - pos(g.start)}%" title="No data: ${esc(date(g.start))}–${esc(date(g.end))}"><span>NO DATA</span></div>`).join("")}${data.states.pass_ids
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
  key.innerHTML = `<div class="key-title">${layer === "pass" ? "PASS STATE" : "SEASON ASSESSMENT"} ${tag("INFERRED", "states.json / field summaries")}</div>${items.map(([k, v], i) => `<span><i class="swatch s${i}"></i>${v} <b>${count[k] || 0}</b></span>`).join("")}`;
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
    btn.textContent = playing ? "❚❚" : "▶";
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
  return `${heading("02 / DETECTABILITY LAB", "What can a pass miss?", "Change the assumptions and see how the actual pass schedule affects the simulation.")}<div class="lab-grid"><div class="panel controls"><div class="eyebrow">MODEL INPUTS ${tag("ASSUMED", "detectability.json · param_sources")}</div><h2>Set the conditions.</h2><p>The controls vary assumptions, not measured field accuracy. The model uses this run’s pass dates and fixed seed.</p><label>Drainage cycle <output id="cycle-value"></output><input type="range" id="cycle" min="4" max="14" step="1" value="${data.sim.params.cycle_days[1]}"></label><small>${esc(data.sim.param_sources.cycle_days?.citation || "Source not provided")} <a href="${esc(data.sim.param_sources.cycle_days?.url || "#")}" target="_blank" rel="noreferrer">Source ↗</a></small><label>Per-pass classification assumption <output id="accuracy-value"></output><input type="range" id="accuracy" min="50" max="99" step="1" value="${Math.round(data.sim.params.per_pass_accuracy.mid * 100)}"></label><small>${esc(data.sim.param_sources.per_pass_accuracy?.note || "Source not provided.")} <a href="${esc(data.sim.param_sources.per_pass_accuracy?.url || "#")}" target="_blank" rel="noreferrer">Source ↗</a></small><div class="notice">${esc(data.sim.param_sources.drained_fraction_of_cycle?.note || "No source note provided for drained fraction.")}</div></div><div class="panel results"><div class="eyebrow">SIMULATION OUTPUT ${tag("INFERRED", "core detectability simulation · detectability.json assumptions")}</div><h2>Look beyond the labels.</h2><p id="sim-sentence" class="sim-sentence"></p><div class="charts" id="charts"></div><p class="muted">Probabilities are simulated under the assumptions shown. They are not measured accuracy for Punjab fields.</p></div></div>`;
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
        `<div><h3>${title}</h3><div class="bars">${values.map((v, i) => `<div class="bar-col"><span>${Math.round(v * 100)}%</span><div class="bar" style="height:${Math.max(1, v * 180)}px"></div><small>${i}</small></div>`).join("")}</div><div class="chart-label">NUMBER OF DRAINED LABELS · ${tag("INFERRED", "core detectability simulation")}</div></div>`,
    )
    .join("");
}
function inspectionPage() {
  return `${heading("03 / INSPECTION PLANNING", "A place to look first.", "Turn satellite evidence into a transparent inspection queue.")}<div class="inspection-layout"><div class="panel"><div class="eyebrow">SAMPLE PROGRAM <span class="sample">SYNTHETIC CLAIMS</span></div><h2>Plan a field visit.</h2><p>Run the sample claims through the current evidence. The result is a priority for inspection, not a finding about anyone.</p><label class="input-label" for="budget">Inspection budget ${tag("ASSUMED", "User-selected inspection budget")}</label><input id="budget" type="number" min="1" max="5000" value="20"><button class="button primary wide" id="audit">Generate inspection list ↗</button><div id="audit-message" class="notice">Sample claims are synthetic. No people are identified.</div></div><div class="panel"><div class="eyebrow">RANKED QUEUE ${tag("INFERRED", "core ranking through audit API")}</div><h2>Inspection list</h2><div id="audit-results" class="placeholder"><span>↗</span><p>Run the sample program to generate a ranked list.</p></div></div></div>`;
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
    msg.textContent = out.notice;
    results.innerHTML = `<div class="audit-meta">${evidence(out.matched + " matched · " + out.unmatched + " unmatched", "INFERRED", "audit response")} ${out.synthetic ? '<span class="sample">SYNTHETIC</span>' : ""}</div>${out.ranked.map((r) => `<div class="audit-row"><span>${String(r.rank).padStart(2, "0")}</span><div><b>${esc(r.field_id || r.claim_id)}</b><p>${esc(r.reason)}</p></div><small>${esc(r.pick)}<br>${esc(r.score.toFixed(2))} ${tag("INFERRED", "audit response · ranking score")}</small></div>`).join("")}`;
  } catch (e) {
    if (generation === auditRequest && msg.isConnected)
      msg.textContent = `Could not generate list: ${e instanceof Error ? e.message : String(e)}`;
  } finally {
    el.disabled = false;
  }
}
function evidencePage() {
  return `${heading("04 / EVIDENCE", "Show your work.", "Every assessment has a source, a method, and a limit.")}<div id="evidence-content" class="panel">Loading checks and provenance…</div>`;
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
    el.innerHTML = `<div class="evidence-grid"><div><div class="eyebrow">SEASON SHAPE ${tag("INFERRED", "checks.json · season_shape")}</div><h2>${checks.season_shape ? (checks.season_shape.pass ? "Check passed" : "Check did not pass") : "Not run"}</h2><p>${esc(checks.season_shape?.rule || "No season-shape check is available for this run.")}</p>${
      checks.season_shape
        ? Object.entries(checks.season_shape.pct_flooded_by_stage)
            .map(
              ([k, v]) =>
                `<div class="evidence-line"><span>${esc(k)}</span><strong>${esc(v)}%</strong></div>`,
            )
            .join("")
        : ""
    }</div><div><div class="eyebrow">OPERA CROSS-CHECK ${tag("INFERRED", "checks.json · opera")}</div><h2>${checks.opera ? esc(checks.opera.product) : "Not run"}</h2><p>${esc(checks.opera?.note || "No OPERA comparison is available for this run.")}</p>${checks.opera ? `<p>${evidence(checks.opera.n_dates + " comparison dates", "INFERRED", "checks.json · opera")}</p>` : ""}</div></div><div class="limits"><div class="eyebrow">THE LIMITS</div><h2>Evidence has edges.</h2><p>${esc(data.meta.limits_text)}</p></div><div class="evidence-grid"><div><div class="eyebrow">DISTRICT CONTEXT ${tag("INFERRED", "checks.json · district")}</div>${checks.district ? `<p>${esc(checks.district.note)}</p>${checks.district.rows.map((r) => `<div class="evidence-line"><span>${esc(r.district)}</span><strong>${r.tile_dsr_signal_frac === null ? "No tile" : pct(r.tile_dsr_signal_frac)}</strong></div>`).join("")}` : "<p>District comparison not run.</p>"}</div><div><div class="eyebrow">PROVENANCE</div><h2>Trace the inputs.</h2><p>Run ${esc(prov.run_id)} · created ${esc(prov.created_at)} · revision ${esc(prov.git_sha)}</p><details><summary>Granules and artifact hashes</summary>${prov.granules.map((g) => `<p class="hash">${esc(g.granule_id)}<br>${esc(g.crid)} · ${esc(g.subset_sha256)}</p>`).join("")}${prov.artifacts.map((a) => `<p class="hash">${esc(a.path)}<br>${esc(a.sha256)}</p>`).join("")}</details></div></div>`;
  } catch (e) {
    el.innerHTML = `<p>Checks could not be loaded: ${esc(e instanceof Error ? e.message : String(e))}</p><button id="retry-evidence" class="button light">Retry</button>`;
    bindLocal();
  }
}
function methodsPage() {
  return `${heading("METHODS / LIMITS", "A signal, not a verdict.", "Read the evidence in context.")}<div class="panel prose"><h2>From radar to evidence</h2><p>NISAR GCOV radar observations are summarized within mapped field boundaries. The processing pipeline infers flooded, drained or uncertain states from the available radar features. The season rules combine clear looks and a detectability simulation to assess whether evidence is consistent with alternate wetting and drying.</p><p>Different polarization modes provide different features. Uncertain and missing observations are kept distinct. A DSR signal is not proof of planting practice, and an inspection ranking is not a finding about a person.</p><div class="limits"><div class="eyebrow">LIMITS / CURRENT RUN</div><p>${esc(data.meta.limits_text)}</p></div><h2>Three evidence labels</h2><p>${tag("OBSERVED", "Radar measurements")} Radar measurement. ${tag("INFERRED", "Model output")} Model reading or simulation output. ${tag("ASSUMED", "Cited model parameter")} Model parameter or convention. Fixture measurements are synthetic sample data.</p><a class="text-link" href="/evidence" data-nav="/evidence">Inspect provenance ↗</a></div>`;
}
function judgesPage() {
  return `${heading("FOR JUDGES", "The evidence trail.", "Explore the idea, the science, and its boundaries.")}<div class="panel judges">${[
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
      "Checks, provenance, assumptions and limits are visible.",
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
        `<a href="${c}" data-nav="${c}"><span>0${i + 1}</span><strong>${a}</strong><p>${b}</p><b>↗</b></a>`,
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
  root.innerHTML =
    '<div class="loading"><span class="brandmark">◈</span><p>Loading field evidence…</p></div>';
  try {
    data = await loadData();
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
    root.innerHTML = `<div class="loading"><span class="brandmark">◈</span><h2>Evidence unavailable</h2><p>${esc(e instanceof Error ? e.message : String(e))}</p><button class="button primary" id="retry">Retry connection ↗</button></div>`;
    document.querySelector<HTMLButtonElement>("#retry")!.onclick = () =>
      void boot();
  }
}
void boot();
