// Generate core/src/contracts.gen.ts from contracts/schemas (devDependency: json-schema-to-typescript 16.0.0).
//
//   node core/scripts/gen-types.mjs           # write src/contracts.gen.ts
//   node core/scripts/gen-types.mjs --check   # exit 1 if the committed file differs from a fresh build
//
// One in-memory bundle schema whose $defs reference every shared def in common.schema.json and every schema
// file, compiled once. Each type is therefore declared exactly once, under an explicit name (below), and the
// output is deterministic, so CI can check it for drift.
import { compile } from "json-schema-to-typescript";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const SCHEMAS = fileURLToPath(new URL("../../contracts/schemas/", import.meta.url));
const OUT = fileURLToPath(new URL("../src/contracts.gen.ts", import.meta.url));
const ID_BASE = "https://mudskipper.invalid/schemas/v1/";

/**
 * json-schema-to-typescript 16 does not know draft 2020-12 `prefixItems` (tuples would become `never[]`).
 * Rewrite to the draft-07 tuple form it does know: `items: [...]` plus `additionalItems`.
 * Remove this shim once a json-schema-to-typescript release with prefixItems support is pinned.
 */
function shim(node) {
  if (Array.isArray(node)) return node.map(shim);
  if (!node || typeof node !== "object") return node;
  const out = Object.fromEntries(Object.entries(node).map(([k, v]) => [k, shim(v)]));
  if (Array.isArray(out.prefixItems)) {
    out.additionalItems = out.items ?? true;
    out.items = out.prefixItems;
    delete out.prefixItems;
  }
  // `allOf: [{if, then, else}]` constrains values but adds no TypeScript shape; left in, jsstt splits the
  // object into `Pass = Pass1`. Drop such members so the object keeps its one name.
  if (Array.isArray(out.allOf)) {
    out.allOf = out.allOf.filter((m) => !Object.keys(m).every((k) => k === "if" || k === "then" || k === "else"));
    if (out.allOf.length === 0) delete out.allOf;
  }
  return out;
}

const posix = (p) => p.split("\\").join("/");
const files = readdirSync(SCHEMAS, { recursive: true })
  .map((f) => posix(String(f)))
  .filter((f) => f.endsWith(".schema.json"))
  .sort();
