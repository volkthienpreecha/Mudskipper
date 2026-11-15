#!/usr/bin/env node
/**
 * Measure every endpoint of a deployment against the Workers Free plan budget (platform/README.md,
 * "Performance"): latency, status and CPU time per request, as a table; exits 1 on a budget violation.
 *
 *   node scripts/perf.ts --base https://rehearsal.mudskipper-nisar.pages.dev      # remote: CPU from the tail
 *   node scripts/perf.ts --local .site                                            # in-process: CPU from Node
 *   node scripts/perf.ts --base URL --samples 5 --audit 60,500,2000,5000 --json perf.json
 *
 * Remote mode tags every request with `x-perf-id` and runs `wrangler pages deployment tail --format json`
 * (requests are paced, --pace-ms, because the tail samples events when they arrive in bursts)
 * on the deployment behind --base (the latest one of that branch, or --deployment ID); each tail event carries
 * the invocation's `cpuTime` and `wallTime` (ms, as Cloudflare accounts them) and its `outcome` (`ok`,
 * `exceededCpu`, `exceededMemory`, `exception`, …). Requests the tail never reports are listed as unmeasured.
 *
 * Local mode runs the same Hono app in this process over the built site directory (a Pages-like ASSETS
 * fetcher: no Range, SPA fallback; KV in memory) and measures `process.cpuUsage()` around each request. The
 * caches are cleared before the first request of every endpoint, so "first" rows are cold-cache numbers (not
 * cold-JIT: V8 has compiled the code by then). Use it to iterate; use remote mode for the numbers of record.
 *
 * The plan: every run document, /api/fields with every filter combination and every page (plus one past the
 * end), /api/fields/:id for --ids ids spread over the run, a 404, the ranged reads a MapLibre PMTiles client
 * makes (16 KiB header, root directory, metadata, then tile-sized ranges), the full fields.geojson, overlays and
 * histograms, and POST /api/audit at each --audit size with a fresh seed per sample (so every sample ranks;
 * a repeated body would only read the stored result). Audit claims mix the sample's shape (a third polygons,
 * two thirds points, half with a field_id hint, ~12% matching no field), plus a "polygons" body grown to the
 * 5 MiB limit, all SYNTHETIC.
 *
 * Budgets (fail = exit 1): any 5xx, a Cloudflare 1102 or a non-ok outcome; CPU p95 > --cpu-ms (8) on any row;
 * read latency p95 > --latency-ms (600, remote only). Audits are rows like any other; their CPU is the point.
 */
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { mulberry32 } from "@mudskipper/core";
import { ACCOUNT_ID, PROJECT, PRODUCTION_URL } from "./lib/wrangler.ts";
import { REPO_ROOT } from "./lib/run.ts";

type Kind = "read" | "audit";

interface Planned {
  row: string;
  kind: Kind;
  path: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  /** A new body per send (audits: a fresh seed, so the request ranks instead of reading the stored result). */
  fresh?: () => string;
}

interface Sample extends Planned {
  id: string;
  status: number;
  ms: number;
  bytes: number;
  cpu: number | null;
  wall: number | null;
  outcome: string | null;
  note?: string;
}

export interface Row {
  row: string;
  kind: Kind;
  n: number;
  statuses: string;
  p50: number;
  p95: number;
  max: number;
  cpuN: number;
  cpuP50: number | null;
  cpuP95: number | null;
  cpuMax: number | null;
  outcomes: string;
  bytes: number;
  violations: string[];
}

const MAX_BODY = 5 * 1024 * 1024;

export function pct(xs: number[], p: number): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]!;
}

// ------------------------------------------------------------------------------------------------ targets
interface Target {
  fetch(path: string, init: RequestInit & { perfId: string }): Promise<{ res: Response; cpu: number | null }>;
  /** Called before the first request of each row (local: clears the isolate caches). */
  cold?(): void;
  close(): Promise<void>;
}

function remoteTarget(base: string): Target {
  return {
    async fetch(path, init) {
      const { perfId, ...rest } = init;
      const headers = new Headers(rest.headers);
      headers.set("x-perf-id", perfId);
      const res = await fetch(base + path, { ...rest, headers, redirect: "manual" });
      return { res, cpu: null };
    },
    async close() {},
  };
}

