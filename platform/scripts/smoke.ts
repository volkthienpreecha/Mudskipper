#!/usr/bin/env node
/**
 * Smoke-test a deployment end to end: every API endpoint (schema-validated), the fixture flag (T8), a tile
 * Range request (206), conditional GET (304), the audit endpoint, Markdown negotiation and real 404s, every page,
 * OpenAPI and llms.txt, the placeholder assets
 * and the security headers. Prints one line per check with its timing; exits 1 if any check fails.
 *
 *   node scripts/smoke.ts                                   # https://mudskipper-nisar.pages.dev
 *   node scripts/smoke.ts --base http://localhost:8788
 *   node scripts/smoke.ts --expect-run fixture --json
 *   node scripts/smoke.ts --audit skip                      # no POST (e.g. a read-only check)
 *
 * The audit check POSTs the exact bytes of contracts/fixtures/api/audit.request.json, expects 201 (or 200 if
 * that audit is already stored: same bytes, same audit_id, nothing new is written), then GETs it back. While
 * the fixture run is live, the ranking must equal contracts/fixtures/api/audit.response.json (created_at aside).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { REPO_ROOT } from "./lib/run.ts";
import { createSchemaAjv, validatorFor } from "./lib/schemas.ts";
import { PRODUCTION_URL } from "./lib/wrangler.ts";

interface Check {
  name: string;
  ok: boolean;
  ms: number;
  detail: string;
}

export interface SmokeOptions {
  base: string;
  audit?: "require" | "skip";
  expectRun?: string;
  log?: (line: string) => void;
}

export async function smoke(opts: SmokeOptions): Promise<{ ok: boolean; checks: Check[] }> {
  const base = opts.base.replace(/\/$/, "");
  const log = opts.log ?? ((l: string) => console.log(l));
  const { ajv } = createSchemaAjv({ allErrors: true });
  const checks: Check[] = [];
  let live: { run_id: string; fixture: boolean } | null = null;

  async function check(name: string, fn: () => Promise<string>): Promise<void> {
    const t0 = performance.now();
    let ok = true;
    let detail: string;
    try {
      detail = await fn();
    } catch (e) {
      ok = false;
      detail = (e as Error).message;
    }
    const ms = Math.round(performance.now() - t0);
    checks.push({ name, ok, ms, detail });
    log(`${ok ? "PASS" : "FAIL"}  ${name.padEnd(46)} ${String(ms).padStart(5)} ms  ${detail}`);
  }

  const get = (path: string, init: RequestInit = {}) => fetch(base + path, { redirect: "manual", ...init });
  function assert(cond: unknown, msg: string): asserts cond {
    if (!cond) throw new Error(msg);
  }
  const schemaOk = (rel: string, body: unknown) => {
    const errs = validatorFor(ajv, rel)(body);
    assert(errs.length === 0, `schema ${rel}: ${errs.slice(0, 3).join("; ")}`);
  };
  const secure = (res: Response) => {
    assert(res.headers.get("x-content-type-options") === "nosniff", "missing nosniff");
    assert(res.headers.get("referrer-policy") === "strict-origin-when-cross-origin", "missing referrer-policy");
  };
  async function json(path: string, schema: string, status = 200): Promise<Record<string, unknown>> {
    const res = await get(path);
    assert(res.status === status, `HTTP ${res.status}, want ${status}`);
    assert((res.headers.get("content-type") ?? "").startsWith("application/json"), `content-type ${res.headers.get("content-type")}`);
    secure(res);
    const body = (await res.json()) as Record<string, unknown>;
    schemaOk(schema, body);
    if (live && schema !== "api/error.schema.json") {
      assert(body["run_id"] === live.run_id, `run_id ${String(body["run_id"])}, live is ${live.run_id}`);
      assert(body["fixture"] === live.fixture, `fixture flag ${String(body["fixture"])} (T8)`);
    }
    return body;
  }

  await check("GET /api/health", async () => {
    const body = await json("/api/health", "api/health.schema.json");
    live = { run_id: body["run_id"] as string, fixture: body["fixture"] as boolean };
    if (opts.expectRun) assert(live.run_id === opts.expectRun, `live run ${live.run_id}, expected ${opts.expectRun}`);
    return `run ${live.run_id}${live.fixture ? " (SAMPLE: fixture=true, T8)" : ""}`;
  });

  const docs: [string, string][] = [
    ["/api/meta", "api/meta.schema.json"],
    ["/api/story", "api/story.schema.json"],
    ["/api/passes", "api/passes.schema.json"],
    ["/api/states", "api/states.schema.json"],
    ["/api/detectability", "api/detectability.schema.json"],
    ["/api/checks", "api/checks.schema.json"],
    ["/api/provenance", "api/provenance.schema.json"],
  ];
  let story: Record<string, unknown> = {};
  let meta: Record<string, unknown> = {};
  for (const [path, schema] of docs) {
    await check(`GET ${path}`, async () => {
      const body = await json(path, schema);
      if (path === "/api/story") story = body;
      if (path === "/api/meta") {
        meta = body;
        const limits = readFileSync(join(REPO_ROOT, "docs", "SPEC.md"), "utf8");
        assert(limits.replace(/\n> /g, " ").includes(String(body["limits_text"])), "limits_text is not SPEC D8 verbatim");
      }
      return "schema ok";
    });
  }

  await check("GET /api/fields (filters, paging)", async () => {
    const all = await json("/api/fields", "api/fields_page.schema.json");
    const tile = ((meta["tiles"] as { id: string }[] | undefined) ?? [])[0]?.id ?? "fazilka";
    const one = await json(`/api/fields?tile=${tile}&verdict=consistent&page=1`, "api/fields_page.schema.json");
    const bad = await get("/api/fields?verdict=fraud");
    assert(bad.status === 400, `bad verdict → ${bad.status}`);
    return `${String(all["total"])} fields; ${tile}+consistent → ${String(one["total"])}`;
  });

  await check("GET /api/fields/:id (hero field)", async () => {
    const id = String(story["hero_field_id"]);
    const body = await json(`/api/fields/${id}`, "api/field_detail.schema.json");
    return `${id}: ${(body["observations"] as unknown[]).length} observations`;
  });

  await check("GET /api/fields/:id unknown → 404", async () => {
    const body = await json("/api/fields/fazilka-99999", "api/error.schema.json", 404);
    return String((body["error"] as { code: string }).code);
  });

  await check("GET /api/meta If-None-Match → 304", async () => {
    const first = await get("/api/meta");
    const etag = first.headers.get("etag");
    assert(etag, "no ETag");
    await first.arrayBuffer();
    const again = await get("/api/meta", { headers: { "if-none-match": etag } });
    assert(again.status === 304, `HTTP ${again.status}`);
    return etag;
  });

  await check("GET /api and unknown /api route", async () => {
    const index = await get("/api");
    assert(index.status === 200, `/api → ${index.status}`);
    await json("/api/does-not-exist", "api/error.schema.json", 404);
    const wrong = await get("/api/meta", { method: "POST" });
    assert(wrong.status === 405, `POST /api/meta → ${wrong.status}`);
    return "200 / 404 / 405";
  });

  await check("GET /tiles fields.geojson Range → 206", async () => {
    const url = String((meta["assets"] as { fields_geojson: string }).fields_geojson);
    const res = await get(url, { headers: { range: "bytes=0-1023" } });
    assert(res.status === 206, `HTTP ${res.status}`);
    const cr = res.headers.get("content-range") ?? "";
    assert(/^bytes 0-1023\/\d+$/.test(cr), `content-range ${cr}`);
    const n = (await res.arrayBuffer()).byteLength;
    assert(n === 1024, `${n} bytes`);
    const size = Number(cr.split("/")[1]);
    const past = await get(url, { headers: { range: `bytes=${size}-` } });
    assert(past.status === 416, `past-the-end → ${past.status}`);
    const etag = res.headers.get("etag")!;
    const cond = await get(url, { headers: { "if-none-match": etag } });
    assert(cond.status === 304, `If-None-Match → ${cond.status}`);
    return `${cr}; 416 past end; 304 on ETag`;
  });

  await check("GET /tiles overlays and histograms", async () => {
    const assets = meta["assets"] as { overlays_index: string | null; hist: Record<string, string | null> };
    const urls = [assets.overlays_index, ...Object.values(assets.hist)].filter((u): u is string => Boolean(u));
    for (const u of urls) {
      const r = await get(u);
      assert(r.status === 200, `${u} → ${r.status}`);
      await r.arrayBuffer();
    }
    return `${urls.length} files`;
  });

  if (opts.audit !== "skip") {
    await check("POST /api/audit (golden request)", async () => {
      const body = readFileSync(join(REPO_ROOT, "contracts", "fixtures", "api", "audit.request.json"));
      const res = await get("/api/audit", { method: "POST", body, headers: { "content-type": "application/json" } });
      assert(res.status === 201 || res.status === 200, `HTTP ${res.status}`);
      const result = (await res.json()) as Record<string, unknown>;
      schemaOk("api/audit_response.schema.json", result);
      const id = String(result["audit_id"]);
      assert(res.headers.get("location") === `/api/audit/${id}`, "missing Location");
      let golden = "";
      if (live?.fixture && live.run_id === "fixture") {
        const want = JSON.parse(readFileSync(join(REPO_ROOT, "contracts", "fixtures", "api", "audit.response.json"), "utf8")) as Record<string, unknown>;
        const strip = (o: Record<string, unknown>) => JSON.stringify({ ...o, created_at: null });
        assert(strip(result) === strip(want), "ranking differs from contracts/fixtures/api/audit.response.json");
        golden = ", equals the golden ranking";
      }
      const back = await json(`/api/audit/${id}`, "api/audit_response.schema.json");
      assert(JSON.stringify(back) === JSON.stringify(result), "GET /api/audit/:id differs from the POST result");
      return `${res.status} ${id}${golden}; GET round trip ok`;
    });
    await check("POST /api/audit invalid → 400", async () => {
      const res = await get("/api/audit", { method: "POST", body: "{", headers: { "content-type": "application/json" } });
      const body = await (async () => {
        assert(res.status === 400, `HTTP ${res.status}`);
        return (await res.json()) as Record<string, unknown>;
      })();
      schemaOk("api/error.schema.json", body);
      return String((body["error"] as { code: string }).code);
    });
    await check("GET /api/audit/:id missing → 404", async () => {
      await json("/api/audit/a_0000000000000000", "api/error.schema.json", 404);
      return "not_found";
    });
  }

  await check("GET / (static page, link preview)", async () => {
    const res = await get("/");
    assert(res.status === 200, `HTTP ${res.status}`);
    assert((res.headers.get("content-type") ?? "").includes("text/html"), "not HTML");
    const html = await res.text();
    assert(html.includes('property="og:image"'), "no og:image");
    const og = /property="og:image" content="([^"]+)"/.exec(html)?.[1];
    if (og) {
      const img = await get(new URL(og).pathname);
      assert(img.status === 200 && img.headers.get("content-type") === "image/png", `og image → ${img.status}`);
      await img.arrayBuffer();
    }
    return "200 text/html, og:image ok";
  });

  await check("GET / Accept: text/markdown (Markdown negotiation, Vary)", async () => {
    const res = await get("/", { headers: { accept: "text/markdown" } });
    assert(res.status === 200, `HTTP ${res.status}`);
    assert((res.headers.get("content-type") ?? "").startsWith("text/markdown"), `content-type ${res.headers.get("content-type")}`);
    assert(/\baccept\b/i.test(res.headers.get("vary") ?? ""), "no Vary: Accept");
    const md = await res.text();
    assert(md.startsWith("# "), "not Markdown");
    return `200 text/markdown, ${md.length} chars`;
  });

  await check("GET an unknown path (real 404, HTML and Markdown)", async () => {
    const html = await get("/this-page-does-not-exist");
    assert(html.status === 404, `HTML: HTTP ${html.status}`);
    await html.text();
    const md = await get("/this-page-does-not-exist", { headers: { accept: "text/markdown" } });
    assert(md.status === 404, `Markdown: HTTP ${md.status}`);
    assert((md.headers.get("content-type") ?? "").startsWith("text/markdown"), `content-type ${md.headers.get("content-type")}`);
    await md.text();
    return "404 text/html, 404 text/markdown";
  });

  await check("GET every page in site.json (200 HTML)", async () => {
    const site = (await (await get("/site.json")).json()) as { markdown: string[]; app_prefixes: string[] };
    for (const p of site.markdown) {
      const r = await get(p);
      assert(r.status === 200 && (r.headers.get("content-type") ?? "").includes("text/html"), `${p} → ${r.status}`);
      await r.text();
    }
    return `${site.markdown.length} pages`;
  });

  await check("GET /openapi.json, /llms.txt, /.well-known/api-catalog", async () => {
    const spec = (await (await get("/openapi.json")).json()) as { openapi?: string };
    assert(spec.openapi === "3.1.0", `openapi ${spec.openapi}`);
    for (const p of ["/llms.txt", "/.well-known/api-catalog", "/openapi.yaml"]) {
      const r = await get(p);
      assert(r.status === 200, `${p} → ${r.status}`);
      await r.text();
    }
    return "OpenAPI 3.1, llms.txt, api-catalog";
  });

  await check("GET /robots.txt and /sitemap.xml", async () => {
    for (const p of ["/robots.txt", "/sitemap.xml"]) {
      const r = await get(p);
      assert(r.status === 200, `${p} → ${r.status}`);
      await r.text();
    }
    return "200";
  });

  const ok = checks.every((c) => c.ok);
  const total = checks.reduce((n, c) => n + c.ms, 0);
  log(`${ok ? "OK" : "FAILED"}: ${checks.filter((c) => c.ok).length}/${checks.length} checks passed against ${base} in ${total} ms`);
  return { ok, checks };
}

async function main() {
  const { values } = parseArgs({
    options: {
      base: { type: "string", default: PRODUCTION_URL },
      audit: { type: "string", default: "require" },
      "expect-run": { type: "string" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) {
    console.log("usage: node scripts/smoke.ts [--base URL] [--audit require|skip] [--expect-run ID] [--json]");
    return;
  }
  if (!["require", "skip"].includes(values.audit)) throw new Error("--audit must be require or skip");
  const res = await smoke({
    base: values.base,
    audit: values.audit as "require",
    ...(values["expect-run"] ? { expectRun: values["expect-run"] } : {}),
    ...(values.json ? { log: () => {} } : {}),
  });
  if (values.json) console.log(JSON.stringify(res));
  process.exit(res.ok ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e: Error) => {
    console.error(`smoke: ${e.message}`);
    process.exit(1);
  });
}
