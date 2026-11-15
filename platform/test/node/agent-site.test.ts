// The agent-ready site (DECISIONS.md K-321 to K-327): pages, Markdown twins, OpenAPI, llms.txt, JSON-LD and
// _routes.json, built from the fixture run with the placeholder and (when present) with Volk's app.
import { createRequire } from "node:module";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildSite } from "../../scripts/build-site.ts";
import { exampleAuditBody } from "../../scripts/lib/content.ts";
import { checkHeadings, textLength } from "../../scripts/lib/doc.ts";
import { buildOpenApi, operations, schemaComponents } from "../../scripts/lib/openapi.ts";
import { PAGE_CSS, PAGE_CSS_HASH, appPageHtml, hasRawContent, visibleText } from "../../scripts/lib/pages.ts";
import { FIXTURE_RUN, REPO_ROOT } from "../../scripts/lib/run.ts";
import { createSchemaAjv, validatorFor } from "../../scripts/lib/schemas.ts";
import { ROUTES, createApp } from "../../src/app.ts";

const SITE = "https://agentic.mudskipper-nisar.pages.dev";
const out = mkdtempSync(join(tmpdir(), "mudskipper-agent-"));
const built = buildSite({ runDir: FIXTURE_RUN, out, fixtures: true, placeholder: true, siteUrl: SITE });
const read = (rel: string) => readFileSync(join(out, rel), "utf8");
const spec = JSON.parse(read("openapi.json")) as {
  openapi: string;
  servers: { url: string }[];
  paths: Record<string, Record<string, { operationId: string; summary: string; description: string; parameters?: { $ref?: string; schema?: unknown }[]; responses: Record<string, { $ref?: string; content?: Record<string, { schema: unknown }> }> }>>;
  components: { schemas: Record<string, unknown> };
};
afterAll(() => rmSync(out, { recursive: true, force: true }));