const stem = (file) => file.replace(/\.schema\.json$/, "");
const pascal = (s) =>
  s
    .split(/[/_.-]/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join("");

/**
 * Type names. Every schema root and every $def gets one explicit, stable name, injected as `x-ts-name`
 * while the file is read and returned by `customName`. Nothing is left to json-schema-to-typescript's
 * title-based naming, which appends numbers on collisions (`Point1`, `Polygon1`).
 */
const ROOT_NAMES = {
  aoi: "Aoi",
  checks: "Checks",
  claims: "Claims",
  common: "CommonDefs",
  detectability: "Detectability",
  district_check: "DistrictCheck",
  field_summary: "FieldSummaryLine",
  fields: "FieldCollection",
  live: "Live",
  observation: "ObservationLine",
  overlays_index: "OverlaysIndex",
  passes: "Passes",
  provenance: "Provenance",
  states: "States",
  story: "Story",
  "api/audit_request": "AuditRequest",
  "api/audit_response": "AuditResponse",
  "api/checks": "ApiChecks",
  "api/detectability": "ApiDetectability",
  "api/error": "ApiErrorBody",
  "api/field_detail": "FieldDetail",
  "api/fields_page": "FieldsPage",
  "api/health": "Health",
  "api/meta": "Meta",
  "api/passes": "ApiPasses",
  "api/provenance": "ApiProvenance",
  "api/states": "ApiStates",
  "api/story": "ApiStory",
};
const DEF_NAMES = {
  "common#date": "IsoDate", // never shadow the global Date; these are strings
  "common#datetime": "IsoDatetime",
  "common#multipolygon": "MultiPolygon",
  "api/audit_response#ranked": "RankedPick",
  "api/field_detail#observation_row": "ObservationRow",
  "api/field_detail#summary": "FieldDetailSummary",
  "api/fields_page#field_row": "FieldRow",
  "checks#opera": "Opera",
  "checks#season_shape": "SeasonShape",
  "claims#claim": "Claim",
  "claims#claim_properties": "ClaimProperties",
  "claims#multipolygon": "ClaimMultiPolygon",
  "claims#point": "ClaimPoint",
  "claims#polygon": "ClaimPolygon",
  "claims#position": "ClaimPosition",
  "detectability#param_source": "ParamSource",
  "detectability#params": "Params",
  "detectability#results": "DetectabilityResults",
  "district_check#row": "DistrictRow",
  "field_summary#awd": "AwdSummary",
  "field_summary#dsr": "DsrSummary",
  "fields#feature": "FieldFeature",
  "fields#field_properties": "FieldProperties",
  "observation#inferred": "Inferred",
  "observation#observed": "Observed",
  "passes#pass": "Pass",
};
// A schema or $def added later still gets a deterministic name: Pascal of its path (`<File><Def>` for defs).
const rootName = (file) => ROOT_NAMES[stem(file)] ?? pascal(stem(file));
const defName = (file, key) =>
  DEF_NAMES[`${stem(file)}#${key}`] ?? (stem(file) === "common" ? pascal(key) : pascal(stem(file)) + pascal(key));

const docs = Object.fromEntries(files.map((f) => [f, JSON.parse(readFileSync(join(SCHEMAS, f), "utf8"))]));
const taken = new Map();
for (const file of files) {
  for (const name of [rootName(file), ...Object.keys(docs[file].$defs ?? {}).map((k) => defName(file, k))]) {
    if (taken.has(name)) throw new Error(`gen: type name ${name} is used twice (${taken.get(name)} and ${file})`);
    taken.set(name, file);
  }
}

function readSchema(absPath) {
  const file = posix(relative(SCHEMAS, absPath));
  const doc = shim(JSON.parse(readFileSync(absPath, "utf8")));
  doc["x-ts-name"] = rootName(file);
  for (const [key, def] of Object.entries(doc.$defs ?? {})) def["x-ts-name"] = defName(file, key);
  return JSON.stringify(doc);
}

const commonDefs = Object.keys(docs["common.schema.json"].$defs).sort();
const root = {
  $id: "Contracts",
  $defs: {
    ...Object.fromEntries(commonDefs.map((k) => [defName("common.schema.json", k), { $ref: `common.schema.json#/$defs/${k}` }])),
    ...Object.fromEntries(files.map((f) => [rootName(f), { $ref: f }])),
  },
};

const BANNER = [
  "/* eslint-disable */",
  "// GENERATED by core/scripts/gen-types.mjs from contracts/schemas. Do not edit by hand:",
  "// run `npm run gen -w @mudskipper/core` after a schema change (CI runs `gen:check`).",
].join("\n");

const ts = await compile(root, "Contracts", {
  cwd: SCHEMAS,
  bannerComment: BANNER,
  additionalProperties: false,
  unreachableDefinitions: true,
  unknownAny: true,
  strictIndexSignatures: true,
  customName: (schema) => schema["x-ts-name"],
  $refOptions: {
    resolve: {
      http: false, // the $id host does not exist; never touch the network
      file: { canRead: true, read: (f) => readSchema(f.url) },
      mudskipper: {
        order: 1,
        canRead: (f) => f.url.startsWith(ID_BASE),
        read: (f) => readSchema(join(SCHEMAS, f.url.slice(ID_BASE.length).split("#")[0])),
      },
    },
  },
});
const out = ts.endsWith("\n") ? ts : ts + "\n";

if (process.argv.includes("--check")) {
  let current = "";
  try {
    current = readFileSync(OUT, "utf8");
  } catch {
    // a missing file counts as drift
  }
  if (current !== out) {
    console.error(`gen:check: ${posix(relative(process.cwd(), OUT))} is out of date with contracts/schemas.`);
    console.error("Run `npm run gen -w @mudskipper/core` and commit the result.");
    process.exit(1);
  }
  console.log(`gen:check: ${posix(relative(process.cwd(), OUT))} matches contracts/schemas`);
} else {
  writeFileSync(OUT, out);
  console.log(`gen: wrote ${posix(relative(process.cwd(), OUT))} from ${files.length} schema files`);
}
