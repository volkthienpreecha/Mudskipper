// Site assembly, then the real Pages runtime (`wrangler pages dev`) serving it, checked by the smoke script.
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { APP_CSP, buildSite, installApp } from "../../scripts/build-site.ts";
import { FIXTURE_RUN, PLATFORM_ROOT, REPO_ROOT } from "../../scripts/lib/run.ts";
import { smoke } from "../../scripts/smoke.ts";
import { LIMITS_TEXT } from "../../src/limits.ts";

const out = mkdtempSync(join(tmpdir(), "mudskipper-site-"));
const site = buildSite({ runDir: FIXTURE_RUN, out, fixtures: true, placeholder: true });
const html = readFileSync(join(out, "index.html"), "utf8");
const headers = readFileSync(join(out, "_headers"), "utf8");
const b64 = (s: string) => createHash("sha256").update(s, "utf8").digest("base64");

describe("build-site (placeholder)", () => {
  it("routes Functions only on /api, /api/* and /tiles/*", () => {
    expect(JSON.parse(readFileSync(join(out, "_routes.json"), "utf8"))).toEqual({
      version: 1,
      include: ["/api", "/api/*", "/tiles/*"],
      exclude: [],
    });
  });

  it("has no top-level 404.html, so Pages falls back to index.html (SPA)", () => {
    expect(existsSync(join(out, "404.html"))).toBe(false);
  });

  it("fills every template slot and shows SAMPLE DATA, the headline and the Limits text verbatim", () => {
    expect(html).not.toMatch(/\{\{[A-Z_]+\}\}/);
    expect(html).toContain("SAMPLE DATA");
    expect(html).toContain(">29%</span> of 300 rice fields had enough clear radar looks for a drainage verdict.");
    expect(html).toContain(LIMITS_TEXT);
    expect(LIMITS_TEXT).toBe(
      "No 2026 ground truth in Punjab yet. NISAR revisits every 12 days and has a data gap from Jul 27 to Aug 10, 2026. " +
        "Data are provisional. States are inferred without labels. DSR is a signal, not proof. We show irrigation evidence, not emissions.",
    );
    const spec = readFileSync(join(REPO_ROOT, "docs", "SPEC.md"), "utf8").replace(/\n> /g, " ");
    expect(spec).toContain(LIMITS_TEXT);
  });

  it("tags every number with its evidence tag (T12), and the og image alt does not call decoration data", () => {
    expect(html).toMatch(/10 passes <span class="chip chip-observed"[^>]*>OBSERVED<\/span> · 300 fields <span class="chip chip-inferred"[^>]*>INFERRED<\/span> · 2 tiles <span class="chip chip-assumed"[^>]*>ASSUMED<\/span>/);
    const cap = /<span class="cap">([\s\S]*?)<\/span>\s*<\/figcaption>/.exec(html)?.[1] ?? "";
    expect(cap).toMatch(/fields <span class="chip chip-inferred"/);
    expect(cap).toMatch(/passes <span class="chip chip-observed"/);
    expect(cap).toMatch(/2026-10-23 <span class="chip chip-assumed"/);
    expect(html).toContain('og:image:alt" content="Mudskipper: Was this rice field really drained? The wordmark beside a decorative pattern of water and mud squares (an illustration, not data).');
  });

  it("has link-preview and SEO metadata", () => {
    for (const tag of ['property="og:image" content="https://mudskipper-nisar.pages.dev/og.png"', 'name="twitter:card" content="summary_large_image"', 'rel="canonical"', 'name="description"', "application/ld+json"]) {
      expect(html).toContain(tag);
    }
    for (const f of ["og.png", "favicon.svg", "favicon-48.png", "apple-touch-icon.png", "robots.txt", "sitemap.xml", "fonts/fraunces-latin.woff2"]) {
      expect(existsSync(join(out, f)), f).toBe(true);
    }
    expect(readFileSync(join(out, "robots.txt"), "utf8")).toContain("Sitemap: https://mudskipper-nisar.pages.dev/sitemap.xml");
  });

  it("the CSP allows exactly the one inline style and the one inline script, and nothing inline else", () => {
    const style = /<style>([\s\S]*?)<\/style>/.exec(html)![1]!;
    const script = /<script>([\s\S]*?)<\/script>/.exec(html)![1]!;
    expect(headers).toContain(`style-src 'sha256-${b64(style)}'`);
    expect(headers).toContain(`script-src 'sha256-${b64(script)}'`);
    expect(html.match(/<style/g)).toHaveLength(1);
    expect(html.match(/<script/g)).toHaveLength(2); // the inline script + the ld+json data block
    expect(html).not.toMatch(/\sstyle="/);
    expect(html).not.toMatch(/\son[a-z]+="/);
  });

  it("_headers sets security headers and run-scoped cache policy", () => {
    expect(headers).toContain("X-Content-Type-Options: nosniff");
    expect(headers).toContain("Referrer-Policy: strict-origin-when-cross-origin");
    expect(headers).toContain("/data/runs/fixture/*\n  Cache-Control: public, max-age=300");
    expect(headers).toContain("/data/live.json\n  Cache-Control: no-cache");
  });

  it("stays inside the Pages limits", () => {
    expect(site.files).toBeLessThan(20_000);
    expect(site.app).toBe("placeholder");
  });
});

// The real thing: Pages Functions routing, ASSETS behaviour and _routes.json under `wrangler pages dev`.
describe.skipIf(process.env["SKIP_PAGES_DEV"] === "1")("wrangler pages dev + smoke", () => {
  let proc: ChildProcess;
  const port = 18000 + Math.floor(Math.random() * 1000);
  const persist = mkdtempSync(join(tmpdir(), "mudskipper-pd-"));

  beforeAll(async () => {
    proc = spawn(
      join(REPO_ROOT, "node_modules", ".bin", "wrangler"),
      ["pages", "dev", out, "--port", String(port), "--persist-to", persist, "--show-interactive-dev-session=false"],
      { cwd: PLATFORM_ROOT, stdio: "ignore", env: { ...process.env, CI: "true" } },
    );
    for (let i = 0; i < 120; i++) {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/api/health`);
        if (r.ok) return;
      } catch {
        /* not up yet */
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error("wrangler pages dev did not start");
  });

  afterAll(() => {
    proc?.kill();
    rmSync(out, { recursive: true, force: true });
    rmSync(persist, { recursive: true, force: true });
  });

  it("passes every smoke check", async () => {
    const res = await smoke({ base: `http://127.0.0.1:${port}`, expectRun: "fixture", log: () => {} });
    const failed = res.checks.filter((c) => !c.ok);
    expect(failed).toEqual([]);
    expect(res.checks.length).toBeGreaterThanOrEqual(20);
  });

  it("static paths never reach the Function (no API security headers on /)", async () => {
    const r = await fetch(`http://127.0.0.1:${port}/`);
    expect(r.headers.get("content-security-policy")).toContain("script-src 'sha256-");
    expect(r.headers.get("access-control-expose-headers")).toBeNull(); // only the Function sets this
  });
});

describe.runIf(existsSync(join(REPO_ROOT, "app", "package.json")))("build-site with Volk's app", () => {
  const appOut = mkdtempSync(join(tmpdir(), "mudskipper-app-site-"));
  const built = buildSite({ runDir: FIXTURE_RUN, out: appOut, fixtures: true, appApiBase: "https://staging.mudskipper-nisar.pages.dev" });
  const appHeaders = readFileSync(join(appOut, "_headers"), "utf8");
  afterAll(() => rmSync(appOut, { recursive: true, force: true }));

  it("builds app/dist fresh against the given API origin and ships it with the /data bundle", () => {
    expect(built.app).toBe("app/dist");
    const html = readFileSync(join(appOut, "index.html"), "utf8");
    const js = /src="(\/assets\/[^"]+\.js)"/.exec(html)![1]!;
    expect(readFileSync(join(appOut, js), "utf8")).toContain("https://staging.mudskipper-nisar.pages.dev");
    expect(existsSync(join(appOut, "data", "live.json"))).toBe(true);
    // link preview added to the built page only (app/index.html is untouched)
    expect(html).toContain('<meta property="og:image" content="https://mudskipper-nisar.pages.dev/og.png">');
    expect(html).toContain('<link rel="canonical" href="https://mudskipper-nisar.pages.dev/">');
    expect(existsSync(join(appOut, "og.png"))).toBe(true);
    expect(readFileSync(join(REPO_ROOT, "app", "index.html"), "utf8")).not.toContain("og:image");
  });

  it("publish's production step re-installs the app with the same page assembly (link preview kept, /data untouched)", () => {
    const before = readFileSync(join(appOut, "data", "live.json"), "utf8");
    installApp(appOut, "https://mudskipper-nisar.pages.dev");
    expect(readFileSync(join(appOut, "index.html"), "utf8")).toContain('property="og:image"');
    expect(readFileSync(join(appOut, "data", "live.json"), "utf8")).toBe(before);
  });

  it("gives the app its own CSP (MapLibre worker, basemap tiles, the API) and immutable hashed assets", () => {
    expect(appHeaders).toContain(`Content-Security-Policy: ${APP_CSP}`);
    for (const d of ["script-src 'self'", "worker-src 'self' blob:", "https://server.arcgisonline.com", "frame-ancestors 'none'", "object-src 'none'"]) {
      expect(APP_CSP).toContain(d);
    }
    expect(APP_CSP).not.toContain("'unsafe-eval'");
    expect(appHeaders).toMatch(/\/assets\/\*\n {2}Cache-Control: public, max-age=31536000, immutable/);
    expect(appHeaders).toMatch(/\/img\/\*\n {2}Cache-Control: public, max-age=86400, stale-while-revalidate=604800/);
    expect(readFileSync(join(appOut, "sitemap.xml"), "utf8")).toContain("<loc>https://mudskipper-nisar.pages.dev/lab</loc>");
  });
});
