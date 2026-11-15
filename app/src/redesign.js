import {
  adaptSnapshot,
  loadApiDataset,
  getApiFieldDetails,
  getApiOverlays,
  createBackend,
} from "./data.ts";
import { mountBackendTools } from "./backend.ts";
import "./integration.css";
const client = createBackend(import.meta.env.VITE_API_BASE_URL || undefined);
const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const json = async (path) => {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return response.json();
};
let snapshot,
  snapshotSat,
  datasetVersion = 0,
  changeVersion = 0,
  navVersion = 0,
  fieldVersion = 0,
  heroVersion = 0,
  overlays = null,
  overlayOn = false,
  backend,
  dragged = false,
  restoring = false;
const details = new Map(),
  detailPending = new Map();
const allFields = () => Object.values(DATA.tiles).flatMap((t) => t.fields);
const fieldEntry = (id) => {
  for (const [t, area] of Object.entries(DATA.tiles)) {
    const i = area.fields.findIndex((f) => f.id === id);
    if (i >= 0) return { tile: t, index: i, field: area.fields[i] };
  }
  return null;
};
const ringsOf = (f) =>
  f.geometry
    ? f.geometry.type === "Polygon"
      ? f.geometry.coordinates
      : f.geometry.coordinates.flat()
    : [f.poly];
const pointsOf = (f) => ringsOf(f).flat();
const stateLabel = (c) =>
  ({ f: "Flooded", d: "Drained", u: "Uncertain", "-": "No observation" })[c] ||
  "No observation";
const day = (iso) => Date.parse(iso.slice(0, 10));
const gapBetween = (a, b) =>
  DATA.gaps.some((g) => day(a) < day(g.start) && day(b) > day(g.end));
const bounds = (fields) => {
  const b = [Infinity, Infinity, -Infinity, -Infinity];
  for (const f of fields)
    for (const [x, y] of pointsOf(f)) {
      b[0] = Math.min(b[0], x);
      b[1] = Math.min(b[1], y);
      b[2] = Math.max(b[2], x);
      b[3] = Math.max(b[3], y);
    }
  return b;
};
function apiSat(dataset) {
  const result = { country: snapshotSat.country };
  for (const [t, a] of Object.entries(dataset.tiles)) {
    const b = bounds(a.fields),
      pad = 0.012;
    const full = [b[0] - pad, b[1] - pad, b[2] + pad, b[3] + pad];
    const params = new URLSearchParams({
      bbox: full.join(","),
      bboxSR: "4326",
      imageSR: "4326",
      size: "1200,1200",
      format: "jpg",
      f: "image",
    });
    const m = {
      b: full,
      src:
        "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/export?" +
        params,
    };
    result[t + "_fields"] = m;
    result[t + "_district"] = m;
  }
  return result;
}
async function detailFor(field) {
  if (details.has(field.id)) return details.get(field.id);
  if (!detailPending.has(field.id)) {
    const dataset = DATA;
    detailPending.set(
      field.id,
      getApiFieldDetails(client, dataset, field.id)
        .then((detail) => {
          if (DATA === dataset) {
            details.set(field.id, detail);
            for (const o of detail.observations) {
              const i = dataset.passIds.indexOf(o.pass_id);
              field.c[i] = o.inferred.confidence;
              field.hh[i] = o.observed.hh_db;
            }
          }
          return detail;
        })
        .finally(() => detailPending.delete(field.id)),
    );
  }
  return detailPending.get(field.id);
}
function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}
const n = () => {};
const sfx = { tick: n, step: n, chime: n, whoosh: n };
// Mudskipper demo: real r01v1 fields (375 of them) rendered as an interactive map.
const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
const $ = (id) => document.getElementById(id);
const cap = $("tourCap");
let touring = false,
  tourVersion = 0;
const say = (t) => {
  cap.textContent = t;
  cap.classList.toggle("on", !!t);
};
const NAMES = {
  f: "flooded",
  d: "drained",
  u: "uncertain",
  "-": "no observation",
};
const wait = (ms) => new Promise((r) => setTimeout(r, reduce ? 0 : ms));
const fmt = (iso) =>
  new Date(iso + "T00:00:00Z")
    .toLocaleDateString("en-GB", {
      day: "numeric",
      month: "short",
      timeZone: "UTC",
    })
    .replace(/(\d+) (\w+)/, "$2 $1");

let SAT,
  DATA,
  CTRY,
  tile = "fazilka",
  pass = 0,
  selected = null,
  playing = false,
  view = "country";

const svg = $("fieldMap"),
  loader = $("mapLoader"),
  status = $("mapStatus");
const slider = $("passSlider"),
  card = $("fcard"),
  dateEl = $("mapDate");
const K = Math.cos((30.4 * Math.PI) / 180);
const P = (x, y) => [x * K * 1000, -y * 1000]; // scaled up: tiny viewBox numbers break SVG rendering
const NICE = { fazilka: "Fazilka", muktsar: "Sri Muktsar Sahib" };
let vb = [0, 0, 1, 1],
  anim = 0;

function boxOf(pts, pad) {
  let a = 1e9,
    b = 1e9,
    c = -1e9,
    d = -1e9;
  pts.forEach(([x, y]) => {
    const [u, v] = P(x, y);
    a = Math.min(a, u);
    b = Math.min(b, v);
    c = Math.max(c, u);
    d = Math.max(d, v);
  });
  const w = c - a,
    h = d - b;
  return [a - w * pad, b - h * pad, w * (1 + 2 * pad), h * (1 + 2 * pad)];
}
const COUNTRY_BOX = () =>
  boxOf(
    [
      [66, 6],
      [97, 36],
    ],
    0.02,
  );
const tileBox = (t) => boxOf(DATA.tiles[t].fields.flatMap(pointsOf), 0.06);

