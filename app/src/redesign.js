import {
  adaptSnapshot,
  loadApiDataset,
  getApiFieldDetails,
  getApiOverlays,
  createBackend,
} from "./data.ts";
import { mountBackendTools } from "./backend.ts";
import { setJourneyField } from "./journey.ts";
import "./integration.css";
const backendOrigin = import.meta.env.VITE_API_BASE_URL || "https://mudskipper-nisar.pages.dev";
const client = createBackend(backendOrigin);
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
  selectionVersion = 0,
  heroVersion = 0,
  overlays = null,
  overlayOn = false,
  backend,
  componentUI,
  dragged = false,
  restoring = false,
  restoreVersion = 0,
  searchFieldIds = [];
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
// Motion is off when the system asks for reduced motion or the visitor presses "Pause animations"
// (WCAG 2.2.2). Read it at the moment of each animation so either change applies at once.
const motionQuery = matchMedia("(prefers-reduced-motion: reduce)");
const MOTION_KEY = "mudskipper:motion-paused";
const motionOff = () =>
  motionQuery.matches ||
  document.documentElement.classList.contains("motion-paused");
const $ = (id) => document.getElementById(id);
const announceMap = (text) => {
  const region = $("mapAnnounce");
  if (!region) return;
  // Clear first so repeating the same message is announced again.
  region.textContent = "";
  setTimeout(() => (region.textContent = text), 60);
};
// Wire the pause control before data loads, so it works even when the map cannot load.
installMotionToggle();
// Keep focused elements clear of the fixed navigation at any height (WCAG 2.4.11): scroll padding follows it.
{
  const nav = document.querySelector("nav");
  const setNavHeight = () =>
    document.documentElement.style.setProperty(
      "--nav-h",
      Math.ceil(nav.getBoundingClientRect().height) + "px",
    );
  setNavHeight();
  new ResizeObserver(setNavHeight).observe(nav);
}
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
// Playback and tour pacing are reading time, not motion, so they keep their timing when motion is off.
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
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
      const t = motionOff() ? 1 : Math.min(1, (now - t0) / ms),
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
  $("datasetSelect").querySelector('[value="snapshot"]').textContent = "Archive · 375-field snapshot";
  $("datasetSelect").querySelector('[value="api"]').textContent = "Published model run";
  backend = mountBackendTools({
    client,
    getDataset: () => DATA,
    selectApiDataset: () => changeDataset("api"),
    selectField: async (id) => {
      const e = fieldEntry(id);
      if (e) {
        $("mapapp").scrollIntoView({ behavior: motionOff() ? "auto" : "smooth" });
        await select(e.index, e.tile);
        // The ranked list is far below the map: move focus to the report that just opened (WCAG 2.4.3).
        if (selected === e.index && tile === e.tile) card.focus({ preventScroll: true });
      }
    },
  });
  await activateDataset(DATA);
  await restoreLocation();
  const { mountComponents } = await import("./components.ts");
  componentUI = mountComponents({
    dataset: DATA,
    apiBaseUrl: backendOrigin,
    getJSON: (path) => json(new URL(path, backendOrigin).href),
    getFieldDetail: (field) => detailFor(field),
    selectField: async (id) => {
      const entry = fieldEntry(id);
      if (!entry) return;
      $("mapapp").scrollIntoView({ behavior: motionOff() ? "auto" : "smooth" });
      await select(entry.index, entry.tile);
      card.focus({ preventScroll: true });
    },
  });
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
  // Imagery, outlines and labels are background for the interactive markers and fields, so they are
  // hidden from assistive technology; the markers and fields carry their own names.
  svg.innerHTML = `<defs><pattern id="hatch" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect fill="#edf1f8"/><line x1="0" y1="0" x2="0" stroke="#65738a"/></pattern></defs><g id="gI" aria-hidden="true">${images}</g><g id="gC" aria-hidden="true">${ctry}<text class="clabel" x="${ix}" y="${iy}" font-size="900">India</text><text class="clabel" x="${lx}" y="${ly}" font-size="700">Pakistan</text></g><g id="gM">${markers}</g><g id="gR" aria-hidden="true"></g><g id="gF"></g>`;
  svg.querySelectorAll(".mk").forEach((g) => {
    const go = async (fromKeyboard) => {
      cancelTour();
      stopSeason();
      await goTile(g.dataset.tile);
      // The marker hides once the map flies in, so keyboard focus moves on to the fields.
      if (fromKeyboard && view === "fields" && tile === g.dataset.tile) focusField();
    };
    g.addEventListener("click", () => go(false));
    g.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        go(true);
      }
    });
  });
  const controls = document.querySelector(".seg");
  controls.innerHTML = Object.keys(DATA.tiles)
    .map(
      (t) =>
        `<button type="button" class="segbtn" data-tile="${esc(t)}" aria-pressed="false">${esc(NICE[t])}</button>`,
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
  selectionVersion++;
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
  setFieldsMode(false);
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
  document.querySelectorAll(".pass-gap").forEach((el) => el.remove());
  for (const gap of DATA.gaps) {
    const el = document.createElement("span");
    el.className = "pass-gap";
    el.title = `No data: ${fmt(gap.start)} to ${fmt(gap.end)}`;
    el.style.left = (100 * (day(gap.start) - Number(slider.min))) / span + "%";
    el.style.width = (100 * (day(gap.end) - day(gap.start))) / span + "%";
    document.querySelector(".slider-box").append(el);
  }
  drawBase();
  // Search still covers every field. Only suggestions are bounded, keeping large runs responsive.
  searchFieldIds = allFields().map((field) => field.id).sort();
  updateFieldSuggestions();
  updateStatistics();
  seasonChart();
  await heroField(interesting(tile), tile);
  paint();
  backend?.refresh();
  componentUI?.updateDataset(DATA);
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
async function changeDataset(kind, fromRestore = false) {
  if (!fromRestore) {
    restoreVersion++;
    restoring = false;
  }
  selectionVersion++;
  stopSeason();
  cancelTour();
  const token = ++changeVersion,
    selectEl = $("datasetSelect"),
    hadFocus = document.activeElement === selectEl;
  selectEl.disabled = true;
  $("dataStatus").textContent = "Loading dataset";
  try {
    const next = kind === "snapshot" ? snapshot : await loadApiDataset(client);
    if (token !== changeVersion) return;
    await activateDataset(next);
    syncURL(true);
    $("dataStatus").textContent = "";
    announceMap(
      `${kind === "snapshot" ? "Archived 375-field snapshot" : "Published model run"} loaded: ${allFields().length} fields, ${DATA.passes.length} passes`,
    );
  } catch (error) {
    if (token === changeVersion) {
      selectEl.value = DATA.kind;
      $("dataStatus").textContent =
        `${errorText(error)}. Retry the dataset selection.`;
    }
  } finally {
    if (token === changeVersion) {
      selectEl.disabled = false;
      // Disabling the focused select drops focus to the page; return it (WCAG 2.4.3).
      if (hadFocus && (document.activeElement === document.body || !document.activeElement))
        selectEl.focus();
    }
  }
}
function updateFieldSuggestions() {
  const target = $("fieldIds");
  if (!target) return;
  const query = $("searchField").value.trim().toLowerCase();
  target.innerHTML = searchFieldIds
    .filter((id) => !query || id.toLowerCase().includes(query))
    .slice(0, 40)
    .map((id) => `<option value="${esc(id)}"></option>`)
    .join("");
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
        `<button class="pickbtn" type="button" data-tile="${esc(t)}"><b>${esc(NICE[t])}</b><span>${DATA.tiles[t].fields.length} mapped fields</span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg></button>`,
    )
    .join("")}</div>`;
  card.querySelectorAll(".pickbtn").forEach(
    (b) =>
      (b.onclick = async () => {
        cancelTour();
        stopSeason();
        await goTile(b.dataset.tile);
        // The picker is replaced by the field list, so keep keyboard focus in the report.
        if (view === "fields" && tile === b.dataset.tile) $("fieldPicker")?.focus();
      }),
  );
}

// Field report before a field is chosen: a keyboard-friendly list of every field in the study area,
// wired to the same selection as clicking a polygon (WCAG 2.1.1, 2.5.8).
function fieldsCard() {
  const fs = DATA.tiles[tile].fields;
  const order = fs
    .map((f, i) => [f.id, i])
    .sort((a, b) => a[0].localeCompare(b[0]));
  card.innerHTML = `<h3 class="fc-id">${esc(NICE[tile])}</h3><div class="fc-meta">${fs.length} mapped fields</div><p class="fc-empty fc-empty-top">Select a field on the map, or choose one from the list.</p><label class="fc-picker" for="fieldPicker"><span>Choose a field</span><select id="fieldPicker"><option value="">Field ID</option>${order.map(([id, i]) => `<option value="${i}">${esc(id)}</option>`).join("")}</select></label><button type="button" class="btn btn-ghost btn-sm fc-open" id="fieldPickerOpen">Open field report</button>`;
  const picker = $("fieldPicker");
  $("fieldPickerOpen").onclick = () => {
    if (picker.value === "") {
      announceMap("Choose a field from the list first");
      picker.focus();
      return;
    }
    cancelTour();
    openField(Number(picker.value));
  };
  picker.onkeydown = (e) => {
    if (e.key === "Enter" && picker.value !== "") {
      e.preventDefault();
      $("fieldPickerOpen").click();
    }
  };
}
// Select a field from a keyboard control and move focus to its report.
async function openField(i, t = tile) {
  await select(i, t);
  if (selected === i && tile === t) {
    focusField(i, false);
    card.focus({ preventScroll: true });
  }
}
// Keep one field polygon in the tab order (roving tabindex) and optionally focus it.
function focusField(i = selected ?? 0, move = true) {
  const paths = [...$("gF").querySelectorAll("path")];
  if (!paths.length) return;
  const index = Math.max(0, Math.min(paths.length - 1, i));
  paths.forEach((path, k) => path.setAttribute("tabindex", k === index ? "0" : "-1"));
  if (move) paths[index].focus({ preventScroll: false });
}
// `when` is the formatted pass date, computed once per repaint rather than once per field.
function fieldName(f, i, when = fmt(DATA.passes[pass])) {
  const c = f.s[pass];
  return `Field ${f.id}, ${stateLabel(c).toLowerCase()} on ${when}${selected === i ? ", selected" : ""}`;
}

function drawFields() {
  const fs = DATA.tiles[tile].fields,
    when = fmt(DATA.passes[pass]);
  $("gF").innerHTML = fs
    .map(
      (f, i) =>
        `<path data-i="${i}" tabindex="${i === 0 ? 0 : -1}" role="button" aria-label="${esc(fieldName(f, i, when))}" fill-rule="evenodd" d="${ringsOf(
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
        const count = fs.length,
          i = Number(p.dataset.i);
        const next = {
          ArrowRight: (i + 1) % count,
          ArrowDown: (i + 1) % count,
          ArrowLeft: (i - 1 + count) % count,
          ArrowUp: (i - 1 + count) % count,
          Home: 0,
          End: count - 1,
        }[e.key];
        if (next !== undefined) {
          e.preventDefault();
          focusField(next);
          return;
        }
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          cancelTour();
          select(i);
        }
      };
    });
  status.textContent = `${NICE[tile]} · ${fs.length} fields`;
  paint();
}
async function goTile(t, fromSelection = false) {
  if (!Object.hasOwn(DATA.tiles, t)) return;
  if (!fromSelection) selectionVersion++;
  const token = ++navVersion;
  const switching = view === "fields";
  tile = t;
  selected = null;
  fieldVersion++;
  view = "fields";
  setFieldsMode(true);
  document
    .querySelectorAll(".segbtn")
    .forEach((b) => {
      const active = b.dataset.tile === t;
      b.classList.toggle("on", active);
      b.setAttribute("aria-pressed", String(active));
    });
  fieldsCard();
  $("gF").setAttribute("aria-hidden", "false");
  drawFields();
  if (!fromSelection)
    announceMap(`${NICE[t]}: ${DATA.tiles[t].fields.length} fields on the map`);
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
  if (!fromSelection) syncURL(true);
}
function setFieldsMode(active) {
  $("mapapp").classList.toggle("infields", active);
  document.querySelector(".slider-row").inert = !active;
  $("backBtn").disabled = !active;
  document.querySelector(".map-date").setAttribute("aria-hidden", String(!active));
  // The district markers fade out over the fields, so they also leave the tab order (WCAG 2.4.3, 2.4.7).
  const markers = $("gM");
  if (markers) {
    markers.setAttribute("aria-hidden", String(active));
    markers
      .querySelectorAll(".mk")
      .forEach((g) => g.setAttribute("tabindex", active ? "-1" : "0"));
  }
}