const TYPES: Record<string, string> = {
  ".json": "application/json",
  ".geojson": "application/geo+json",
  ".png": "image/png",
  ".html": "text/html; charset=utf-8",
};

async function localTarget(siteDir: string): Promise<Target> {
  const { createApp } = await import("../src/app.ts");
  const { clearStaticCache } = await import("../src/repo/static.ts");
  const { clearTilesCache } = await import("../src/tiles.ts");
  const root = resolve(siteDir);
  const files = new Map<string, Uint8Array<ArrayBuffer>>();
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else files.set(p.slice(root.length), new Uint8Array(readFileSync(p)));
    }
  };
  walk(root);
  const index = files.get("/index.html") ?? new TextEncoder().encode("<!doctype html>");
  const ASSETS = {
    async fetch(input: RequestInfo | URL): Promise<Response> {
      const path = decodeURIComponent(new URL(typeof input === "string" || input instanceof URL ? input : input.url).pathname);
      const data = files.get(path);
      if (data) return new Response(data, { headers: { "content-type": TYPES[extname(path)] ?? "application/octet-stream" } });
      return new Response(index, { headers: { "content-type": "text/html; charset=utf-8" } });
    },
  };
  const kv = new Map<string, string>();
  const AUDITS = {
    async get(key: string, type?: string) {
      const v = kv.get(key);
      return v === undefined ? null : type === "json" ? JSON.parse(v) : v;
    },
    async put(key: string, value: string) {
      kv.set(key, value);
    },
  };
  const app = createApp();
  const env = { ASSETS, AUDITS } as never;
  return {
    async fetch(path, init) {
      const { perfId: _, ...rest } = init;
      const t0 = process.cpuUsage();
      const res = await app.request("https://perf.local" + path, rest, env);
      const buf = await res.arrayBuffer(); // the body is produced lazily for streams: count it
      const d = process.cpuUsage(t0);
      const nullBody = res.status === 204 || res.status === 304;
      return { res: new Response(nullBody ? null : buf, { status: res.status, headers: res.headers }), cpu: (d.user + d.system) / 1000 };
    },
    cold() {
      clearStaticCache();
      clearTilesCache();
    },
    async close() {},
  };
}

// ------------------------------------------------------------------------------------------------ tail
interface TailEvent {
  outcome: string;
  cpuTime?: number;
  wallTime?: number;
  event?: { request?: { url?: string; headers?: Record<string, string> } };
}

function resolveDeployment(base: string): string {
  const host = new URL(base).hostname;
  const sub = host.endsWith(`.${PROJECT}.pages.dev`) ? host.slice(0, -(`.${PROJECT}.pages.dev`.length)) : null;
  const list = (env: "production" | "preview") => {
    const res = spawnSync(join(REPO_ROOT, "node_modules", ".bin", "wrangler"), ["pages", "deployment", "list", "--project-name", PROJECT, "--environment", env, "--json"], {
      encoding: "utf8",
      env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: process.env["CLOUDFLARE_ACCOUNT_ID"] ?? ACCOUNT_ID },
    });
    if (res.status !== 0) throw new Error(`wrangler pages deployment list failed: ${res.stderr}`);
    return JSON.parse(res.stdout) as { Id: string; Branch: string }[];
  };
  if (sub === null) return list("production")[0]!.Id;
  if (/^[0-9a-f]{8}$/.test(sub)) return [...list("preview"), ...list("production")].find((d) => d.Id.startsWith(sub))!.Id;
  const hit = list("preview").find((d) => d.Branch === sub);
  if (!hit) throw new Error(`no preview deployment for branch ${sub}`);
  return hit.Id;
}