function setVB(b) {
  vb = b;
  svg.setAttribute("viewBox", b.map((v) => v.toFixed(3)).join(" "));
  const zoomed = Math.max(0, Math.min(1, (3.0 - Math.log10(b[2] / 10)) / 2.0)); // 0 = country, 1 = fields
  $("gF").style.opacity = Math.max(0, zoomed * 2 - 1);
  $("gM").style.opacity = 1 - zoomed;
  $("gC").style.opacity = 1 - 0.85 * zoomed;
  svg
    .querySelectorAll(".clabel")
    .forEach((t) => (t.style.opacity = zoomed > 0.25 ? 0 : 1));
  const u = b[2] / 100; // 1% of view width
  svg.querySelectorAll(".mk").forEach((g) => {
    g.querySelector(".dot").setAttribute("r", u * 0.9);
    g.querySelector(".ring").setAttribute("r", u * 2.2);
    const t = g.querySelector("text");
    t.setAttribute("font-size", u * 2.6);
    t.setAttribute("x", +g.dataset.x + u * 3);
    t.setAttribute(
      "y",
      +g.dataset.y + u * (g.dataset.tile === "muktsar" ? 3.6 : -1.6),
    );
  });
  svg.querySelector("#hatch").setAttribute("width", u * 0.8);
  svg.querySelector("#hatch").setAttribute("height", u * 0.8);
  svg.querySelector("#hatch line").setAttribute("stroke-width", u * 0.3);
  svg.querySelector("#hatch line").setAttribute("y2", u * 0.8);
  svg.querySelector("#hatch rect").setAttribute("width", u * 0.8);
  svg.querySelector("#hatch rect").setAttribute("height", u * 0.8);
}

// smooth fly between two view boxes: centre eases, width moves in log space (feels like a camera zoom)
function fly(to, ms = 1800) {
  const from = vb.slice(),
    id = ++anim,
    t0 = performance.now();
  const ease = (t) =>
    t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  return new Promise((done) => {
    const step = (now) => {
      if (id !== anim) return done();
      const t = reduce ? 1 : Math.min(1, (now - t0) / ms),
        e = ease(t);
      const w = Math.exp(
        Math.log(from[2]) + (Math.log(to[2]) - Math.log(from[2])) * e,
      );
      const h = w * ((to[3] / to[2]) * e + (from[3] / from[2]) * (1 - e));
      const cx =
        from[0] + from[2] / 2 + (to[0] + to[2] / 2 - from[0] - from[2] / 2) * e;
      const cy =
        from[1] + from[3] / 2 + (to[1] + to[3] / 2 - from[1] - from[3] / 2) * e;
      setVB([cx - w / 2, cy - h / 2, w, h]);
      t < 1 ? requestAnimationFrame(step) : done();
    };
    requestAnimationFrame(step);
  });
}