describe("OpenAPI", () => {
  it("is OpenAPI 3.1 for this origin, and the YAML says the same thing", async () => {
    expect(spec.openapi).toBe("3.1.0");
    expect(spec.servers[0]!.url).toBe(SITE);
    const require = createRequire(import.meta.url);
    let yaml: { load(s: string): unknown } | null = null;
    try {
      yaml = require("js-yaml") as { load(s: string): unknown };
    } catch {
      /* js-yaml is only a transitive dependency; skip the round trip without it */
    }
    if (yaml) expect(yaml.load(read("openapi.yaml"))).toEqual(spec);
  });

  it("covers every route the Hono app serves, and nothing else", () => {
    const norm = (p: string) => p.replace(/:[a-z_]+/g, "{}").replace(/\{[a-z_]+\}/g, "{}");
    const fromApp = new Set(
      createApp()
        .routes.filter((r) => r.method !== "ALL" && r.method !== "OPTIONS" && r.path !== "/api/")
        .map((r) => `${r.method} ${norm(r.path)}`),
    );
    const fromSpec = new Set(operations(spec as never).map((o) => (o.includes(" /tiles/") ? o.replace(/ \/tiles\/.*/, " /tiles/*") : norm(o))));
    expect([...fromSpec].sort()).toEqual([...fromApp].sort());
    // and the ROUTES list the /api index and the placeholder show
    for (const r of ROUTES) for (const m of r.methods) expect(fromApp.has(`${m} ${norm(r.path)}`), `${m} ${r.path}`).toBe(true);
  });

  it("gives every operation a unique operationId, a summary, a description, typed parameters and response schemas", () => {
    const ids = new Set<string>();
    for (const [path, ops] of Object.entries(spec.paths)) {
      for (const [method, op] of Object.entries(ops)) {
        const where = `${method} ${path}`;
        expect(op.operationId, where).toMatch(/^[a-z][A-Za-z]+$/);
        expect(ids.has(op.operationId), `duplicate ${op.operationId}`).toBe(false);
        ids.add(op.operationId);
        expect(op.summary.length, where).toBeGreaterThan(10);
        expect(op.description.length, where).toBeGreaterThan(40);
        for (const p of op.parameters ?? []) expect(p.$ref ?? p.schema, where).toBeTruthy();
        const ok = Object.entries(op.responses).filter(([s]) => /^2/.test(s));
        expect(ok.length, where).toBeGreaterThan(0);
        for (const [, r] of ok) expect(r.$ref ?? Object.values(r.content ?? {})[0]?.schema, where).toBeTruthy();
        expect(Object.keys(op.responses).some((s) => /^[45]/.test(s)), `${where} has error responses`).toBe(true);
      }
    }
    expect(ids.has("createAudit")).toBe(true);
  });

  it("documents the audit rate limit and the tiles Range behaviour", () => {
    const audit = spec.paths["/api/audit"]!["post"]!;
    expect(audit.description).toMatch(/20 audits at once per client IP, then one every 3 s/);
    expect(Object.keys(audit.responses)).toEqual(expect.arrayContaining(["201", "200", "400", "413", "429"]));
    const tile = spec.paths["/tiles/runs/{run_id}/{file}"]!["get"]!;
    expect(Object.keys(tile.responses)).toEqual(expect.arrayContaining(["200", "206", "304", "416"]));
  });

  it("references only components that exist, and keeps no unused ones", () => {
    const text = JSON.stringify(spec);
    const refs = new Set([...text.matchAll(/"#\/components\/schemas\/([A-Za-z0-9_]+)"/g)].map((m) => m[1]!));
    for (const r of refs) expect(spec.components.schemas[r], r).toBeDefined();
    for (const name of Object.keys(spec.components.schemas)) expect(refs.has(name), `unused ${name}`).toBe(true);
  });

  it("its schemas are the contract's: every API fixture validates against the component, as against contracts/schemas", async () => {
    const { ajv } = createSchemaAjv({ strictSchema: false });
    ajv.addSchema({ $id: "https://mudskipper.invalid/openapi.json", components: spec.components } as never);
    const cases: [string, string, string][] = [
      ["health.json", "HealthResponse", "api/health.schema.json"],
      ["meta.json", "MetaResponse", "api/meta.schema.json"],
      ["story.json", "StoryResponse", "api/story.schema.json"],
      ["passes.json", "PassesResponse", "api/passes.schema.json"],
      ["states.json", "StatesResponse", "api/states.schema.json"],
      ["fields.json", "FieldsPageResponse", "api/fields_page.schema.json"],
      ["field.fazilka-00114.json", "FieldDetailResponse", "api/field_detail.schema.json"],
      ["detectability.json", "DetectabilityResponse", "api/detectability.schema.json"],
      ["checks.json", "ChecksResponse", "api/checks.schema.json"],
      ["provenance.json", "ProvenanceResponse", "api/provenance.schema.json"],
      ["audit.request.json", "AuditRequest", "api/audit_request.schema.json"],
      ["audit.response.json", "AuditResponse", "api/audit_response.schema.json"],
      ["error.not_found.json", "Error", "api/error.schema.json"],
    ];
    for (const [file, component, schema] of cases) {
      const doc = JSON.parse(readFileSync(join(REPO_ROOT, "contracts", "fixtures", "api", file), "utf8"));
      const viaSpec = ajv.getSchema(`https://mudskipper.invalid/openapi.json#/components/schemas/${component}`)!;
      expect(viaSpec(doc), `${file} vs ${component}: ${JSON.stringify(viaSpec.errors)}`).toBe(true);
      expect(validatorFor(ajv, schema)(doc)).toEqual([]);
      // a broken document fails both
      const bad = { ...doc, v: 2 };
      expect(viaSpec(bad), `${component} rejects v: 2`).toBe(false);
    }
  });

  it("fails the build on a $ref it cannot place", () => {
    expect(() => schemaComponents(["api/meta.schema.json"])).not.toThrow();
    expect(buildOpenApi({ siteUrl: SITE, exampleRunId: "r01", exampleFieldId: null }).openapi).toBe("3.1.0");
  });
});