async function goCountry(push = true) {
  stopSeason();
  selectionVersion++;
  navVersion++;
  fieldVersion++;
  view = "country";
  selected = null;
  setFieldsMode(false);
  document.querySelectorAll(".segbtn").forEach((b) => {
    b.classList.remove("on");
    b.setAttribute("aria-pressed", "false");
  });
  $("gF").setAttribute("aria-hidden", "true");
  $("gF")
    .querySelectorAll("path")
    .forEach((path) => path.setAttribute("tabindex", "-1"));
  countryCard();
  status.textContent = `India · ${Object.keys(DATA.tiles).length} study areas`;
  if (push) announceMap(`Map of India: ${Object.keys(DATA.tiles).length} study areas`);
  $("gR").replaceChildren();
  await fly(COUNTRY_BOX(), 900);
  syncURL(push);
}

function paint() {
  const fs = DATA.tiles[tile].fields,
    when = fmt(DATA.passes[pass]);
  $("gF")
    .querySelectorAll("path")
    .forEach((p, i) => {
      const c = fs[i].s[pass];
      p.setAttribute(
        "class",
        (c === "-" ? "n" : c) + (selected === i ? " sel" : ""),
      );
      // The name carries the state too, so colour is never the only cue (WCAG 1.4.1, 4.1.2).
      p.setAttribute("aria-label", fieldName(fs[i], i, when));
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
    card.innerHTML = '<p class="fc-empty" role="status">Loading field observations</p>';
    try {
      await detailFor(f);
    } catch (error) {
      if (DATA === dataset && token === fieldVersion) {
        card.innerHTML = `<p class="fc-empty" role="alert">Field ${esc(f.id)} could not be loaded: ${esc(errorText(error))}</p><button type="button" id="retryField" class="btn btn-ghost">Retry field</button>`;
        $("retryField").onclick = async () => {
          await renderCard(i, true);
          if (DATA === dataset && selected === i) card.focus({ preventScroll: true });
        };
      }
      return;
    }
  }
  if (DATA !== dataset || token !== fieldVersion || selected !== i) return;
  const wasOpen = card.querySelector(".model-details")?.open;
  // Re-rendering replaces the report's controls; put keyboard focus back where it was (WCAG 2.4.3).
  const active = card.contains(document.activeElement) ? document.activeElement : null;
  const restore = active?.dataset?.fieldPass
    ? `[data-field-pass="${active.dataset.fieldPass}"]`
    : active?.matches?.(".model-details summary")
      ? ".model-details summary"
      : active === card
        ? "card"
        : null;
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
  const hhText = f.hh
    .map((value, j) => `${fmt(DATA.passes[j])} ${value == null ? "unavailable" : value.toFixed(1) + " dB"}`)
    .join("; ");
  card.innerHTML = `<h3 class="fc-id">${esc(f.id)}</h3><div class="fc-meta">${esc(NICE[tile])} · ${Number(f.ha).toFixed(2)} ha${f.rice === null ? "" : ` · ${Math.round(f.rice * 100)}% rice cover`}</div><div class="fc-verdict">${v}<small>${why}</small></div><div class="chips" role="group" aria-label="Radar state on each pass. Choose a pass to show it on the map.">${[...f.s].map((c, j) => `<button type="button" class="chip${j === pass ? " now" : ""}" data-field-pass="${j}" title="${fmt(DATA.passes[j])}: ${stateLabel(c)}" aria-label="${fmt(DATA.passes[j])}, ${stateLabel(c)}"${j === pass ? ' aria-current="true"' : ""}><span class="${c === "-" ? "n" : c}">${stateGlyph(c)}</span><em>${fmt(DATA.passes[j]).replace(" ", "<br>")}</em></button>`).join("")}</div><div class="spark"><small><span>HH backscatter</span><span>${vals.length ? lo.toFixed(1) + " to " + hi.toFixed(1) + " dB" : "Unavailable"}</span></small><svg viewBox="-4 -4 308 62" preserveAspectRatio="none" role="img" aria-label="HH backscatter by acquisition: ${esc(hhText)}"><path d="${path}" fill="none" stroke="#101d42" stroke-width="1.5"/>${pts.map((p) => `<circle cx="${p[0]}" cy="${p[1]}" r="2.5" fill="#101d42"/>`).join("")}</svg></div><div class="fc-foot"><div><b>${stateLabel(f.s[pass])}</b>${fmt(DATA.passes[pass])}</div><div><b>${conf == null ? "Unavailable" : conf.toFixed(2)}</b>classifier confidence</div></div>${detailMarkup(details.get(f.id))}`;
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
  if (restore === "card") card.focus({ preventScroll: true });
  else if (restore) card.querySelector(restore)?.focus({ preventScroll: true });
}
// A small shape inside each state swatch, so flooded and drained differ by more than colour (WCAG 1.4.1).
function stateGlyph(c) {
  if (c === "f")
    return '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.2S4 6.8 4 9.6a4 4 0 0 0 8 0C12 6.8 8 2.2 8 2.2Z"/></svg>';
  if (c === "d")
    return '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5.5 3l2 4-2 2 2 4M10.5 3l-1 3 3 2-2 5"/></svg>';
  return "";
}
async function select(i, t, push = true) {
  stopSeason();
  const dataset = DATA,
    targetTile = t || tile,
    target = dataset.tiles[targetTile]?.fields[i],
    ownSelection = ++selectionVersion;
  if (!target) return;
  if (view !== "fields" || targetTile !== tile) await goTile(targetTile, true);
  if (
    DATA !== dataset ||
    ownSelection !== selectionVersion ||
    tile !== targetTile ||
    view !== "fields"
  )
    return;
  selected = i;
  fieldVersion++;
  paint();
  await renderCard(i, true);
  if (DATA === dataset && ownSelection === selectionVersion) syncURL(push);
}

$("backBtn").addEventListener("click", async () => {
  const hadFocus = document.activeElement === $("backBtn");
  cancelTour();
  await goCountry();
  // The back button hides in the country view; keep keyboard focus on the first district marker.
  if (hadFocus && view === "country") svg.querySelector(".mk")?.focus();
});
slider.addEventListener("keydown", (event) => {
  if (
    ![
      "ArrowLeft",
      "ArrowRight",
      "ArrowDown",
      "ArrowUp",
      "Home",
      "End",
    ].includes(event.key)
  )
    return;
  event.preventDefault();
  cancelTour();
  stopSeason();
  pass =
    event.key === "Home"
      ? 0
      : event.key === "End"
        ? DATA.passes.length - 1
        : Math.max(
            0,
            Math.min(
              DATA.passes.length - 1,
              pass + (["ArrowRight", "ArrowUp"].includes(event.key) ? 1 : -1),
            ),
          );
  paint();
  syncURL();
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
  // The name changes between Play and Pause, so it is not also a pressed toggle (WCAG 4.1.2).
  playBtn.setAttribute("aria-label", on ? "Pause season" : "Play season");
  playBtn.querySelector(".ico").innerHTML =
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">${on ? '<path d="M8 5v14M16 5v14"/>' : '<path d="m8 5 11 7-11 7z"/>'}</svg>`;
}
async function playSeason() {
  const me = ++playToken,
    dataset = DATA;
  playing = true;
  setPlayLabel(true);
  announceMap("Playing the season");
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
    announceMap(`Season finished on ${fmt(DATA.passes[pass])}`);
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
  if (playing) {
    stopSeason();
    announceMap(`Paused on ${fmt(DATA.passes[pass])}`);
    return;
  }
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
    const c = { f: 0, d: 0, u: 0, n: 0 };
    all.forEach((f) => {
      const k = f.s[j] === "-" ? "n" : f.s[j];
      if (k in c) c[k]++;
    });
    const n = all.length || 1;
    return { f: c.f / n, d: c.d / n, u: c.u / n, n: c.n / n };
  });
  const W = 1000,
    H = 300,
    L = 44,
    B = 28,
    x = (d) => L + (d / Math.max(1, days[days.length - 1])) * (W - L - 8),
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
  svgS.innerHTML = `<defs><pattern id="gapHatch" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="8" height="8" fill="rgba(16,29,66,.02)"/><line x1="0" y1="0" x2="0" y2="8" stroke="rgba(16,29,66,.12)" stroke-width="2"/></pattern>
      <pattern id="uHatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="6" height="6" fill="#edf1f8"/><line x1="0" y1="0" x2="0" y2="6" stroke="#7d888e" stroke-width="2"/></pattern></defs>
    ${[0, 0.25, 0.5, 0.75, 1].map((v) => `<line class="grid" x1="${L}" x2="${W - 8}" y1="${y(v)}" y2="${y(v)}"/><text class="ax" x="${L - 8}" y="${y(v) + 4}" text-anchor="end">${v * 100}%</text>`).join("")}
    <path class="area" d="${area(() => 0, F)}" fill="var(--water)" fill-opacity=".85"/>
    <path class="area" d="${area(F, FD)}" fill="var(--mud)" fill-opacity=".85"/>
    <path class="area" d="${area(
      (j) => share[j].f + share[j].d + share[j].u,
      () => 1,
    )}" fill="#fcfdff"/>
    <path class="area" d="${area(FD, (j) => share[j].f + share[j].d + share[j].u)}" fill="url(#uHatch)"/>
    <path class="edge" d="M${days.map((d, j) => `${x(d)},${y(F(j))}`).join("L")}"/>
    <path class="edge" d="M${days.map((d, j) => `${x(d)},${y(FD(j))}`).join("L")}"/>
    ${gaps.map(({ g0, g1 }) => `<rect class="band" x="${x(g0)}" y="0" width="${x(g1) - x(g0)}" height="${H - B}"/><rect class="gap-label-bg" x="${(x(g0) + x(g1)) / 2 - 36}" y="2" width="72" height="20" rx="4"/><text class="ax gap-label" x="${(x(g0) + x(g1)) / 2}" y="16" text-anchor="middle">No data</text>`).join("")}
    ${days.map((d, j) => `<circle cx="${x(d)}" cy="${y(F(j))}" r="2.5" fill="#fcfdff" stroke="var(--water)"/><text class="ax" x="${x(d)}" y="${H - 8}" text-anchor="middle">${fmt(DATA.passes[j])}</text>`).join("")}
    <line class="cursor" id="sCur" y1="0" y2="${H - B}"/>`;
  const cur = $("sCur"),
    plot = $("seasonPlot"),
    pct = (v) => Math.round(v * 100) + "%";
  const summary = (j) => {
    const s = share[j];
    return `${fmt(DATA.passes[j])}: flooded ${pct(s.f)}, drained ${pct(s.d)}, uncertain ${pct(s.u)}${s.n > 0 ? `, no observation ${pct(s.n)}` : ""}`;
  };
  let shown = -1;
  const show = (j) => {
    shown = j;
    const r = svgS.getBoundingClientRect();
    cur.setAttribute("x1", x(days[j]));
    cur.setAttribute("x2", x(days[j]));
    cur.classList.add("on");
    const s = share[j];
    tip.innerHTML = `<b>${fmt(DATA.passes[j])}</b><i style="background:var(--water)"></i>flooded ${pct(s.f)}<br><i style="background:var(--mud)"></i>drained ${pct(s.d)}<br><i style="background:#7d888e"></i>uncertain ${pct(s.u)}${s.n > 0 ? `<br>No observation ${pct(s.n)}` : ""}`;
    tip.style.left =
      Math.max(0, Math.min(r.width - 150, (x(days[j]) / W) * r.width + 12)) + "px";
    tip.style.opacity = 1;
  };
  const hide = () => {
    tip.style.opacity = 0;
    cur.classList.remove("on");
  };
  svgS.onpointermove = (e) => {
    const r = svgS.getBoundingClientRect(),
      px = ((e.clientX - r.left) / r.width) * W;
    let j = 0;
    days.forEach((d, k) => {
      if (Math.abs(x(d) - px) < Math.abs(x(days[j]) - px)) j = k;
    });
    show(j);
  };
  svgS.onpointerleave = () => {
    if (document.activeElement !== plot) hide();
  };
  // Keyboard reading of the same chart (WCAG 2.1.1), announced politely (4.1.3); Escape dismisses
  // the tooltip without moving focus or the pointer (1.4.13).
  plot.onkeydown = (e) => {
    const last = days.length - 1;
    const next = {
      ArrowRight: Math.min(last, shown + 1),
      ArrowDown: Math.min(last, shown + 1),
      ArrowLeft: Math.max(0, shown < 0 ? 0 : shown - 1),
      ArrowUp: Math.max(0, shown < 0 ? 0 : shown - 1),
      Home: 0,
      End: last,
    }[e.key];
    if (e.key === "Escape") {
      hide();
      return;
    }
    if (next === undefined) return;
    e.preventDefault();
    show(next);
    $("seasonAnnounce").textContent = summary(next);
  };
  plot.onfocus = () => {
    if (shown < 0) shown = 0;
  };
  plot.onblur = hide;
  svgS.setAttribute(
    "aria-label",
    `Stacked area chart of the share of ${all.length.toLocaleString()} fields flooded, drained and uncertain on each of ${days.length} passes, ${fmt(DATA.passes[0])} to ${fmt(DATA.passes.at(-1))}. The data table below lists every value.`,
  );
  // Text alternative for the chart (WCAG 1.1.1, 1.4.1).
  $("seasonTable").querySelector("tbody").innerHTML = share
    .map(
      (s, j) =>
        `<tr><th scope="row">${fmt(DATA.passes[j])}</th><td>${pct(s.f)}</td><td>${pct(s.d)}</td><td>${pct(s.u)}</td><td>${pct(s.n)}</td></tr>`,
    )
    .join("");
}
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    const tip = $("seasonTip");
    if (tip && +getComputedStyle(tip).opacity > 0) tip.style.opacity = 0;
  }
});

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
  const col = { f: "#244fb6", d: "#cf4628", u: "#9aa3a8", "-": "#9aa3a8" }[
    f.s[f.s.length - 1]
  ];
  m.setAttribute("preserveAspectRatio", "xMidYMid slice");
  const [da, db] = P(district.b[0], district.b[3]),
    [dc, dd] = P(district.b[2], district.b[1]);
  m.innerHTML = `<image href="${esc(district.src)}" x="${da}" y="${db}" width="${dc - da}" height="${dd - db}" preserveAspectRatio="none"/><image href="${esc(sat.src)}" x="${a}" y="${b}" width="${c - a}" height="${d - b}" preserveAspectRatio="none"/>
    <path class="hf" d="M${pts.map((p) => p.map((v) => v.toFixed(2)).join(",")).join("L")}Z" fill="${col}" fill-opacity=".38" stroke="${col}" stroke-width="2.5" vector-effect="non-scaling-stroke" stroke-linejoin="round"/>
    <path class="hf-ring" d="M${pts.map((p) => p.map((v) => v.toFixed(2)).join(",")).join("L")}Z" fill="none" stroke="#fcfdff" stroke-width="1" vector-effect="non-scaling-stroke" stroke-dasharray="4 4"/>`;
  m.setAttribute("viewBox", `${cx - span / 2} ${cy - span * .375 / 2} ${span} ${span * .375}`);
  $("pvLabel").textContent = `This field · ${f.ha} ha`;
  const [lon, lat] = f.poly.reduce(
    (q, [x, y]) => [q[0] + x / f.poly.length, q[1] + y / f.poly.length],
    [0, 0],
  );
  $("pvCoords").textContent = `${lat.toFixed(4)}° N, ${lon.toFixed(4)}° E`;
  m.setAttribute(
    "aria-label",
    `Satellite view of field ${f.id}, outlined, near ${lat.toFixed(2)}° N, ${lon.toFixed(2)}° E`,
  );
  return { cx, cy, span };
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
  const camera = heroMap(f, t);
  const [v] = verdictLine(f.s);
  $("pvQuery").textContent = f.id;
  $("pvMeta").textContent = `${NICE[t]} · ${Number(f.ha).toFixed(2)} ha`;
  $("pvVerdict").textContent = v;
  const cs = f.c.filter(Number.isFinite);
  $("pvConf").textContent = cs.length
    ? (cs.reduce((a, b) => a + b, 0) / cs.length).toFixed(2)
    : "Unavailable";
  $("pvPasses").style.setProperty("--pass-count", String(DATA.passes.length));
  $("pvPasses").innerHTML = [...f.s]
    .map(
      (c, j) =>
        `<div class="pcol" role="listitem" title="${fmt(DATA.passes[j])}: ${stateLabel(c)}"><span class="${c === "-" ? "u" : c}" aria-hidden="true">${stateGlyph(c)}</span><em aria-hidden="true">${fmt(DATA.passes[j]).replace(" ", "<br>")}</em><span class="sr-only">${fmt(DATA.passes[j])}: ${stateLabel(c)}</span></div>`,
    )
    .join("");
  setJourneyField(f.s, DATA.passes, camera);
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
  announceMap(`Example field ${$("pvQuery").textContent}: ${$("pvVerdict").textContent}`);
}
rewire('[data-load="check"]', testRandom);
rewire('[data-load="explore"]', async () => {
  $("mapapp").scrollIntoView({
    behavior: motionOff() ? "auto" : "smooth",
    block: "center",
  });
  await wait(motionOff() ? 0 : 700);
  if (view === "country") await goTile(Object.keys(DATA.tiles)[0]);
  // Continue where the button leads: keyboard focus moves to the first field on the map (WCAG 2.4.3).
  if (view === "fields") focusField(selected ?? 0);
});