async function load() {
  const [raw, countries, sat] = await Promise.all([
    json("/demo-data.json"),
    json("/countries.json"),
    json("/sat.json"),
  ]);
  snapshot = adaptSnapshot(raw);
  CTRY = countries;
  snapshotSat = Object.fromEntries(
    Object.entries(sat).map(([k, m]) => [
      k,
      { ...m, src: new URL("/" + m.src, location.origin).href },
    ]),
  );
  DATA = snapshot;
  SAT = snapshotSat;
  installControls();
  backend = mountBackendTools({
    client,
    getDataset: () => DATA,
    selectApiDataset: () => changeDataset("api"),
    selectField: async (id) => {
      const e = fieldEntry(id);
      if (e) {
        $("mapapp").scrollIntoView({ behavior: reduce ? "auto" : "smooth" });
        await select(e.index, e.tile);
      }
    },
  });
  await activateDataset(DATA);
  await restoreLocation();
}
function drawBase() {
  const ring = (r) =>
    "M" +
    r
      .map(([x, y]) =>
        P(x, y)
          .map((v) => v.toFixed(0))
          .join(","),
      )
      .join("L") +
    "Z";
  const ctry = Object.entries(CTRY)
    .map(
      ([name, rings]) =>
        `<path class="ctry${name === "India" ? " in" : name === "Pakistan" ? " pk" : ""}" d="${rings.map(ring).join("")}"><title>${esc(name)}</title></path>`,
    )
    .join("");
  const markers = Object.keys(DATA.tiles)
    .map((t) => {
      const [cx, cy] = P(...DATA.tiles[t].center);
      return `<g class="mk" data-tile="${esc(t)}" data-x="${cx}" data-y="${cy}" tabindex="0" role="button" aria-label="Explore ${esc(NICE[t])}"><circle class="ring" cx="${cx}" cy="${cy}"/><circle class="dot" cx="${cx}" cy="${cy}"/><text>${esc(NICE[t])}</text></g>`;
    })
    .join("");
  const img = (m) => {
    const [a, b] = P(m.b[0], m.b[3]),
      [c, d] = P(m.b[2], m.b[1]);
    return `<image href="${esc(m.src)}" x="${a}" y="${b}" width="${c - a}" height="${d - b}" preserveAspectRatio="none"/>`;
  };
  const images =
    img(SAT.country) +
    Object.keys(DATA.tiles)
      .map((t) => img(SAT[t + "_district"]) + img(SAT[t + "_fields"]))
      .join("");
  const [lx, ly] = P(70.2, 29.6),
    [ix, iy] = P(78.5, 22.5);
  svg.innerHTML = `<defs><pattern id="hatch" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect fill="#2a3238"/><line x1="0" y1="0" x2="0" stroke="#8A8F98"/></pattern></defs><g id="gI">${images}</g><g id="gC">${ctry}<text class="clabel" x="${ix}" y="${iy}" font-size="900">India</text><text class="clabel" x="${lx}" y="${ly}" font-size="700">Pakistan</text></g><g id="gM">${markers}</g><g id="gR"></g><g id="gF"></g>`;
  svg.querySelectorAll(".mk").forEach((g) => {
    const go = () => goTile(g.dataset.tile);
    g.addEventListener("click", go);
    g.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        go();
      }
    });
  });
  const controls = document.querySelector(".seg");
  controls.innerHTML = Object.keys(DATA.tiles)
    .map(
      (t) =>
        `<button class="segbtn" data-tile="${esc(t)}">${esc(NICE[t])}</button>`,
    )
    .join("");
  controls.querySelectorAll("button").forEach(
    (b) =>
      (b.onclick = () => {
        cancelTour();
        stopSeason();
        return goTile(b.dataset.tile);
      }),
  );
  setVB(COUNTRY_BOX());
  countryCard();
  loader.classList.add("hide");
}
async function activateDataset(dataset) {
  DATA = dataset;
  document.documentElement.style.setProperty(
    "--pass-count",
    Math.min(dataset.passes.length, 10),
  );
  datasetVersion++;
  navVersion++;
  fieldVersion++;
  heroVersion++;
  anim++;
  details.clear();
  detailPending.clear();
  overlays = null;
  overlayOn = false;
  pass = 0;
  selected = null;
  tile = Object.keys(DATA.tiles)[0];
  view = "country";
  for (const [t, area] of Object.entries(DATA.tiles)) NICE[t] = area.district;
  SAT = DATA.kind === "snapshot" ? snapshotSat : apiSat(DATA);
  $("mapapp").classList.remove("infields");
  $("datasetSelect").value = DATA.kind;
  $("activeRun").textContent =
    `Run ${DATA.run_id}${DATA.fixture ? " · Sample" : ""}`;
  $("mapStatus").textContent =
    `${allFields().length} fields · ${DATA.passes.length} passes`;
  document.querySelector(".map-attr").textContent =
    DATA.kind === "snapshot"
      ? "Imagery: Sentinel-2 cloudless 2016, EOX · CC BY 4.0"
      : "Imagery: Esri and contributors";
  slider.min = day(DATA.passes[0]);
  slider.max = day(DATA.passes.at(-1));
  slider.step = 86400000;
  const span = Number(slider.max) - Number(slider.min) || 1;
  $("ticks").innerHTML = DATA.passes
    .map(
      (d) =>
        `<span style="left:${(100 * (day(d) - Number(slider.min))) / span}%">${fmt(d)}</span>`,
    )
    .join("");
  document.querySelectorAll(".pass-gap").forEach(el=>el.remove());
  for(const gap of DATA.gaps){const el=document.createElement("span");el.className="pass-gap";el.title=`No data: ${fmt(gap.start)} to ${fmt(gap.end)}`;el.style.left=(100*(day(gap.start)-Number(slider.min))/span)+"%";el.style.width=(100*(day(gap.end)-day(gap.start))/span)+"%";document.querySelector(".slider-box").append(el);}
  drawBase();
  updateStatistics();
  seasonChart();
  await heroField(interesting(tile), tile);
  paint();
  backend?.refresh();
  updateRadar();
  if (DATA.kind === "api") {
    const current = DATA;
    getApiOverlays(client, current)
      .then((index) => {
        if (DATA === current) {
          overlays = index;
          updateRadar();
        }
      })
      .catch((error) => {
        if (DATA === current) {
          $("radarToggle").title = errorText(error);
        }
      });
  }
}
async function changeDataset(kind) {
  stopSeason();
  cancelTour();
  const token = ++changeVersion,
    selectEl = $("datasetSelect");
  selectEl.disabled = true;
  $("dataStatus").textContent = "Loading dataset";
  try {
    const next = kind === "snapshot" ? snapshot : await loadApiDataset(client);
    if (token !== changeVersion) return;
    await activateDataset(next);
    syncURL(true);
    $("dataStatus").textContent = "";
  } catch (error) {
    if (token === changeVersion) {
      selectEl.value = DATA.kind;
      $("dataStatus").textContent =
        `${errorText(error)}. Retry the dataset selection.`;
    }
  } finally {
    if (token === changeVersion) selectEl.disabled = false;
  }
}
function updateStatistics() {
  const fields = allFields(),
    total = fields.length * DATA.passes.length;
  const uncertain = fields.reduce(
    (n, f) => n + [...f.s].filter((c) => c === "u").length,
    0,
  );
  for (const [id, value] of Object.entries({
    liveFieldCount: fields.length.toLocaleString(),
    livePassCount: DATA.passes.length,
    liveUncertainPct: Math.round((100 * uncertain) / total) + "%",
    liveGapDays: DATA.gaps.reduce(
      (n, g) => n + Math.round((day(g.end) - day(g.start)) / 86400000),
      0,
    ),
    pvPassCount: DATA.passes.length,
    pvFieldCount: fields.length.toLocaleString(),
  })) {
    if ($(id)) $(id).textContent = value;
  }
  document.querySelector("#map .sub").textContent =
    `Explore ${fields.length.toLocaleString()} fields across ${Object.keys(DATA.tiles).length} study areas, then play through ${DATA.passes.length} radar acquisitions.`;
  document.querySelector("#season h2").textContent =
    `${fields.length.toLocaleString()} fields across Kharif ${DATA.passes[0].slice(0, 4)}`;
  document.querySelector("#season .sub").textContent = `${Object.values(
    DATA.tiles,
  )
    .map((t) => t.district)
    .join(" and ")} · ${fmt(DATA.passes[0])} to ${fmt(DATA.passes.at(-1))}`;
  document.querySelector(".tl-head>span").textContent =
    "Share of fields by model state";
}

