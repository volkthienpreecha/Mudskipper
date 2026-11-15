// Site assembly, then the real Pages runtime (`wrangler pages dev`) serving it, checked by the smoke script.
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { APP_CSP, SECURITY_CONTACT, buildSite, finishSite, installApp, securityTxt } from "../../scripts/build-site.ts";
import { HSTS, PERMISSIONS_POLICY } from "../../src/http/headers.ts";
import { FIXTURE_RUN, PLATFORM_ROOT, REPO_ROOT } from "../../scripts/lib/run.ts";
import { smoke } from "../../scripts/smoke.ts";
import { LIMITS_TEXT } from "../../src/limits.ts";

const out = mkdtempSync(join(tmpdir(), "mudskipper-site-"));
const site = buildSite({ runDir: FIXTURE_RUN, out, fixtures: true, placeholder: true });
const html = readFileSync(join(out, "index.html"), "utf8");
const headers = readFileSync(join(out, "_headers"), "utf8");
const b64 = (s: string) => createHash("sha256").update(s, "utf8").digest("base64");

describe("build-site (placeholder)", () => {
  it("runs Functions on pages and the API, never on static files (K-321)", () => {
    const routes = JSON.parse(readFileSync(join(out, "_routes.json"), "utf8")) as { version: number; include: string[]; exclude: string[] };
    expect(routes.version).toBe(1);
    expect(routes.include).toEqual(["/*"]);
    expect(routes.exclude).toEqual(expect.arrayContaining(["/data/*", "/fonts/*", "/og.png", "/favicon.svg"]));
  });

  it("has a top-level 404.html, so unknown paths are real 404s (no SPA fallback, K-321)", () => {
    expect(existsSync(join(out, "404.html"))).toBe(true);
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

  it("_headers adds HSTS, CORP, a wide Permissions-Policy and framing denial on every static path (K-341)", () => {
    const all = /^\/\*\n((?: {2}.+\n)+)/m.exec(headers)![1]!;
    expect(all).toContain(`Strict-Transport-Security: ${HSTS}`);
    expect(HSTS).toBe("max-age=31536000; includeSubDomains");
    expect(all).toContain("Cross-Origin-Resource-Policy: same-site");
    expect(all).toContain(`Permissions-Policy: ${PERMISSIONS_POLICY}`);
    for (const f of ["camera=()", "microphone=()", "geolocation=()", "usb=()", "browsing-topics=()"]) expect(PERMISSIONS_POLICY).toContain(f);
    expect(all).toContain("X-Frame-Options: DENY");
    expect(all).toContain("Cross-Origin-Opener-Policy: same-origin");
    expect(all).toMatch(/Content-Security-Policy: [^\n]*frame-ancestors 'none'/);
    // the public /data bundle stays readable from other origins: CORP is detached there
    expect(headers).toContain("/data/*\n  ! Cross-Origin-Resource-Policy");
  });

  it("publishes an RFC 9116 security.txt that expires within a year and names the advisory form", () => {
    const txt = readFileSync(join(out, ".well-known", "security.txt"), "utf8");
    expect(txt).toContain(`Contact: ${SECURITY_CONTACT}`);
    expect(SECURITY_CONTACT).toBe("https://github.com/volkthienpreecha/Mudskipper/security/advisories/new");
    expect(txt).toContain("Canonical: https://mudskipper-nisar.pages.dev/.well-known/security.txt");
    expect(txt).not.toMatch(/@/); // no personal email addresses
    const now = new Date("2026-11-15T12:34:56Z");
    const expires = /^Expires: (.+)$/m.exec(securityTxt("https://x.example", now))![1]!;
    expect(expires).toMatch(/^\d{4}-\d{2}-\d{2}T00:00:00Z$/); // RFC 3339, as RFC 9116 requires
    const ahead = Date.parse(expires) - now.getTime();
    expect(ahead).toBeGreaterThan(300 * 86_400_000);
    expect(ahead).toBeLessThan(365 * 86_400_000);
    for (const line of txt.trim().split("\n")) expect(line).toMatch(/^(Contact|Expires|Policy|Preferred-Languages|Canonical): \S/);
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

  it("pages keep their static headers through the page middleware (no API headers on /)", async () => {
    const r = await fetch(`http://127.0.0.1:${port}/`);
    expect(r.headers.get("content-security-policy")).toContain("script-src 'sha256-");
    expect(r.headers.get("access-control-expose-headers")).toBeNull(); // only the API sets this
    expect(r.headers.get("vary")).toBe("Accept");
  });

  it("negotiates Markdown and answers unknown paths with real 404s under the real Pages runtime", async () => {
    const md = await fetch(`http://127.0.0.1:${port}/`, { headers: { accept: "text/markdown" } });
    expect(md.status).toBe(200);
    expect(md.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(md.headers.get("vary")).toBe("Accept");
    expect(await md.text()).toMatch(/^# Mudskipper/);
    const html = await fetch(`http://127.0.0.1:${port}/`, { headers: { accept: "text/html" } });
    expect(html.headers.get("content-type")).toContain("text/html");
    await html.text();
    const missing = await fetch(`http://127.0.0.1:${port}/some-path-that-does-not-exist`, { headers: { accept: "text/markdown" } });
    expect(missing.status).toBe(404);
    expect(missing.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(await missing.text()).toContain("Page not found");
    const missingHtml = await fetch(`http://127.0.0.1:${port}/nope/deeper`);
    expect(missingHtml.status).toBe(404);
    expect(await missingHtml.text()).toContain("<h1>Page not found</h1>");
    for (const p of ["/about", "/contact", "/privacy", "/developers", "/openapi.json", "/llms.txt", "/.well-known/api-catalog"]) {
      const r = await fetch(`http://127.0.0.1:${port}${p}`);
      expect(r.status, p).toBe(200);
      await r.arrayBuffer();
    }
    const api404 = await fetch(`http://127.0.0.1:${port}/api/nope`);
    expect(api404.status).toBe(404);
    expect(api404.headers.get("content-type")).toContain("application/json");
    await api404.text();
  });
});

describe("vercel.json (the teammate's Vercel copy of the app)", () => {
  const vercel = JSON.parse(readFileSync(join(REPO_ROOT, "vercel.json"), "utf8")) as {
    rewrites: { source: string; destination: string }[];
    headers: { source: string; headers: { key: string; value: string }[] }[];
  };
  const all = Object.fromEntries(vercel.headers.find((h) => h.source === "/(.*)")!.headers.map((h) => [h.key, h.value]));

  it("sends the same document security headers as the Pages deployment (K-342)", () => {
    expect(all["Content-Security-Policy"]).toBe(APP_CSP);
    expect(all["Permissions-Policy"]).toBe(PERMISSIONS_POLICY);
    expect(all["X-Frame-Options"]).toBe("DENY");
    expect(all["X-Content-Type-Options"]).toBe("nosniff");
    expect(all["Cross-Origin-Opener-Policy"]).toBe("same-origin");
    expect(all["Referrer-Policy"]).toBe("strict-origin-when-cross-origin");
  });

  it("keeps its routing: /api and /tiles proxied to production, the rest to the SPA", () => {
    expect(vercel.rewrites.map((r) => r.destination)).toEqual([
      "https://mudskipper-nisar.pages.dev/api/:path*",
      "https://mudskipper-nisar.pages.dev/tiles/:path*",
      "/index.html",
    ]);
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
    finishSite(appOut, built.bundle, { siteUrl: "https://mudskipper-nisar.pages.dev", useApp: true });
    const html = readFileSync(join(appOut, "index.html"), "utf8");
    expect(html).toContain('property="og:image"');
    expect(html.match(/rel="service-desc"/g)).toHaveLength(1); // assembled once, not twice
    expect(readFileSync(join(appOut, "openapi.json"), "utf8")).toContain('"url": "https://mudskipper-nisar.pages.dev"');
    expect(readFileSync(join(appOut, "data", "live.json"), "utf8")).toBe(before);
  });

  it("gives the app its own CSP (MapLibre worker, basemap tiles, the API) and immutable hashed assets", () => {
    expect(appHeaders).toContain(`Content-Security-Policy: ${APP_CSP}`);
    for (const d of ["script-src 'self'", "worker-src 'self' blob:", "https://server.arcgisonline.com", "frame-ancestors 'none'", "object-src 'none'"]) {
      expect(APP_CSP).toContain(d);
    }
    expect(APP_CSP).not.toContain("'unsafe-eval'");
    expect(APP_CSP).toContain("frame-src 'none'"); // workers may come from blob:, frames never (K-341)
    expect(appHeaders).toMatch(/\/assets\/\*\n {2}Cache-Control: public, max-age=31536000, immutable/);
    expect(readFileSync(join(appOut, "sitemap.xml"), "utf8")).toContain("<loc>https://mudskipper-nisar.pages.dev/lab</loc>");
    // every route the app's code names gets its own page with its own canonical URL, and the app still boots
    const lab = readFileSync(join(appOut, "lab.html"), "utf8");
    expect(lab).toContain('<link rel="canonical" href="https://mudskipper-nisar.pages.dev/lab">');
    expect(lab).toMatch(/<script type="module" crossorigin src="\/assets\//);
    expect(JSON.parse(readFileSync(join(appOut, "site.json"), "utf8")).app_prefixes).toEqual(["/field/"]);
  });
});