/** `wrangler pages deployment tail --format json` prints pretty JSON objects back to back; split them. */
function jsonObjects(onObject: (o: TailEvent) => void): (chunk: string) => void {
  let buf = "";
  let depth = 0;
  let inStr = false;
  let esc = false;
  let start = -1;
  let scanned = 0;
  return (chunk) => {
    buf += chunk;
    for (let i = scanned; i < buf.length; i++) {
      const c = buf[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === "\\") esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === "{") {
        if (depth === 0) start = i;
        depth++;
      } else if (c === "}" && depth > 0) {
        depth--;
        if (depth === 0) {
          try {
            onObject(JSON.parse(buf.slice(start, i + 1)) as TailEvent);
          } catch {
            /* not an event */
          }
          buf = buf.slice(i + 1);
          i = -1;
        }
      }
    }
    scanned = buf.length;
  };
}

async function startTail(deployment: string): Promise<{ events: Map<string, TailEvent>; stop(): void }> {
  const events = new Map<string, TailEvent>();
  const child = spawn(
    join(REPO_ROOT, "node_modules", ".bin", "wrangler"),
    ["pages", "deployment", "tail", deployment, "--project-name", PROJECT, "--format", "json"],
    { env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: process.env["CLOUDFLARE_ACCOUNT_ID"] ?? ACCOUNT_ID }, stdio: ["ignore", "pipe", "pipe"] },
  );
  const feed = jsonObjects((o) => {
    const id = o.event?.request?.headers?.["x-perf-id"];
    if (id) events.set(id, o);
  });
  child.stdout.setEncoding("utf8").on("data", feed);
  if (process.env["PERF_TAIL_LOG"]) child.stdout.on("data", (d: string) => appendFileSync(process.env["PERF_TAIL_LOG"]!, d));
  let err = "";
  child.stderr.setEncoding("utf8").on("data", (d: string) => (err += d));
  // The tail is live once wrangler says so (or after a grace period); requests before that are not reported.
  await new Promise<void>((ok, fail) => {
    const timer = setTimeout(ok, 20_000);
    const check = (d: string) => {
      if (/Connected to deployment/i.test(d)) {
        clearTimeout(timer);
        setTimeout(ok, 2000);
      }
    };
    child.stdout.on("data", check);
    child.stderr.on("data", check);
    child.on("exit", (code) => fail(new Error(`wrangler tail exited (${code}): ${err.slice(-500)}`)));
  });
  return { events, stop: () => child.kill("SIGINT") };
}

// ------------------------------------------------------------------------------------------------ plan
interface Feature {
  geometry: { type: string; coordinates: unknown };
  properties: { field_id: string; lon: number; lat: number; tile: string };
}

/** SYNTHETIC claims over the run's fields, deterministic for (n, seed, shape). */
export function makeClaims(features: Feature[], tiles: { id: string; bbox: number[] }[], n: number, seed: number, shape: "mix" | "polygons") {
  const rng = mulberry32(seed);
  const claims: unknown[] = [];
  for (let i = 0; i < n; i++) {
    const r = rng();
    const claimed = r < 0.5 ? ["awd"] : r < 0.7 ? ["dsr"] : ["awd", "dsr"];
    const claim_id = `PERF-${String(i + 1).padStart(5, "0")}`;
    if (shape === "mix" && rng() < 0.12) {
      const t = tiles[Math.floor(rng() * tiles.length)]!;
      const [x0, y0, x1, y1] = t.bbox as [number, number, number, number];
      const pt = [x0 + rng() * (x1 - x0), y0 + rng() * (y1 - y0)];
      claims.push({ type: "Feature", geometry: { type: "Point", coordinates: pt }, properties: { claim_id, claimed, synthetic: true } });
      continue;
    }
    const f = features[Math.floor(rng() * features.length)]!;
    const polygon = shape === "polygons" || rng() < 1 / 3;
    const geometry = polygon ? f.geometry : { type: "Point", coordinates: [f.properties.lon, f.properties.lat] };
    const props: Record<string, unknown> = { claim_id, claimed, synthetic: true };
    if (shape === "mix" && rng() < 0.5) props["field_id"] = f.properties.field_id;
    claims.push({ type: "Feature", geometry, properties: props });
  }
  return claims;
}

function auditBody(claims: unknown[], seed: number): string {
  return JSON.stringify({ claims: { type: "FeatureCollection", features: claims }, budget: 100, seed });
}