function countryCard() {
  card.innerHTML = `<div class="fc-id">Punjab, India</div><div class="fc-meta">Kharif ${esc(DATA.passes[0].slice(0, 4))}</div><div class="fc-verdict">Explore a study area</div><p class="fc-text">Choose a district, select a field, and follow its radar observations through the season.</p><div class="fc-pick">${Object.keys(
    DATA.tiles,
  )
    .map(
      (t) =>
        `<button class="pickbtn" data-tile="${esc(t)}"><b>${esc(NICE[t])}</b><span>${DATA.tiles[t].fields.length} mapped fields</span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M9 6l6 6-6 6"/></svg></button>`,
    )
    .join("")}</div>`;
  card
    .querySelectorAll(".pickbtn")
    .forEach((b) => (b.onclick = () => goTile(b.dataset.tile)));
}

function drawFields() {
  const fs = DATA.tiles[tile].fields;
  $("gF").innerHTML = fs
    .map(
      (f, i) =>
        `<path data-i="${i}" tabindex="${i === 0 ? 0 : -1}" role="button" aria-label="Field ${esc(f.id)}" fill-rule="evenodd" d="${ringsOf(
          f,
        )
          .map(
            (r) =>
              "M" +
              r
                .map(([x, y]) =>
                  P(x, y)
                    .map((v) => v.toFixed(3))
                    .join(","),
                )
                .join("L") +
              "Z",
          )
          .join("")}"><title>${esc(f.id)}</title></path>`,
    )
    .join("");
  $("gF")
    .querySelectorAll("path")
    .forEach((p) => {
      p.onclick = () => {
        if (!dragged) select(+p.dataset.i);
      };
      p.onkeydown = (e) => {
        if (["ArrowRight", "ArrowLeft", "ArrowDown", "ArrowUp"].includes(e.key)) {
          e.preventDefault();
          const paths=[...$("gF").querySelectorAll("path")];
          const next=(Number(p.dataset.i)+(["ArrowRight","ArrowDown"].includes(e.key)?1:-1)+paths.length)%paths.length;
          paths.forEach((path,i)=>path.setAttribute("tabindex",i===next?"0":"-1")); paths[next].focus(); return;
        }
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          select(+p.dataset.i);
        }
      };
    });
  status.textContent = `${NICE[tile]} · ${fs.length} fields`;
  paint();
}
async function goTile(t) {
  if (!DATA.tiles[t]) return;
  const token = ++navVersion;
  const switching = view === "fields";
  tile = t;
  selected = null;
  fieldVersion++;
  view = "fields";
  $("mapapp").classList.add("infields");
  document
    .querySelectorAll(".segbtn")
    .forEach((b) => b.classList.toggle("on", b.dataset.tile === t));
  card.innerHTML =
    '<p class="fc-empty">Select a field to inspect its observations</p>';
  drawFields();
  const m = SAT[t + "_district"].b;
  await fly(
    boxOf(
      [
        [m[0], m[1]],
        [m[2], m[3]],
      ],
      0.02,
    ),
    switching ? 500 : 1000,
  );
  if (token !== navVersion) return;
  await fly(tileBox(t), 900);
  if (token !== navVersion) return;
  syncURL();
}
async function goCountry() {
  stopSeason();
  navVersion++;
  fieldVersion++;
  view = "country";
  selected = null;
  $("mapapp").classList.remove("infields");
  document.querySelectorAll(".segbtn").forEach((b) => b.classList.remove("on"));
  countryCard();
  status.textContent = `India · ${Object.keys(DATA.tiles).length} study areas`;
  $("gR").replaceChildren();
  await fly(COUNTRY_BOX(), 900);
  syncURL();
}

function paint() {
  const fs = DATA.tiles[tile].fields;
  $("gF")
    .querySelectorAll("path")
    .forEach((p, i) => {
      const c = fs[i].s[pass];
      p.setAttribute(
        "class",
        (c === "-" ? "n" : c) + (selected === i ? " sel" : ""),
      );
    });
  slider.value = day(DATA.passes[pass]);
  slider.setAttribute("aria-valuetext", fmt(DATA.passes[pass]));
  updateRadar();
  dateEl.textContent = fmt(DATA.passes[pass]);
  if (selected !== null) renderCard(selected, false);
}

function verdictLine(s) {
  const clear = [...s].filter((c) => c === "f" || c === "d").length,
    dry = [...s].filter((c) => c === "d").length;
  return [
    `Drained on ${dry} of ${clear} clear passes`,
    `${[...s].filter((c) => c === "u").length} uncertain observations`,
  ];
}
function detailMarkup(detail) {
  if (!detail) return "";
  const o = detail.observations.find((o) => o.pass_id === DATA.passIds[pass]),
    m = (v) => (v == null ? "Unavailable" : Number(v).toFixed(2) + " dB");
  return `<details class="model-details"><summary>Radar and model details</summary><dl><dt>Flooded probability</dt><dd>${o?.inferred.p_flooded == null ? "Unavailable" : Math.round(o.inferred.p_flooded * 100) + "%"}</dd><dt>Classifier</dt><dd>${esc(o?.inferred.method || "Unavailable")}</dd><dt>HV</dt><dd>${m(o?.observed.hv_db)}</dd><dt>Surface</dt><dd>${m(o?.observed.ps_db)}</dd><dt>Double bounce</dt><dd>${m(o?.observed.pd_db)}</dd><dt>Volume</dt><dd>${m(o?.observed.pv_db)}</dd><dt>Flags</dt><dd>${esc(o?.flags?.join(", ") || "None")}</dd></dl><p>${esc(detail.summary?.awd.reason || "")}</p><p>${esc(detail.summary?.dsr.reason || "")}</p></details>`;
}
async function renderCard(i, withLoad = true) {
  const dataset = DATA,
    f = dataset.tiles[tile]?.fields[i];
  if (!f) return;
  const token = fieldVersion;
  if (dataset.kind === "api" && !details.has(f.id)) {
    if (!withLoad) return;
    card.innerHTML = '<p class="fc-empty">Loading field observations</p>';
    try {
      await detailFor(f);
    } catch (error) {
      if (DATA === dataset && token === fieldVersion) {
        card.innerHTML = `<p class="fc-empty" role="alert">${esc(errorText(error))}</p><button id="retryField" class="btn btn-ghost">Retry field</button>`;
        $("retryField").onclick = () => renderCard(i, true);
      }
      return;
    }
  }
  if (DATA !== dataset || token !== fieldVersion || selected !== i) return;
  const wasOpen = card.querySelector(".model-details")?.open;
  const [v, why] = verdictLine(f.s),
    vals = f.hh.filter(Number.isFinite),
    lo = vals.length ? Math.min(...vals) : 0,
    hi = vals.length ? Math.max(...vals) : 0;
  const dates = DATA.passes.map(day),
    range = dates.at(-1) - dates[0] || 1;
  let path = "",
    start = true;
  const pts = [];
  f.hh.forEach((value, j) => {
    if (value == null) {
      start = true;
      return;
    }
    const p = [
      (300 * (dates[j] - dates[0])) / range,
      50 - ((value - lo) / (hi - lo || 1)) * 44,
    ];
    path += (start ? "M" : "L") + p.join(",");
    start = false;
    pts.push(p);
  });
  const conf = f.c[pass];
  card.innerHTML = `<div class="fc-id">${esc(f.id)}</div><div class="fc-meta">${esc(NICE[tile])} · ${Number(f.ha).toFixed(2)} ha${f.rice === null ? "" : ` · ${Math.round(f.rice * 100)}% rice cover`}</div><div class="fc-verdict">${v}<small>${why}</small></div><div class="chips">${[...f.s].map((c, j) => `<button class="chip${j === pass ? " now" : ""}" data-field-pass="${j}" title="${fmt(DATA.passes[j])}: ${stateLabel(c)}" aria-label="${fmt(DATA.passes[j])}, ${stateLabel(c)}"><span class="${c === "-" ? "n" : c}"></span><em>${fmt(DATA.passes[j]).replace(" ", "<br>")}</em></button>`).join("")}</div><div class="spark"><small><span>HH backscatter</span><span>${vals.length ? lo.toFixed(1) + " to " + hi.toFixed(1) + " dB" : "Unavailable"}</span></small><svg viewBox="-4 -4 308 62" preserveAspectRatio="none" role="img" aria-label="HH backscatter by acquisition"><path d="${path}" fill="none" stroke="#EAE6DA" stroke-width="1.5"/>${pts.map((p) => `<circle cx="${p[0]}" cy="${p[1]}" r="2.5" fill="#EAE6DA"/>`).join("")}</svg></div><div class="fc-foot"><div><b>${stateLabel(f.s[pass])}</b>${fmt(DATA.passes[pass])}</div><div><b>${conf == null ? "Unavailable" : conf.toFixed(2)}</b>classifier confidence</div></div>${detailMarkup(details.get(f.id))}`;
  if (wasOpen && card.querySelector(".model-details"))
    card.querySelector(".model-details").open = true;
  card.querySelectorAll("[data-field-pass]").forEach(
    (b) =>
      (b.onclick = () => {
        stopSeason();
        pass = Number(b.dataset.fieldPass);
        paint();
        syncURL();
      }),
  );
}
async function select(i, t, push = true) {
  stopSeason();
  const dataset = DATA;
  if (view !== "fields" || (t && t !== tile)) await goTile(t || tile);
  if (DATA !== dataset) return;
  selected = i;
  fieldVersion++;
  paint();
  await renderCard(i, true);
  if (DATA === dataset) syncURL(push);
}
$("backBtn").addEventListener("click", () => {
  cancelTour();
  goCountry();
});
slider.addEventListener("input", () => {
  cancelTour();
  stopSeason();
  const value = Number(slider.value);
  pass = DATA.passes.reduce(
    (best, d, i) =>
      Math.abs(day(d) - value) < Math.abs(day(DATA.passes[best]) - value)
        ? i
        : best,
    0,
  );
  paint();
  syncURL();
});