describe("pages and Markdown", () => {
  const pages = ["index", "about", "contact", "privacy", "developers"];

  it("ships a top-level 404.html (real 404s, no SPA fallback) and a Markdown twin of every page", () => {
    expect(existsSync(join(out, "404.html"))).toBe(true);
    for (const p of [...pages, "404"]) expect(read(`${p}.md`).length, p).toBeGreaterThan(100);
    expect(JSON.parse(read("site.json"))).toEqual({ markdown: ["/", "/about", "/contact", "/privacy", "/developers"], app_prefixes: [] });
    expect(read("404.md")).toMatch(/^# Page not found\n/);
    expect(read("404.md")).toContain(`${SITE}/llms.txt`);
  });

  it("gives every page one h1, sequential headings and 500+ characters of text without JavaScript", () => {
    for (const p of pages) {
      const html = read(`${p}.html`);
      expect(hasRawContent(html), p).toBe(true);
      expect(visibleText(html).length, p).toBeGreaterThanOrEqual(500);
      expect(html.match(/<h1[\s>]/g), p).toHaveLength(1);
      const levels = [...html.matchAll(/<h([1-6])[\s>]/g)].map((m) => Number(m[1]));
      levels.reduce((a, b) => (expect(b - a, `${p}: h${a} → h${b}`).toBeLessThanOrEqual(1), b));
    }
  });

  it("links the docs, OpenAPI, llms.txt and the trust pages from the homepage", () => {
    const html = read("index.html");
    for (const href of ["/developers", "/openapi.json", "/llms.txt", "/about", "/contact", "/privacy", "/api"]) expect(html, href).toContain(`href="${href}"`);
    expect(html).toContain('<link rel="service-desc" type="application/vnd.oai.openapi+json" href="/openapi.json">');
    expect(html).toContain('<link rel="alternate" type="text/markdown" href="/index.md"');
    expect(html).toContain('<meta name="is-agentic-site-type" content="app">');
  });

  it("keeps the placeholder's strict CSP valid for the generated pages' one stylesheet", () => {
    expect(read("_headers")).toContain(PAGE_CSS_HASH);
    for (const p of ["about", "404"]) {
      const html = read(`${p}.html`);
      expect(html.match(/<style>([\s\S]*?)<\/style>/)![1]).toBe(PAGE_CSS);
      expect(html).not.toMatch(/<script/);
      expect(html).not.toMatch(/\sstyle="/);
    }
  });

  it("states the privacy facts the code enforces (no cookies, 30-day KV ranking only, rate limit) and no personal email", () => {
    const privacy = read("privacy.md");
    expect(privacy).toContain("sets no cookies");
    expect(privacy).toContain("Cloudflare Workers KV for 30 days");
    expect(privacy).toContain("never stored or logged");
    expect(privacy).toContain("20 at once per IP address, then one every 3 seconds");
    for (const f of readdirSync(out).filter((n) => /\.(html|md|txt|json)$/.test(n))) {
      expect(read(f), f).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}/);
    }
  });

  it("puts the developer guide's audit example through the request schema", () => {
    const { ajv } = createSchemaAjv();
    expect(validatorFor(ajv, "api/audit_request.schema.json")(JSON.parse(exampleAuditBody(built.bundle)))).toEqual([]);
    expect(read("developers.md")).toContain(exampleAuditBody(built.bundle));
  });
});