async function discover(target: Target) {
  const get = async (path: string) => {
    const { res } = await target.fetch(path, { perfId: "discover" });
    if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
    return res;
  };
  const meta = (await (await get("/api/meta")).json()) as {
    run_id: string;
    tiles: { id: string; bbox: number[] }[];
    assets: { fields_geojson: string; fields_pmtiles: string | null; overlays_index: string | null; hist: Record<string, string | null> };
  };
  const story = (await (await get("/api/story")).json()) as { hero_field_id: string };
  const fc = (await (await get(meta.assets.fields_geojson)).json()) as { features: Feature[] };
  let pm: { rootOff: number; rootLen: number; metaOff: number; metaLen: number; dataOff: number; dataLen: number } | null = null;
  if (meta.assets.fields_pmtiles) {
    const head = new DataView(await (await target.fetch(meta.assets.fields_pmtiles, { perfId: "discover", headers: { range: "bytes=0-126" } })).res.arrayBuffer());
    const u64 = (o: number) => Number(head.getBigUint64(o, true));
    pm = { rootOff: u64(8), rootLen: u64(16), metaOff: u64(24), metaLen: u64(32), dataOff: u64(56), dataLen: u64(64) };
  }
  let overlays: string[] = [];
  if (meta.assets.overlays_index) {
    const ix = (await (await get(meta.assets.overlays_index)).json()) as { overlays: { url: string }[] };
    overlays = ix.overlays.map((o) => `/tiles/runs/${meta.run_id}/${o.url}`);
  }
  return { meta, story, features: fc.features, pm, overlays };
}