// play the season: 600 ms per pass, hold 1 s on the data gap (spec D6)
const playBtn = $("playBtn");
let playToken = 0;
function setPlayLabel(on) {
  playBtn.querySelector(".txt").textContent = on ? "Pause" : "Play";
  playBtn.setAttribute("aria-label", on ? "Pause season" : "Play season");
  playBtn.setAttribute("aria-pressed", String(on));
  playBtn.querySelector(".ico").innerHTML =
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">${on ? '<path d="M8 5v14M16 5v14"/>' : '<path d="m8 5 11 7-11 7z"/>'}</svg>`;
}
async function playSeason() {
  const me = ++playToken,
    dataset = DATA;
  playing = true;
  setPlayLabel(true);
  for (let index = 0; index < dataset.passes.length; index++) {
    if (me !== playToken || DATA !== dataset) return;
    pass = index;
    paint();
    await wait(600);
    if (me !== playToken || DATA !== dataset) return;
    if (
      index < dataset.passes.length - 1 &&
      gapBetween(dataset.passes[index], dataset.passes[index + 1])
    ) {
      dateEl.textContent = "No data";
      dateEl.parentElement.classList.add("gap");
      await wait(1000);
      if (me !== playToken || DATA !== dataset) return;
      dateEl.parentElement.classList.remove("gap");
    }
  }
  if (me === playToken && DATA === dataset) {
    playing = false;
    setPlayLabel(false);
    paint();
    syncURL();
  }
}

function stopSeason() {
  if (playing) sfx.tick();
  playToken++;
  playing = false;
  setPlayLabel(false);
  dateEl.parentElement.classList.remove("gap");
  paint();
}
playBtn.addEventListener("click", async () => {
  if (playing) return stopSeason();
  if (view !== "fields") await goTile(tile);
  playSeason();
});
slider.addEventListener("pointerdown", stopSeason);