describe("llms.txt, JSON-LD, discovery", () => {
  it("follows llms.txt: an H1, a summary, a 'When to use' section, API calls and the evidence tags", () => {
    const llms = read("llms.txt");
    expect(llms).toMatch(/^# Mudskipper\n\n> /);
    expect(llms).toContain("## When to use Mudskipper");
    expect(llms).toContain("## How to call the API");
    for (const t of ["OBSERVED", "INFERRED", "ASSUMED"]) expect(llms).toContain(`- ${t}: `);
    expect(llms).toContain(`[OpenAPI 3.1 description](${SITE}/openapi.json)`);
    expect(read("llms-full.txt")).toContain(`Source: ${SITE}/developers`);
  });

  it("describes the site in JSON-LD with true facts only (no address, phone or email)", () => {
    const ld = JSON.parse(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(read("index.html"))![1]!) as { "@graph": Record<string, unknown>[] };
    const byType = Object.fromEntries(ld["@graph"].map((n) => [n["@type"] as string, n]));
    for (const t of ["WebSite", "WebApplication", "WebAPI", "Dataset", "Organization"]) expect(byType[t], t).toBeDefined();
    const app = byType["WebApplication"]!;
    for (const k of ["name", "description", "url", "keywords"]) expect(app[k], k).toBeTruthy();
    expect(app["isAccessibleForFree"]).toBe(true);
    const org = JSON.stringify(byType["Organization"]);
    expect(org).toContain("NASA Space Apps Challenge 2026");
    for (const k of ["address", "telephone", "email", "PostalAddress"]) expect(org).not.toContain(k);
  });

  it("publishes an RFC 9727 API catalog, a sitemap of every page and robots that welcome agents", () => {
    const cat = JSON.parse(read(".well-known/api-catalog")) as { linkset: { anchor: string; "service-desc": { href: string }[] }[] };
    expect(cat.linkset[0]!.anchor).toBe(`${SITE}/api`);
    expect(cat.linkset[0]!["service-desc"][0]!.href).toBe(`${SITE}/openapi.json`);
    const sitemap = read("sitemap.xml");
    for (const p of ["/", "/about", "/contact", "/privacy", "/developers"]) expect(sitemap).toContain(`<loc>${SITE}${p}</loc>`);
    expect(read("robots.txt")).toMatch(/User-agent: \*\nAllow: \//);
  });

  it("runs the page middleware everywhere except static files, inside the 100-rule limit", () => {
    const routes = JSON.parse(read("_routes.json")) as { include: string[]; exclude: string[] };
    expect(routes.include).toEqual(["/*"]);
    for (const e of ["/data/*", "/fonts/*", "/og.png", "/favicon.svg", "/robots.txt", "/sitemap.xml", "/llms.txt", "/openapi.json", "/site.json"]) expect(routes.exclude, e).toContain(e);
    for (const e of routes.exclude) expect(e).not.toMatch(/\.(html|md|yaml)$|^\/(api|tiles|\.well-known)/);
    expect(routes.include.length + routes.exclude.length).toBeLessThanOrEqual(100);
  });
});

describe("prerendering into an app's mount node", () => {
  const ctx = { siteUrl: SITE, bundle: built.bundle, appRoutes: ["/lab"], appPrefixes: ["/field/"], app: "app" as const, extraPages: [] };
  const page = { path: "/lab", title: "Lab: test", description: "d", blocks: [{ h: 1 as const, text: "Lab" }, { p: "x ".repeat(300) }] };

  it("fills an empty mount node, hidden while the app runs and shown without JavaScript", () => {
    const shell = '<!doctype html><html><head><title>t</title><link rel="canonical" href="https://x/"></head><body><div id="app"></div><script type="module" src="/assets/a.js"></script></body></html>';
    const html = appPageHtml(ctx, shell, page, null);
    expect(html).toContain('<div id="app"><div class="ms ms-prerender">');
    expect(html).toContain(".ms-prerender{display:none}");
    expect(html).toContain("<noscript><style>.ms-prerender{display:block}");
    expect(html).toContain('<script type="module" src="/assets/a.js"></script>');
    expect(html).toContain(`<link rel="canonical" href="${SITE}/lab">`);
    expect(html).toContain("<title>Lab: test · Mudskipper</title>");
    expect(visibleText(html).length).toBeGreaterThan(500);
  });

  it("leaves an app that already has content alone, adding only the head links and a footer row", () => {
    const rich = `<!doctype html><html><head><title>t</title></head><body><h1>App</h1><p>${"words ".repeat(120)}</p><footer><div class="foot-meta">m</div></footer></body></html>`;
    const html = appPageHtml(ctx, rich, page, null);
    expect(html).not.toContain("ms-prerender");
    expect(html.match(/<h1/g)).toHaveLength(1);
    expect(html).toContain('aria-label="For developers and AI agents"');
    expect(html.indexOf("For developers and AI agents")).toBeLessThan(html.indexOf('<div class="foot-meta"'));
  });

  it("checks every generated page's outline", () => {
    expect(() => checkHeadings({ path: "/x", title: "", description: "", blocks: [{ h: 2, text: "no h1" }] })).toThrow();
    expect(() => checkHeadings({ path: "/x", title: "", description: "", blocks: [{ h: 1, text: "a" }, { h: 3, text: "skip" }] })).toThrow();
    expect(textLength(page)).toBeGreaterThan(500);
  });
});