function plan(d: Awaited<ReturnType<typeof discover>>, opts: { samples: number; ids: number; auditSizes: number[]; auditSamples: number }): Planned[] {
  const out: Planned[] = [];
  const rep = (p: Planned, n = opts.samples) => {
    for (let i = 0; i < n; i++) out.push(p);
  };
  const r = (row: string, path: string, extra: Partial<Planned> = {}): Planned => ({ row, kind: "read", path, ...extra });
  rep(r("GET /api/health", "/api/health"));
  for (const doc of ["meta", "story", "passes", "states", "detectability", "checks", "provenance"]) rep(r(`GET /api/${doc}`, `/api/${doc}`));
  rep(r("GET /api/meta If-None-Match (304)", "/api/meta", { headers: { "if-none-match": "*" } }));
  const total = d.features.length;
  const pages = Math.max(1, Math.ceil(total / 500));
  for (let p = 1; p <= pages + 1; p++) out.push(r("GET /api/fields?page=N (every page + 1 past the end)", p === 1 ? "/api/fields" : `/api/fields?page=${p}`));
  for (const t of d.meta.tiles) {
    const n = d.features.filter((f) => f.properties.tile === t.id).length;
    for (let p = 1; p <= Math.max(1, Math.ceil(n / 500)); p++) out.push(r("GET /api/fields?tile=T&page=N (every page)", `/api/fields?tile=${t.id}&page=${p}`));
    for (const v of ["consistent", "inconsistent", "not_enough_evidence"]) out.push(r("GET /api/fields?tile=T&verdict=V", `/api/fields?tile=${t.id}&verdict=${v}`));
  }
  for (const v of ["consistent", "inconsistent", "not_enough_evidence"]) {
    for (let p = 1; p <= 2; p++) out.push(r("GET /api/fields?verdict=V&page=N", `/api/fields?verdict=${v}&page=${p}`));
  }
  out.push(r("GET /api/fields?tile=unknown (empty)", "/api/fields?tile=nowhere"));
  const ids = [...d.features.map((f) => f.properties.field_id)].sort();
  const step = Math.max(1, Math.floor(ids.length / opts.ids));
  for (let i = 0; i < ids.length && out.filter((x) => x.row.startsWith("GET /api/fields/:id")).length < opts.ids; i += step) {
    out.push(r("GET /api/fields/:id (spread over the run)", `/api/fields/${ids[i]}`));
  }
  rep(r("GET /api/fields/:id unknown (404)", "/api/fields/fazilka-99999"), 2);
  const pmUrl = d.meta.assets.fields_pmtiles;
  if (pmUrl && d.pm) {
    const range = (a: number, b: number) => ({ headers: { range: `bytes=${a}-${b}` } });
    rep(r("GET /tiles fields.pmtiles header (bytes=0-16383)", pmUrl, range(0, 16383)));
    rep(r("GET /tiles fields.pmtiles root directory", pmUrl, range(d.pm.rootOff, d.pm.rootOff + d.pm.rootLen - 1)));
    rep(r("GET /tiles fields.pmtiles metadata", pmUrl, range(d.pm.metaOff, d.pm.metaOff + d.pm.metaLen - 1)));
    const rng = mulberry32(7);
    for (let i = 0; i < opts.samples * 4; i++) {
      const len = 2048 + Math.floor(rng() * 62 * 1024);
      const a = d.pm.dataOff + Math.floor(rng() * Math.max(1, d.pm.dataLen - len));
      out.push(r("GET /tiles fields.pmtiles tile range (2-64 KiB)", pmUrl, range(a, a + len - 1)));
    }
  }
  rep(r("GET /tiles fields.geojson (whole file)", d.meta.assets.fields_geojson), Math.min(3, opts.samples));
  for (const o of d.overlays.slice(0, opts.samples)) out.push(r("GET /tiles overlay PNG", o));
  for (const h of Object.values(d.meta.assets.hist)) if (h) out.push(r("GET /tiles hist PNG", h));

  // A fresh seed range per run: a repeated body would only read the stored audit instead of ranking.
  let seed = (Date.now() % 1_000_000) * 1000;
  for (const n of opts.auditSizes) {
    for (let i = 0; i < opts.auditSamples; i++) {
      const fresh = () => {
        const s = ++seed;
        return auditBody(makeClaims(d.features, d.meta.tiles, n, s, "mix"), s);
      };
      out.push({ row: `POST /api/audit ${n} claims`, kind: "audit", path: "/api/audit", method: "POST", fresh, headers: { "content-type": "application/json" } });
    }
  }
  // The largest body the contract accepts: polygon claims (the bulkiest kind) up to 5 MiB.
  for (let i = 0; i < Math.min(2, opts.auditSamples); i++) {
    const s = ++seed;
    let claims = makeClaims(d.features, d.meta.tiles, 5000, s, "polygons");
    let body = auditBody(claims, s);
    while (Buffer.byteLength(body) > MAX_BODY) {
      claims = claims.slice(0, Math.floor(claims.length * (MAX_BODY / Buffer.byteLength(body)) * 0.995));
      body = auditBody(claims, s);
    }
    const fixed = claims;
    const fresh = () => auditBody(fixed, ++seed);
    out.push({ row: `POST /api/audit 5 MiB of polygons (${claims.length} claims)`, kind: "audit", path: "/api/audit", method: "POST", fresh, headers: { "content-type": "application/json" } });
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ run
export function summarize(samples: Sample[], budgets: { cpuMs: number; latencyMs: number | null }): Row[] {
  const rows = new Map<string, Sample[]>();
  for (const s of samples) {
    const list = rows.get(s.row);
    if (list) list.push(s);
    else rows.set(s.row, [s]);
  }
  return [...rows.entries()].map(([row, ss]) => {
    const ms = ss.map((s) => s.ms);
    const cpus = ss.map((s) => s.cpu).filter((c): c is number => c !== null);
    const count = (xs: (string | number)[]) => {
      const m = new Map<string, number>();
      for (const x of xs) m.set(String(x), (m.get(String(x)) ?? 0) + 1);
      return [...m.entries()].map(([k, v]) => `${k}×${v}`).join(" ");
    };
    const kind = ss[0]!.kind;
    const violations: string[] = [];
    const bad = ss.filter((s) => s.status >= 500 || s.status === 0);
    if (bad.length) violations.push(`${bad.length} × HTTP ${[...new Set(bad.map((s) => s.status))].join("/")}${bad.some((s) => s.note) ? ` (${bad.find((s) => s.note)!.note})` : ""}`);
    const notOk = ss.filter((s) => s.outcome !== null && s.outcome !== "ok");
    if (notOk.length) violations.push(`outcome ${[...new Set(notOk.map((s) => s.outcome))].join("/")}`);
    const cpuP95 = cpus.length ? pct(cpus, 95) : null;
    if (cpuP95 !== null && cpuP95 > budgets.cpuMs) violations.push(`CPU p95 ${cpuP95.toFixed(1)} ms > ${budgets.cpuMs}`);
    const p95 = pct(ms, 95);
    if (kind === "read" && budgets.latencyMs !== null && p95 > budgets.latencyMs) violations.push(`p95 ${p95.toFixed(0)} ms > ${budgets.latencyMs}`);
    return {
      row,
      kind,
      n: ss.length,
      statuses: count(ss.map((s) => s.status)),
      p50: pct(ms, 50),
      p95,
      max: Math.max(...ms),
      cpuN: cpus.length,
      cpuP50: cpus.length ? pct(cpus, 50) : null,
      cpuP95,
      cpuMax: cpus.length ? Math.max(...cpus) : null,
      outcomes: count(ss.map((s) => s.outcome ?? "?")),
      bytes: Math.round(ss.reduce((a, s) => a + s.bytes, 0) / ss.length),
      violations,
    };
  });
}

export function table(rows: Row[], title: string): string {
  const f = (x: number | null, d = 1) => (x === null || Number.isNaN(x) ? "–" : x.toFixed(d));
  const kb = (b: number) => (b >= 1024 * 1024 ? `${(b / 1048576).toFixed(2)} MB` : `${(b / 1024).toFixed(1)} kB`);
  const lines = [
    `### ${title}`,
    "",
    "| endpoint | n | status | latency p50 / p95 / max (ms) | CPU p50 / p95 / max (ms) | outcome | avg bytes | budget |",
    "|---|---:|---|---:|---:|---|---:|---|",
    ...rows.map(
      (r) =>
        `| ${r.row} | ${r.n} | ${r.statuses} | ${f(r.p50, 0)} / ${f(r.p95, 0)} / ${f(r.max, 0)} | ` +
        `${f(r.cpuP50)} / ${f(r.cpuP95)} / ${f(r.cpuMax)}${r.cpuN < r.n ? ` (${r.cpuN} of ${r.n})` : ""} | ${r.outcomes} | ${kb(r.bytes)} | ${r.violations.length ? "**" + r.violations.join("; ") + "**" : "ok"} |`,
    ),
  ];
  return lines.join("\n");
}

async function main() {
  const { values } = parseArgs({
    options: {
      base: { type: "string" },
      local: { type: "string" },
      deployment: { type: "string" },
      samples: { type: "string", default: "5" },
      ids: { type: "string", default: "60" },
      audit: { type: "string", default: "60,500,2000,5000" },
      "audit-samples": { type: "string", default: "3" },
      "pace-ms": { type: "string", default: "250" },
      rounds: { type: "string", default: "4" },
      "cpu-ms": { type: "string", default: "8" },
      "latency-ms": { type: "string", default: "600" },
      json: { type: "string" },
      md: { type: "string" },
      title: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help || Boolean(values.base) === Boolean(values.local)) {
    console.log(
      "usage: node scripts/perf.ts (--base URL [--deployment ID] | --local SITE_DIR) [--samples 5] [--ids 60]\n" +
        "       [--audit 60,500,2000,5000] [--audit-samples 3] [--pace-ms 250] [--cpu-ms 8] [--latency-ms 600] [--json FILE] [--md FILE]",
    );
    process.exit(values.help ? 0 : 2);
  }
  const remote = Boolean(values.base);
  const base = (values.base ?? PRODUCTION_URL).replace(/\/$/, "");
  const target = remote ? remoteTarget(base) : await localTarget(values.local!);
  const d = await discover(target);
  const planned = plan(d, {
    samples: Number(values.samples),
    ids: Number(values.ids),
    auditSizes: values.audit.split(",").filter(Boolean).map(Number),
    auditSamples: Number(values["audit-samples"]),
  });

  let tail: Awaited<ReturnType<typeof startTail>> | null = null;
  if (remote) {
    const dep = values.deployment ?? resolveDeployment(base);
    console.error(`tailing deployment ${dep} for CPU time…`);
    tail = await startTail(dep);
  }
  const run = Date.now().toString(36);
  const seen = new Set<string>();
  let i = 0;
  const once = async (p: Planned): Promise<Sample> => {
    const id = `${run}-${++i}`;
    if (!seen.has(p.row)) {
      seen.add(p.row);
      target.cold?.();
    }
    const body = p.fresh ? p.fresh() : p.body;
    const t0 = performance.now();
    let status = 0;
    let bytes = 0;
    let cpu: number | null = null;
    let note: string | undefined;
    try {
      const { res, cpu: c } = await target.fetch(p.path, {
        perfId: id,
        method: p.method ?? "GET",
        ...(p.headers ? { headers: p.headers } : {}),
        ...(body !== undefined ? { body } : {}),
      });
      const buf = await res.arrayBuffer();
      status = res.status;
      bytes = buf.byteLength;
      cpu = c;
      if (status >= 500) {
        const text = new TextDecoder().decode(buf.slice(0, 2000));
        note = /1102|exceeded/i.test(text) ? "Cloudflare 1102: Worker exceeded resource limits" : text.slice(0, 120).replace(/\s+/g, " ");
      }
    } catch (e) {
      note = (e as Error).message;
    }
    const ms = performance.now() - t0;
    if (remote) await new Promise((r) => setTimeout(r, Number(values["pace-ms"]))); // the tail samples under bursts
    process.stderr.write(".");
    const { body: _b, fresh: _f, ...rest } = p;
    return { ...rest, id, status, ms, bytes, cpu, wall: null, outcome: remote ? null : "ok", ...(note ? { note } : {}) };
  };
  let samples: Sample[] = [];
  for (const p of planned) samples.push(await once(p));
  if (tail) {
    // The tail drops events (it samples), so requests it did not report are sent again (fresh audit seeds),
    // up to --rounds times; a sample counts once its own invocation is reported.
    const settle = async (ss: Sample[]) => {
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline && ss.some((s) => !tail!.events.has(s.id))) await new Promise((r) => setTimeout(r, 1000));
    };
    await settle(samples);
    for (let round = 1; round <= Number(values.rounds); round++) {
      const missing = samples.map((s, k) => [s, k] as const).filter(([s]) => !tail!.events.has(s.id));
      if (!missing.length) break;
      process.stderr.write(`\nround ${round}: re-sending ${missing.length} unreported requests `);
      const again: Sample[] = [];
      for (const [, k] of missing) again.push(await once(planned[k]!));
      await settle(again);
      missing.forEach(([, k], j) => {
        if (tail!.events.has(again[j]!.id)) samples[k] = again[j]!;
      });
    }
    tail.stop();
    samples = samples.map((s) => {
      const e = tail!.events.get(s.id);
      return e ? { ...s, cpu: typeof e.cpuTime === "number" ? e.cpuTime : null, wall: typeof e.wallTime === "number" ? e.wallTime : null, outcome: e.outcome } : s;
    });
  }
  process.stderr.write("\n");
  const budgets = { cpuMs: Number(values["cpu-ms"]), latencyMs: remote ? Number(values["latency-ms"]) : null };
  const rows = summarize(samples, budgets);
  const title = values.title ?? `${remote ? base : `local ${values.local}`} · run ${d.meta.run_id} · ${d.features.length} fields · ${new Date().toISOString().slice(0, 16)}Z`;
  const md = table(rows, title);
  console.log(md);
  const unmeasured = samples.filter((s) => s.cpu === null).length;
  if (unmeasured) console.log(`\n${unmeasured} of ${samples.length} requests have no CPU figure (the tail did not report them).`);
  const failed = rows.filter((r) => r.violations.length);
  console.log(failed.length ? `\nFAIL: ${failed.length} of ${rows.length} rows over budget` : `\nOK: all ${rows.length} rows inside the budget`);
  if (values.json) writeFileSync(values.json, JSON.stringify({ title, budgets, rows, samples }, null, 1));
  if (values.md) writeFileSync(values.md, md + "\n");
  await target.close();
  process.exit(failed.length ? 1 : 0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e: Error) => {
    console.error(`perf: ${e.stack ?? e.message}`);
    process.exit(1);
  });
}