// season shape: share of all 375 real fields in each state on each pass (stacked area, gap band shaded)
function seasonChart() {
  const svgS = $("seasonSvg"),
    tip = $("seasonTip");
  const all = Object.values(DATA.tiles).flatMap((t) => t.fields);
  const days = DATA.passes.map(
    (d) => (Date.parse(d) - Date.parse(DATA.passes[0])) / 864e5,
  );
  const share = DATA.passes.map((_, j) => {
    const c = { f: 0, d: 0, u: 0 };
    all.forEach((f) => {
      const k = f.s[j];
      if (k in c) c[k]++;
    });
    const n = c.f + c.d + c.u || 1;
    return { f: c.f / n, d: c.d / n, u: c.u / n };
  });
  const W = 1000,
    H = 300,
    L = 44,
    B = 28,
    x = (d) => L + (d / days[days.length - 1]) * (W - L - 8),
    y = (v) => (H - B) * (1 - v);
  const gaps = DATA.gaps.map((g) => ({
    g0: (day(g.start) - day(DATA.passes[0])) / 864e5,
    g1: (day(g.end) - day(DATA.passes[0])) / 864e5,
  }));
  const area = (lo, hi) =>
    "M" +
    days.map((d, j) => `${x(d)},${y(hi(j))}`).join("L") +
    "L" +
    days
      .map((d, j) => `${x(d)},${y(lo(j))}`)
      .reverse()
      .join("L") +
    "Z";
  const F = (j) => share[j].f,
    FD = (j) => share[j].f + share[j].d;
  svgS.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svgS.innerHTML = `<defs><pattern id="gapHatch" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="8" height="8" fill="rgba(234,230,218,.02)"/><line x1="0" y1="0" x2="0" y2="8" stroke="rgba(234,230,218,.12)" stroke-width="2"/></pattern>
      <pattern id="uHatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="6" height="6" fill="#26353b"/><line x1="0" y1="0" x2="0" y2="6" stroke="#5d6a70" stroke-width="2"/></pattern></defs>
    ${[0, 0.25, 0.5, 0.75, 1].map((v) => `<line class="grid" x1="${L}" x2="${W - 8}" y1="${y(v)}" y2="${y(v)}"/><text class="ax" x="${L - 8}" y="${y(v) + 4}" text-anchor="end">${v * 100}%</text>`).join("")}
    <path class="area" d="${area(() => 0, F)}" fill="var(--water)" fill-opacity=".85"/>
    <path class="area" d="${area(F, FD)}" fill="var(--mud)" fill-opacity=".85"/>
    <path class="area" d="${area(FD, () => 1)}" fill="url(#uHatch)"/>
    ${gaps.map(({ g0, g1 }) => `<rect class="band" x="${x(g0)}" y="0" width="${x(g1) - x(g0)}" height="${H - B}"/><text class="ax" x="${(x(g0) + x(g1)) / 2}" y="16" text-anchor="middle">No data</text>`).join("")}
    ${days.map((d, j) => `<circle cx="${x(d)}" cy="${y(F(j))}" r="2.5" fill="#0E1A1F" stroke="var(--water)"/><text class="ax" x="${x(d)}" y="${H - 8}" text-anchor="middle">${fmt(DATA.passes[j])}</text>`).join("")}
    <line class="cursor" id="sCur" y1="0" y2="${H - B}"/>`;
  const cur = $("sCur");
  svgS.onpointermove = (e) => {
    const r = svgS.getBoundingClientRect(),
      px = ((e.clientX - r.left) / r.width) * W;
    let j = 0;
    days.forEach((d, k) => {
      if (Math.abs(x(d) - px) < Math.abs(x(days[j]) - px)) j = k;
    });
    cur.setAttribute("x1", x(days[j]));
    cur.setAttribute("x2", x(days[j]));
    const s = share[j],
      pct = (v) => Math.round(v * 100) + "%";
    tip.innerHTML = `<b>${fmt(DATA.passes[j])}</b><i style="background:var(--water)"></i>flooded ${pct(s.f)}<br><i style="background:var(--mud)"></i>drained ${pct(s.d)}<br><i style="background:#5d6a70"></i>uncertain ${pct(s.u)}`;
    tip.style.left =
      Math.min(r.width - 150, (x(days[j]) / W) * r.width + 12) + "px";
    tip.style.opacity = 1;
  };
  svgS.onpointerleave = () => (tip.style.opacity = 0);
}

// pick a field with a clear flood-then-dry story for demos
function interesting(t = tile) {
  const fs = DATA.tiles[t].fields;
  const good = fs
    .map((f, i) => [f, i])
    .filter(
      ([f]) =>
        f.poly.length >= 12 &&
        /^f+.*d/.test(f.s.replace(/u/g, "")) &&
        (f.s.match(/u/g) || []).length <= 2,
    );
  return (good.length ? good : fs.map((f, i) => [f, i]))[
    Math.floor(Math.random() * (good.length || fs.length))
  ][1];
}