function cancelTour() {
  tourVersion++;
  touring = false;
  cap.textContent = "";
  cap.classList.remove("on");
  $("mapapp").classList.remove("touring");
  const b = document.querySelector('[data-load="tour"]');
  if (b) {
    b.querySelector(".txt").textContent = "Take the tour";
    b.classList.remove("loading");
  }
}
// The tour moves the map and plays the season for several seconds, so its button stays usable
// as "Stop tour" while it runs (WCAG 2.2.2).
{
  const old = document.querySelector('[data-load="tour"]');
  const b = old.cloneNode(true);
  old.replaceWith(b);
  b.addEventListener("click", (e) => {
    e.preventDefault();
    if (touring) {
      cancelTour();
      announceMap("Tour stopped");
      return;
    }
    runTour(b);
  });
}
async function runTour(b) {
  const current = ++tourVersion;
  touring = true;
  const valid = () => current === tourVersion;
  stopSeason();
  $("mapapp").scrollIntoView({
    behavior: motionOff() ? "auto" : "smooth",
    block: "center",
  });
  b.querySelector(".txt").textContent = "Stop tour";
  $("mapapp").classList.add("touring");
  say("Choose a study area");
  await goCountry(false);
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
  if (valid()) {
    cancelTour();
    announceMap("Tour finished");
  }
}

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
  if (view === "fields") q.set("tile", tile);
  q.set("pass", DATA.passIds[pass]);
  if (selected !== null && DATA.tiles[tile]?.fields[selected])
    q.set("field", DATA.tiles[tile].fields[selected].id);
  const url = "/?" + q + (location.hash || "");
  if (url === location.pathname + location.search + location.hash) return;
  history[push ? "pushState" : "replaceState"]({}, "", url);
}
async function restoreLocation() {
  const ownRestore = ++restoreVersion;
  changeVersion++;
  selectionVersion++;
  navVersion++;
  anim++;
  const path = location.pathname,
    q = new URLSearchParams(location.search),
    wanted =
      q.get("dataset") ||
      "api",
    id =
      q.get("field") ||
      (path.startsWith("/field/") ? decodeURIComponent(path.slice(7)) : null);
  restoring = true;
  try {
    if (wanted !== DATA.kind) await changeDataset(wanted, true);
    if (ownRestore !== restoreVersion) return;
    if (id && !fieldEntry(id) && !q.has("dataset") && DATA.kind === "snapshot")
      await changeDataset("api", true);
    if (ownRestore !== restoreVersion) return;
    const index = DATA.passIds.indexOf(q.get("pass") || "");
    if (index >= 0) pass = index;
    const entry = id ? fieldEntry(id) : null;
    if (entry) await select(entry.index, entry.tile, false);
    else if (q.get("tile") && Object.hasOwn(DATA.tiles, q.get("tile")))
      await goTile(q.get("tile"));
    else if (view !== "country") await goCountry(false);
    if (ownRestore !== restoreVersion) return;
    if (["/lab", "/scarecrow", "/evidence"].includes(path)) {
      const name =
        path === "/lab"
          ? "detectability"
          : path === "/scarecrow"
            ? "inspection"
            : "evidence";
      backend.refresh();
      document.querySelector(`[data-tool="${name}"]`)?.click();
      $("analysis").scrollIntoView();
    } else if (path === "/methods") $("method").scrollIntoView();
    else if (path === "/judges") $("story").scrollIntoView();
  } finally {
    if (ownRestore === restoreVersion) {
      restoring = false;
      $("datasetSelect").disabled = false;
      syncURL();
    }
  }
}
function installControls() {
  const navigation = document.querySelector("nav"),
    links = navigation.querySelector("ul");
  navigation.setAttribute("aria-label", "Main");
  links.id = "mainNavigation";
  const menu = document.createElement("button");
  menu.className = "nav-toggle";
  menu.type = "button";
  menu.setAttribute("aria-expanded", "false");
  menu.setAttribute("aria-controls", "mainNavigation");
  menu.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16"/></svg><span>Menu</span>';
  navigation.insertBefore(menu, links);
  const closeMenu = () => {
    navigation.classList.remove("menu-open");
    menu.setAttribute("aria-expanded", "false");
  };
  menu.onclick = () => {
    const open = navigation.classList.toggle("menu-open");
    menu.setAttribute("aria-expanded", String(open));
  };
  links.addEventListener("click", (event) => {
    if (event.target.closest("a")) closeMenu();
  });
  const legal = navigation.querySelector(".dd");
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (navigation.classList.contains("menu-open")) {
      closeMenu();
      menu.focus();
    }
    // The Legal submenu opens on hover and focus; Escape hides it (WCAG 1.4.13). Focus inside the hidden
    // submenu returns to the Legal link so it stays visible.
    if (legal?.matches(":hover, :focus-within")) {
      legal.classList.add("dismissed");
      if (legal.querySelector(".ddm")?.contains(document.activeElement))
        legal.querySelector("a")?.focus();
    }
  });
  legal?.addEventListener("pointerleave", () => legal.classList.remove("dismissed"));
  legal?.addEventListener("focusout", (event) => {
    if (!legal.contains(event.relatedTarget)) legal.classList.remove("dismissed");
  });
  document.addEventListener("pointerdown", (event) => {
    if (!navigation.contains(event.target)) closeMenu();
  });
  // An open phone menu covers the page, so it closes when keyboard focus leaves it (WCAG 2.4.11).
  navigation.addEventListener("focusout", (event) => {
    if (event.relatedTarget && !navigation.contains(event.relatedTarget)) closeMenu();
  });
  const bar = document.querySelector(".map-bar");
  bar.insertAdjacentHTML(
    "beforeend",
    `<form id="fieldSearch" class="field-search" role="search" aria-label="Find a field" novalidate><label class="sr-only" for="searchField">Field ID</label><input id="searchField" placeholder="Search field ID" autocomplete="off" spellcheck="false" list="fieldIds" aria-describedby="dataStatus"><datalist id="fieldIds"></datalist><button type="submit" aria-label="Find field" title="Find field"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.5 15.5 4 4"/></svg></button></form><span id="dataStatus" role="status"></span>`,
  );
  const search = $("searchField");
  const searchError = (text) => {
    search.setAttribute("aria-invalid", "true");
    $("dataStatus").textContent = text;
    search.focus();
  };
  search.addEventListener("input", () => {
    updateFieldSuggestions();
    if (search.getAttribute("aria-invalid") === "true") {
      search.removeAttribute("aria-invalid");
      $("dataStatus").textContent = "";
    }
  });
  $("fieldSearch").onsubmit = async (e) => {
    e.preventDefault();
    cancelTour();
    stopSeason();
    const query = search.value.trim();
    // Errors are named in text and suggest the expected form (WCAG 3.3.1, 3.3.3).
    if (!query) {
      searchError("Enter a field ID, for example " + allFields()[0].id + ".");
      return;
    }
    const found =
      fieldEntry(query) ||
      fieldEntry(query.toLowerCase()) ||
      (allFields().filter((f) => f.id.endsWith(query.toLowerCase())).length === 1
        ? fieldEntry(allFields().find((f) => f.id.endsWith(query.toLowerCase())).id)
        : null);
    if (!found) {
      searchError(
        `No field “${query}” in this dataset. Field IDs look like ${allFields()[0].id}; pick one from the suggestions.`,
      );
      return;
    }
    search.removeAttribute("aria-invalid");
    $("dataStatus").textContent = "";
    await select(found.index, found.tile);
    if (selected === found.index && tile === found.tile)
      announceMap(`Opened field ${found.field.id}`);
  };
  $("datasetSelect").onchange = () => changeDataset($("datasetSelect").value);
  document
    .querySelector(".slider-row")
    .insertAdjacentHTML(
      "beforeend",
      '<button type="button" class="radar-switch" id="radarToggle" aria-pressed="false" disabled>Radar image</button>',
    );
  $("radarToggle").onclick = () => {
    overlayOn = !overlayOn;
    updateRadar();
  };
  // Map controls: zoom, reset, and panning buttons as the single-pointer and keyboard alternative to
  // dragging the map (WCAG 2.5.7, 2.1.1). Symbols are hidden; each button has a spoken name.
  const arrow = (d) =>
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="${d}"/></svg>`;
  document
    .querySelector(".map-bottom-bar")
    .insertAdjacentHTML(
      "beforeend",
      `<div class="map-controls" role="group" aria-label="Map view"><button type="button" id="zoomIn" aria-label="Zoom in"><span aria-hidden="true">+</span></button><button type="button" id="zoomOut" aria-label="Zoom out"><span aria-hidden="true">−</span></button><button type="button" class="pan" data-pan="left" aria-label="Pan left">${arrow("M15 6l-6 6 6 6")}</button><button type="button" class="pan" data-pan="up" aria-label="Pan up">${arrow("M6 15l6-6 6 6")}</button><button type="button" class="pan" data-pan="down" aria-label="Pan down">${arrow("M6 9l6 6 6-6")}</button><button type="button" class="pan" data-pan="right" aria-label="Pan right">${arrow("M9 6l6 6-6 6")}</button><button type="button" id="resetView">Reset</button></div>`,
    );
  document.querySelectorAll(".map-controls .pan").forEach((b) => {
    b.onclick = () => {
      cancelTour();
      stopSeason();
      anim++;
      navVersion++;
      selectionVersion++;
      const [dx, dy] = { left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1] }[
        b.dataset.pan
      ];
      setVB([vb[0] + dx * vb[2] * 0.2, vb[1] + dy * vb[3] * 0.2, vb[2], vb[3]]);
    };
  });
  const zoom = (factor, point) => {
    anim++;
    navVersion++;
    selectionVersion++;
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
      navVersion++;
      selectionVersion++;
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
      code.innerHTML = `<a href="${esc((import.meta.env.VITE_API_BASE_URL || "https://mudskipper-nisar.pages.dev") + path)}" target="_blank" rel="noreferrer">${esc(path)}<span class="sr-only"> (opens in a new tab)</span></a>`;
    }
  });
}

// "Pause animations" stops every looping or long animation on the page (WCAG 2.2.2). It starts on when
// the system asks for reduced motion, and the visitor's choice is remembered on this device.
function installMotionToggle() {
  const button = $("motionToggle");
  if (!button) return;
  let stored = null;
  try {
    stored = localStorage.getItem(MOTION_KEY);
  } catch {
    /* Storage can be unavailable; the toggle still works for this visit. */
  }
  const apply = (paused) => {
    document.documentElement.classList.toggle("motion-paused", paused);
    button.setAttribute("aria-pressed", String(paused));
  };
  apply(stored === null ? motionQuery.matches : stored === "1");
  button.onclick = () => {
    const paused = button.getAttribute("aria-pressed") !== "true";
    apply(paused);
    try {
      localStorage.setItem(MOTION_KEY, paused ? "1" : "0");
    } catch {
      /* Not remembered when storage is blocked. */
    }
  };
  motionQuery.addEventListener("change", (e) => {
    if (e.matches) apply(true);
  });
}