// hero mini-map: the real satellite view around the field, zooming in from the district to the paddy
let heroAnim = 0;
function heroMap(f, t) {
  const m = $("pvMap"),
    sat = SAT[t + "_fields"],
    district = SAT[t + "_district"];
  const [a, b] = P(sat.b[0], sat.b[3]),
    [c, d] = P(sat.b[2], sat.b[1]);
  const pts = f.poly.map(([x, y]) => P(x, y));
  const xs = pts.map((p) => p[0]),
    ys = pts.map((p) => p[1]);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2,
    cy = (Math.min(...ys) + Math.max(...ys)) / 2;
  const span =
    Math.max(
      Math.max(...xs) - Math.min(...xs),
      (Math.max(...ys) - Math.min(...ys)) * 2.6,
    ) * 2.4;
  const col = { f: "#3FD0C9", d: "#E2725B", u: "#9aa3a8", "-": "#9aa3a8" }[
    f.s[f.s.length - 1]
  ];
  m.setAttribute("preserveAspectRatio", "xMidYMid slice");
  const [da, db] = P(district.b[0], district.b[3]),
    [dc, dd] = P(district.b[2], district.b[1]);
  m.innerHTML = `<image href="${esc(district.src)}" x="${da}" y="${db}" width="${dc - da}" height="${dd - db}" preserveAspectRatio="none"/><image href="${esc(sat.src)}" x="${a}" y="${b}" width="${c - a}" height="${d - b}" preserveAspectRatio="none"/>
    <path class="hf" d="M${pts.map((p) => p.map((v) => v.toFixed(2)).join(",")).join("L")}Z" fill="${col}" fill-opacity=".38" stroke="${col}" stroke-width="2.5" vector-effect="non-scaling-stroke" stroke-linejoin="round"/>
    <path class="hf-ring" d="M${pts.map((p) => p.map((v) => v.toFixed(2)).join(",")).join("L")}Z" fill="none" stroke="#fff" stroke-width="1" vector-effect="non-scaling-stroke" stroke-dasharray="4 4"/>`;
  const id = ++heroAnim,
    t0 = performance.now(),
    w0 = span * 7,
    w1 = span,
    ratio = 150 / 400;
  const step = (now) => {
    if (id !== heroAnim) return;
    const t = reduce ? 1 : Math.min(1, (now - t0) / 1600),
      e = 1 - Math.pow(1 - t, 3);
    const w = Math.exp(Math.log(w0) + (Math.log(w1) - Math.log(w0)) * e),
      h = w * ratio;
    m.setAttribute("viewBox", `${cx - w / 2} ${cy - h / 2} ${w} ${h}`);
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
  $("pvLabel").textContent = `This field · ${f.ha} ha`;
  const [lon, lat] = f.poly.reduce(
    (q, [x, y]) => [q[0] + x / f.poly.length, q[1] + y / f.poly.length],
    [0, 0],
  );
  $("pvCoords").textContent = `${lat.toFixed(4)}° N, ${lon.toFixed(4)}° E`;
}

// hero card shows a real field too
async function heroField(i, t = tile) {
  const dataset = DATA,
    f = dataset.tiles[t].fields[i],
    token = ++heroVersion;
  if (dataset.kind === "api") {
    try {
      await detailFor(f);
    } catch {
      if (DATA === dataset && token === heroVersion)
        $("pvConf").textContent = "Unavailable";
    }
  }
  if (DATA !== dataset || token !== heroVersion) return;
  heroMap(f, t);
  const [v] = verdictLine(f.s);
  $("pvQuery").textContent = f.id;
  $("pvMeta").textContent = `${NICE[t]} · ${Number(f.ha).toFixed(2)} ha`;
  $("pvVerdict").textContent = v;
  const cs = f.c.filter(Number.isFinite);
  $("pvConf").textContent = cs.length
    ? (cs.reduce((a, b) => a + b, 0) / cs.length).toFixed(2)
    : "Unavailable";
  $("pvPasses").innerHTML = [...f.s]
    .map(
      (c, j) =>
        `<div class="pcol" title="${fmt(DATA.passes[j])}: ${stateLabel(c)}"><span class="${c === "-" ? "u" : c}"></span><em>${fmt(DATA.passes[j]).replace(" ", "<br>")}</em></div>`,
    )
    .join("");
}

// replace the placeholder hero button handlers with real ones
function rewire(sel, fn) {
  const old = document.querySelector(sel);
  const b = old.cloneNode(true);
  old.replaceWith(b);
  b.addEventListener("click", async (e) => {
    e.preventDefault();
    if (b.classList.contains("loading")) return;
    sfx.tick();
    b.classList.add("loading");
    await fn(b);
    b.classList.remove("loading");
  });
}

try {
  await load();
} catch (error) {
  loader.classList.remove("hide");
  loader.textContent = "Could not load the map. " + errorText(error);
  card.innerHTML = `<p role="alert">${esc(errorText(error))}</p><button class="btn btn-ghost" id="retryPage">Retry</button>`;
  $("retryPage").onclick = () => location.reload();
}

async function testRandom(b) {
  const txt = b.querySelector(".txt");
  txt.textContent = "Loading field";
  const pv = $("preview");
  pv.classList.add("scanning");
  const keys = Object.keys(DATA.tiles),
    t = keys[Math.floor(Math.random() * keys.length)];
  await heroField(interesting(t), t);
  requestAnimationFrame(() => pv.classList.remove("scanning"));
  sfx.chime();
  txt.textContent = "Inspect another field";
}
rewire('[data-load="check"]', testRandom);
rewire('[data-load="explore"]', async () => {
  $("mapapp").scrollIntoView({
    behavior: reduce ? "auto" : "smooth",
    block: "center",
  });
  await wait(700);
  if (view === "country") goTile("fazilka");
});

function cancelTour() {
  tourVersion++;
  touring = false;
  cap.textContent = "";
  cap.classList.remove("on");
  $("mapapp").classList.remove("touring");
  const b = document.querySelector('[data-load="tour"] .txt');
  if (b) b.textContent = "Take the tour";
}
rewire('[data-load="tour"]', async (b) => {
  if (touring) {
    cancelTour();
    return;
  }
  const current = ++tourVersion;
  touring = true;
  const valid = () => current === tourVersion;
  stopSeason();
  $("mapapp").scrollIntoView({
    behavior: reduce ? "auto" : "smooth",
    block: "center",
  });
  b.querySelector(".txt").textContent = "Tour running";
  $("mapapp").classList.add("touring");
  say("Choose a study area");
  await goCountry();
  if (!valid()) return;
  await wait(1500);
  if (!valid()) return;
  say("Explore the fields in " + NICE[Object.keys(DATA.tiles)[0]]);
  await goTile(Object.keys(DATA.tiles)[0]);
  if (!valid()) return;
  say("Follow the acquisitions through the season");
  await playSeason();
  if (!valid()) return;
  say("Select a field for its measurements");
  await select(interesting());
  if (!valid()) return;
  await wait(2000);
  if (valid()) cancelTour();
});

function updateRadar() {
  const group = $("gR"),
    button = $("radarToggle");
  if (!group || !button) return;
  group.replaceChildren();
  const item =
    DATA.kind === "api"
      ? overlays?.overlays.find(
          (o) => o.tile === tile && o.pass_id === DATA.passIds[pass],
        )
      : null;
  button.disabled = !item;
  button.setAttribute("aria-pressed", String(Boolean(item && overlayOn)));
  button.classList.toggle("on", Boolean(item && overlayOn));
  button.title = item
    ? "Radar image for " + fmt(DATA.passes[pass])
    : "No indexed radar image for this acquisition";
  if (!item || !overlayOn || view !== "fields") return;
  const points = item.coordinates.map(([x, y]) => P(x, y)),
    [a, b, c, d] = points;
  if (
    Math.abs(c[0] - (b[0] + d[0] - a[0])) > 0.01 ||
    Math.abs(c[1] - (b[1] + d[1] - a[1])) > 0.01
  ) {
    button.title = "Unsupported image footprint";
    return;
  }
  const indexUrl = new URL(
      DATA.apiMeta.assets.overlays_index,
      import.meta.env.VITE_API_BASE_URL || "https://mudskipper-nisar.pages.dev",
    ),
    url = new URL(item.url, new URL("../", indexUrl));
  group.innerHTML = `<image href="${esc(url.href)}" width="1" height="1" preserveAspectRatio="none" transform="matrix(${b[0] - a[0]} ${b[1] - a[1]} ${d[0] - a[0]} ${d[1] - a[1]} ${a[0]} ${a[1]})" opacity=".8"/>`;
}
function syncURL(push = false) {
  if (restoring || !DATA) return;
  const q = new URLSearchParams();
  q.set("dataset", DATA.kind);
  q.set("tile", tile);
  q.set("pass", DATA.passIds[pass]);
  if (selected !== null && DATA.tiles[tile]?.fields[selected])
    q.set("field", DATA.tiles[tile].fields[selected].id);
  const url = "/?" + q + (location.hash || "");
  if (url === location.pathname + location.search + location.hash) return;
  history[push ? "pushState" : "replaceState"]({}, "", url);
}
async function restoreLocation() {
  const path = location.pathname,
    q = new URLSearchParams(location.search),
    wanted =
      q.get("dataset") ||
      (["/lab", "/scarecrow", "/evidence"].includes(path) ? "api" : "snapshot"),
    id =
      q.get("field") ||
      (path.startsWith("/field/") ? decodeURIComponent(path.slice(7)) : null);
  restoring = true;
  try {
    if (wanted !== DATA.kind) await changeDataset(wanted);
    if (id && !fieldEntry(id) && !q.has("dataset") && DATA.kind === "snapshot")
      await changeDataset("api");
    const index = DATA.passIds.indexOf(q.get("pass") || "");
    if (index >= 0) pass = index;
    const entry = id ? fieldEntry(id) : null;
    if (entry) await select(entry.index, entry.tile, false);
    else if (q.get("tile") && DATA.tiles[q.get("tile")])
      await goTile(q.get("tile"));
    if (["/lab", "/scarecrow", "/evidence"].includes(path)) {
      const name =
        path === "/lab"
          ? "lab"
          : path === "/scarecrow"
            ? "inspection"
            : "evidence";
      backend.refresh();
      document.querySelector(`[data-tool="${name}"]`)?.click();
      $("analysis").scrollIntoView();
    } else if (path === "/methods") $("method").scrollIntoView();
    else if (path === "/judges") $("story").scrollIntoView();
  } finally {
    restoring = false;
    syncURL();
  }
}
function installControls() {
  const bar = document.querySelector(".map-bar");
  bar.insertAdjacentHTML(
    "beforeend",
    `<form id="fieldSearch" class="field-search"><label class="sr-only" for="searchField">Field ID</label><input id="searchField" placeholder="Search field ID" required autocomplete="off"><button aria-label="Find field" title="Find field"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.5 15.5 4 4"/></svg></button></form><span id="dataStatus" role="status"></span>`,
  );
  $("fieldSearch").onsubmit = async (e) => {
    e.preventDefault();
    cancelTour();
    stopSeason();
    const found = fieldEntry($("searchField").value.trim());
    if (!found) {
      $("dataStatus").textContent = "Field ID unavailable in this dataset";
      return;
    }
    $("dataStatus").textContent = "";
    await select(found.index, found.tile);
  };
  $("datasetSelect").onchange = () => changeDataset($("datasetSelect").value);
  document
    .querySelector(".slider-row")
    .insertAdjacentHTML(
      "beforeend",
      '<button class="radar-switch" id="radarToggle" aria-pressed="false" disabled>Radar image</button>',
    );
  $("radarToggle").onclick = () => {
    overlayOn = !overlayOn;
    updateRadar();
  };
  document
    .querySelector(".map-wrap")
    .insertAdjacentHTML(
      "beforeend",
      `<div class="map-controls"><button id="zoomIn" aria-label="Zoom in">+</button><button id="zoomOut" aria-label="Zoom out">−</button><button id="resetView" aria-label="Reset map">Reset</button></div>`,
    );
  const zoom = (factor, point) => {
    anim++;
    const [cx, cy] = point || [vb[0] + vb[2] / 2, vb[1] + vb[3] / 2],
      w = Math.max(0.5, Math.min(COUNTRY_BOX()[2] * 1.4, vb[2] * factor)),
      ratio = w / vb[2];
    setVB([
      cx - (cx - vb[0]) * ratio,
      cy - (cy - vb[1]) * ratio,
      w,
      vb[3] * ratio,
    ]);
  };
  $("zoomIn").onclick = () => {
    cancelTour();
    stopSeason();
    zoom(0.65);
  };
  $("zoomOut").onclick = () => {
    cancelTour();
    stopSeason();
    zoom(1.5);
  };
  $("resetView").onclick = () => {
    cancelTour();
    stopSeason();
    fly(view === "country" ? COUNTRY_BOX() : tileBox(tile), 500);
  };
  const screenPoint = (e) => {
    const point = new DOMPoint(e.clientX, e.clientY);
    return point.matrixTransform(svg.getScreenCTM().inverse());
  };
  svg.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      cancelTour();
      stopSeason();
      const p = screenPoint(e);
      zoom(e.deltaY > 0 ? 1.15 : 0.87, [p.x, p.y]);
    },
    { passive: false },
  );
  let dragging;
  svg.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    cancelTour();
    stopSeason();
    dragged = false;
    const p = screenPoint(e);
    dragging = {
      x: p.x,
      y: p.y,
      vb: vb.slice(),
      matrix: svg.getScreenCTM().inverse(),
      clientX: e.clientX,
      clientY: e.clientY,
    };
  });
  svg.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(
      dragging.matrix,
    );
    if (
      Math.hypot(e.clientX - dragging.clientX, e.clientY - dragging.clientY) > 4
    )
      dragged = true;
    if (dragged) {
      anim++;
      const d = dragging;
      setVB([d.vb[0] - (p.x - d.x), d.vb[1] - (p.y - d.y), d.vb[2], d.vb[3]]);
    }
  });
  window.addEventListener("pointerup", () => {
    dragging = null;
  });
  svg.addEventListener("pointercancel", () => {
    dragging = null;
  });
  window.addEventListener("popstate", () => {
    stopSeason();
    cancelTour();
    restoreLocation();
  });
  document.querySelectorAll(".api2>div:not(.api-head)").forEach((row) => {
    const code = row.querySelectorAll("code")[1];
    if (!code || code.textContent.includes(":")) return;
    const path = code.textContent;
    if (row.querySelector("code")?.textContent === "GET") {
      code.innerHTML = `<a href="${esc((import.meta.env.VITE_API_BASE_URL || "https://mudskipper-nisar.pages.dev") + path)}" target="_blank" rel="noreferrer">${esc(path)}</a>`;
    }
  });
}
