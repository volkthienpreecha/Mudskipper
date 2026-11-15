#!/usr/bin/env node
/**
 * Assemble the Pages build output (platform/.site/, gitignored):
 *
 *   - the app: app/dist when it exists (Volk's build; never edited here), else the placeholder page
 *     (platform/placeholder/, filled in with the live run's numbers);
 *   - the static API bundle under /data/ (scripts/build-bundle.ts);
 *   - `_routes.json`: Functions run only on /api, /api/* and /tiles/*; everything else is static, and with no
 *     top-level 404.html Pages serves index.html for unknown paths (SPA fallback);
 *   - `_headers` for static assets (security headers, CSP for the placeholder, cache policy);
 *   - robots.txt and sitemap.xml.
 *
 *   node scripts/build-site.ts --fixtures                     # sample run
 *   node scripts/build-site.ts --run ../artifacts/r01 [--updated-at now] [--out DIR] [--placeholder]
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { JsonObject } from "../src/contracts.ts";
import { ROUTES } from "../src/app.ts";
import { LIMITS_TEXT } from "../src/limits.ts";
import { buildBundle, type BundleResult } from "./build-bundle.ts";
import { FIXTURE_RUN, PLATFORM_ROOT, REPO_ROOT } from "./lib/run.ts";
import { PRODUCTION_URL } from "./lib/wrangler.ts";

export const DEFAULT_OUT = join(PLATFORM_ROOT, ".site");
const PLACEHOLDER = join(PLATFORM_ROOT, "placeholder");
const APP_DIST = join(REPO_ROOT, "app", "dist");
/** The app's routes (app/src/main.ts navigation), for the sitemap when the app is deployed. */
const APP_ROUTES = ["/", "/lab", "/scarecrow", "/evidence", "/methods"];
/**
 * CSP for Volk's app (app/dist): its own scripts and its MapLibre worker, styles that MapLibre sets inline,
 * the Esri World Imagery basemap tiles, overlay PNGs and data from this API (same origin, or the production
 * origin the app falls back to). Strict hash pinning stays for the placeholder page only.
 */
export const APP_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "worker-src 'self' blob:",
  "child-src blob:",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https://server.arcgisonline.com https://mudskipper-nisar.pages.dev https://*.mudskipper-nisar.pages.dev",
  "font-src 'self'",
  "connect-src 'self' https://mudskipper-nisar.pages.dev https://*.mudskipper-nisar.pages.dev https://server.arcgisonline.com",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");
/** Pages limits (Free plan): 20,000 files per deployment, 25 MiB per file. */
export const MAX_FILES = 20_000;
const MAX_FILE_BYTES = 25 * 1024 * 1024;

export interface SiteOptions {
  runDir: string;
  out?: string;
  updatedAt?: string;
  fixtures?: boolean;
  /** Build the placeholder even if app/dist exists. */
  placeholder?: boolean;
  siteUrl?: string;
  /**
   * Build the app first (`npm run build -w @mudskipper/app`, so app/dist is always fresh) against this API
   * origin (VITE_API_BASE_URL; the app is same-origin with the API, so this is the deployment's own URL).
   */
  appApiBase?: string;
}

export interface SiteResult {
  out: string;
  app: "app/dist" | "placeholder";
  bundle: BundleResult;
  files: number;
  routes: unknown;
}

/** Evidence chips (SPEC evidence rule, T12), styled by placeholder/style.css. */
export const TAG = {
  OBSERVED: '<span class="chip chip-observed" title="Radar measurement">OBSERVED</span>',
  INFERRED: '<span class="chip chip-inferred" title="Our model\'s reading">INFERRED</span>',
  ASSUMED: '<span class="chip chip-assumed" title="A cited parameter or our own setting">ASSUMED</span>',
} as const;

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const cspHash = (s: string) => `'sha256-${createHash("sha256").update(s, "utf8").digest("base64")}'`;

/** The season strip: hero-tile fields (rows) × used passes (columns placed by date), with the data gap. */
export function seasonStrip(b: BundleResult, maxRows = 60): { svg: string; caption: string } {
  const meta = b.docs.meta as JsonObject;
  const states = b.docs.states as unknown as JsonObject & { pass_ids: string[]; field_ids: string[]; states: string[] };
  const story = b.docs.story as unknown as JsonObject & { hero_tile: string };
  const passes = (b.docs.passes as unknown as JsonObject & { passes: { pass_id: string; datetime: string }[] }).passes;
  const when = new Map(passes.map((p) => [p.pass_id, Date.parse(p.datetime)]));
  const season = meta["season"] as { start: string; end: string };
  const gaps = meta["gaps"] as { start: string; end: string }[];
  const t0 = Date.parse(season.start);
  const t1 = Date.parse(season.end) + 86_400_000;
  const W = 960;
  const top = 26;
  const rowH = 6;
  const rows = states.field_ids
    .map((id, i) => ({ id, s: states.states[i]! }))
    .filter((r) => r.id.startsWith(story.hero_tile + "-"))
    .slice(0, maxRows);
  const H = top + rows.length * rowH + 30;
  const x = (t: number) => ((t - t0) / (t1 - t0)) * W;
  const colW = Math.max(6, x(t0 + 12 * 86_400_000) * 0.62);
  const parts: string[] = [];
  parts.push(
    `<defs><pattern id="hz" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">` +
      `<rect width="5" height="5" fill="#16262D"/><rect width="1.6" height="5" fill="#8A8F98"/></pattern>` +
      `<pattern id="gp" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(-45)">` +
      `<rect width="2" height="6" fill="#2C3E46"/></pattern></defs>`,
  );
  for (const g of gaps) {
    const gx = x(Date.parse(g.start));
    const gw = x(Date.parse(g.end)) - gx;
    parts.push(`<rect x="${gx.toFixed(1)}" y="${top - 6}" width="${gw.toFixed(1)}" height="${rows.length * rowH + 12}" fill="url(#gp)"/>`);
    parts.push(`<text x="${(gx + gw / 2).toFixed(1)}" y="14" text-anchor="middle" class="t">no data</text>`);
  }
  states.pass_ids.forEach((pid, j) => {
    const t = when.get(pid);
    if (t === undefined) return;
    const cx = x(t); // a column starts at its pass time, so a pass right after the gap never overlaps it
    rows.forEach((r, i) => {
      const c = r.s[j];
      const fill = c === "F" ? "#3FA7D6" : c === "D" ? "#C98B4E" : c === "U" ? "url(#hz)" : null;
      if (fill) parts.push(`<rect x="${cx.toFixed(1)}" y="${top + i * rowH}" width="${colW.toFixed(1)}" height="${rowH - 1}" fill="${fill}"/>`);
    });
  });
  const months = ["Jul", "Aug", "Sep", "Oct"];
  months.forEach((m, i) => {
    const t = Date.UTC(2026, 6 + i, 1);
    if (t <= t0 || t >= t1) return;
    const mx = x(t).toFixed(1);
    parts.push(`<line x1="${mx}" x2="${mx}" y1="${top + rows.length * rowH + 4}" y2="${top + rows.length * rowH + 10}" stroke="#2C3E46"/>`);
    parts.push(`<text x="${mx}" y="${H - 4}" text-anchor="middle" class="t">${m} 1</text>`);
  });
  const svg =
    `<svg viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="strip-title">` +
    `<title id="strip-title">State of ${rows.length} fields on each of ${states.pass_ids.length} NISAR passes, ${esc(season.start)} to ${esc(season.end)}</title>` +
    `${parts.join("")}</svg>`;
  // Every number carries its evidence tag (T12, contracts/evidence_tags.json): field counts INFERRED (mapped
  // fields), pass counts OBSERVED, season dates ASSUMED (aoi.json configuration).
  const caption =
    `Rows: the first ${rows.length} fields ${TAG.INFERRED} of the ${esc(story.hero_tile)} tile by id. Columns: the ${states.pass_ids.length} used passes ${TAG.OBSERVED}, ` +
    `placed by date across the season (${esc(season.start)} to ${esc(season.end)} ${TAG.ASSUMED}).` + (b.run.fixture ? " SAMPLE DATA." : "");
  return { svg, caption };
}

function markInline(): string {
  return readFileSync(join(PLACEHOLDER, "favicon.svg"), "utf8")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(' role="img" aria-label="Mudskipper mark"', ' aria-hidden="true" focusable="false"')
    .replace(/\n\s*/g, "");
}

function placeholderHtml(b: BundleResult, siteUrl: string): { html: string; csp: string } {
  const story = b.docs.story as unknown as JsonObject & { headline: { text: string; tag: string }; counts: Record<string, number> };
  const meta = b.docs.meta as unknown as JsonObject & { counts: Record<string, number>; tiles: unknown[] };
  const style = readFileSync(join(PLACEHOLDER, "style.css"), "utf8").trim();
  const script = readFileSync(join(PLACEHOLDER, "status.js"), "utf8").trim();
  const strip = seasonStrip(b);
  const headline = esc(story.headline.text).replace(/^(\d+%)/, '<span class="n">$1</span>');
  const endpoints = ROUTES.map((r) => {
    const m = r.methods[0]!;
    const linkable = m === "GET" && !r.path.includes(":") && !r.path.includes("*");
    const example = r.path === "/api/fields/:id" ? `/api/fields/${(b.docs.story as JsonObject)["hero_field_id"]}` : null;
    const path = linkable
      ? `<a href="${r.path}">${r.path}</a>`
      : example
        ? `<a href="${example}">${esc(r.path)}</a>`
        : r.path === "/tiles/*"
          ? `<a href="/tiles/runs/${b.run.run_id}/fields.geojson">/tiles/*</a>`
          : `<span class="p">${esc(r.path)}</span>`;
    return `      <li><span class="m${m === "POST" ? " post" : ""}">${m}</span>${path}<span class="d">${esc(r.description)}</span></li>`;
  }).join("\n");
  const jsonLd = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: "Mudskipper",
    url: `${siteUrl}/`,
    description:
      "Mudskipper uses NASA-ISRO NISAR radar to show, field by field, what space can prove about rice-field drainage, what it can't, and where an inspector should look first.",
    inLanguage: "en",
    license: "https://spdx.org/licenses/GPL-3.0-only.html",
  }).replace(/</g, "\\u003c");
  const values: Record<string, string> = {
    SITE_URL: siteUrl,
    JSON_LD: jsonLd,
    STYLE: style,
    SCRIPT: script,
    MARK: markInline(),
    SAMPLE_BADGE: b.run.fixture ? '<span class="badge" title="Every number on this page comes from the sample fixture run">SAMPLE DATA</span>' : "",
    SAMPLE_NOTE: b.run.fixture ? " · sample data, not results" : "",
    HEADLINE_HTML: headline,
    HEADLINE_TAG: esc(story.headline.tag),
    RUN_ID: esc(b.run.run_id),
    PASSES: String(story.counts["passes"]),
    FIELDS: String(story.counts["fields"]),
    TILES: String(meta.tiles.length),
    TAG_OBSERVED: TAG.OBSERVED,
    TAG_INFERRED: TAG.INFERRED,
    TAG_ASSUMED: TAG.ASSUMED,
    STRIP_SVG: strip.svg,
    STRIP_CAPTION: strip.caption,
    ENDPOINTS: endpoints,
    LIMITS_TEXT: esc(LIMITS_TEXT),
  };
  const template = readFileSync(join(PLACEHOLDER, "index.html"), "utf8");
  const html = template.replace(/\{\{([A-Z_]+)\}\}/g, (_m, k: string) => {
    const v = values[k];
    if (v === undefined) throw new Error(`placeholder/index.html: no value for {{${k}}}`);
    return v;
  });
  const csp = [
    "default-src 'none'",
    `script-src ${cspHash(script)}`,
    `style-src ${cspHash(style)}`,
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "manifest-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
  return { html, csp };
}

function headersFile(b: BundleResult, csp: string | null): string {
  const runCache = b.run.fixture ? "public, max-age=300, stale-while-revalidate=86400" : "public, max-age=31536000, immutable";
  const lines = [
    "# Generated by platform/scripts/build-site.ts. Applies to static assets only (Function responses set their own).",
    "/*",
    "  X-Content-Type-Options: nosniff",
    "  Referrer-Policy: strict-origin-when-cross-origin",
    "  Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=()",
    "  Cross-Origin-Opener-Policy: same-origin",
    `  Content-Security-Policy: ${csp ?? APP_CSP}`,
    "  X-Frame-Options: DENY",
    "",
    "/fonts/*",
    "  Cache-Control: public, max-age=31536000, immutable",
    "",
    "/assets/*",
    "  Cache-Control: public, max-age=31536000, immutable",
    "",
    // The app's photos keep their names across deploys (no content hash), so not immutable: a day fresh, then
    // revalidated in the background for a week, instead of a conditional request on every page view.
    "/img/*",
    "  Cache-Control: public, max-age=86400, stale-while-revalidate=604800",
    "",
    "/og.png",
    "  Cache-Control: public, max-age=86400",
    "",
    "/data/live.json",
    "  Cache-Control: no-cache",
    "",
    `/data/runs/${b.run.run_id}/*`,
    `  Cache-Control: ${runCache}`,
    "  Access-Control-Allow-Origin: *",
    "",
  ];
  return lines.join("\n");
}

/** Link-preview, canonical and icon tags for a built page whose head lacks them (only the missing ones). */
export function withLinkPreview(html: string, siteUrl: string): string {
  const tags = [
    ['rel="canonical"', `<link rel="canonical" href="${siteUrl}/">`],
    ['rel="apple-touch-icon"', '<link rel="apple-touch-icon" href="/apple-touch-icon.png">'],
    ['property="og:type"', '<meta property="og:type" content="website">'],
    ['property="og:site_name"', '<meta property="og:site_name" content="Mudskipper">'],
    ['property="og:title"', '<meta property="og:title" content="Mudskipper: proof, not paperwork">'],
    ['property="og:description"', `<meta property="og:description" content="Was this rice field really drained? NASA-ISRO NISAR radar, field by field, for Punjab's 2026 rice season.">`],
    ['property="og:url"', `<meta property="og:url" content="${siteUrl}/">`],
    ['property="og:image"', `<meta property="og:image" content="${siteUrl}/og.png">`],
    ['property="og:image:width"', '<meta property="og:image:width" content="1200">'],
    ['property="og:image:height"', '<meta property="og:image:height" content="630">'],
    ['property="og:image:alt"', '<meta property="og:image:alt" content="Mudskipper: Was this rice field really drained? The wordmark beside a decorative pattern of water and mud squares (an illustration, not data).">'],
    ['name="twitter:card"', '<meta name="twitter:card" content="summary_large_image">'],
    ['name="twitter:image"', `<meta name="twitter:image" content="${siteUrl}/og.png">`],
  ].filter(([probe]) => !html.includes(probe!));
  if (!tags.length) return html;
  if (!html.includes("</head>")) throw new Error("app/dist/index.html has no </head>");
  return html.replace("</head>", tags.map(([, t]) => `    ${t}\n`).join("") + "  </head>");
}

/**
 * Put app/dist into the site directory `out` (replacing an earlier copy of the app, never touching /data):
 * the app's files, plus the link-preview and canonical tags its head lacks and the share image, so a shared
 * link shows a card (app/ sources are Volk's and untouched). publish.ts calls it again after rebuilding the
 * app for the production origin, so production gets exactly the page assembly the preview was smoked with.
 */
export function installApp(out: string, siteUrl: string): void {
  if (existsSync(join(APP_DIST, "data"))) throw new Error("app/dist contains /data, which is reserved for the API bundle");
  if (existsSync(join(APP_DIST, "404.html"))) console.warn("warning: app/dist has a top-level 404.html, which turns off Pages' SPA fallback");
  rmSync(join(out, "assets"), { recursive: true, force: true });
  cpSync(APP_DIST, out, { recursive: true });
  const indexPath = join(out, "index.html");
  writeFileSync(indexPath, withLinkPreview(readFileSync(indexPath, "utf8"), siteUrl));
  for (const f of ["og.png", "favicon-48.png", "apple-touch-icon.png"]) if (!existsSync(join(out, f))) cpSync(join(PLACEHOLDER, f), join(out, f));
}

/** `npm run build -w @mudskipper/app` with the API origin baked in (never edits app/ sources). */
export function buildApp(apiBase: string): void {
  const res = spawnSync("npm", ["run", "build", "-w", "@mudskipper/app"], {
    cwd: REPO_ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    env: { ...process.env, VITE_API_BASE_URL: apiBase.replace(/\/$/, "") },
  });
  if (res.status !== 0) throw new Error(`app build failed (exit ${res.status}):\n${res.stdout}\n${res.stderr}`);
}

export function countFiles(dir: string): { files: number; largest: [string, number] } {
  let files = 0;
  let largest: [string, number] = ["", 0];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else {
        files++;
        if (st.size > largest[1]) largest = [p, st.size];
      }
    }
  };
  walk(dir);
  return { files, largest };
}

export function buildSite(opts: SiteOptions): SiteResult {
  const out = resolve(opts.out ?? DEFAULT_OUT);
  const siteUrl = opts.siteUrl ?? PRODUCTION_URL;
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });

  if (!opts.placeholder && opts.appApiBase && existsSync(join(REPO_ROOT, "app", "package.json"))) buildApp(opts.appApiBase);
  const useApp = !opts.placeholder && existsSync(join(APP_DIST, "index.html"));
  if (useApp) installApp(out, siteUrl);

  const bundle = buildBundle(opts.runDir, {
    out: join(out, "data"),
    fixtureLive: opts.fixtures === true,
    ...(opts.updatedAt ? { updatedAt: opts.updatedAt } : {}),
  });

  let csp: string | null = null;
  if (!useApp) {
    const page = placeholderHtml(bundle, siteUrl);
    csp = page.csp;
    writeFileSync(join(out, "index.html"), page.html);
    cpSync(join(PLACEHOLDER, "fonts"), join(out, "fonts"), { recursive: true });
    for (const f of ["favicon.svg", "favicon-48.png", "apple-touch-icon.png", "og.png"]) cpSync(join(PLACEHOLDER, f), join(out, f));
  }

  const routes = { version: 1, include: ["/api", "/api/*", "/tiles/*"], exclude: [] as string[] };
  writeFileSync(join(out, "_routes.json"), JSON.stringify(routes, null, 2) + "\n");

  const ours = headersFile(bundle, csp);
  const existing = existsSync(join(out, "_headers")) ? readFileSync(join(out, "_headers"), "utf8").trimEnd() + "\n\n" : "";
  writeFileSync(join(out, "_headers"), existing + ours);

  const pages = useApp ? APP_ROUTES : ["/"];
  writeFileSync(
    join(out, "robots.txt"),
    ["User-agent: *", "Allow: /", "Disallow: /api/", "Disallow: /tiles/", "Disallow: /data/", "", `Sitemap: ${siteUrl}/sitemap.xml`, ""].join("\n"),
  );
  writeFileSync(
    join(out, "sitemap.xml"),
    '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
      pages.map((p) => `  <url><loc>${siteUrl}${p}</loc></url>`).join("\n") +
      "\n</urlset>\n",
  );

  const { files, largest } = countFiles(out);
  if (files > MAX_FILES) throw new Error(`${files} files exceeds the Pages limit of ${MAX_FILES}`);
  if (largest[1] > MAX_FILE_BYTES) throw new Error(`${largest[0]} is ${largest[1]} bytes, over the Pages 25 MiB limit`);
  return { out, app: useApp ? "app/dist" : "placeholder", bundle, files, routes };
}

function main() {
  const { values } = parseArgs({
    options: {
      fixtures: { type: "boolean", default: false },
      run: { type: "string" },
      out: { type: "string" },
      "updated-at": { type: "string" },
      placeholder: { type: "boolean", default: false },
      "app-base": { type: "string", default: PRODUCTION_URL },
      "no-app-build": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help || (!values.fixtures && !values.run)) {
    console.log(
      "usage: node scripts/build-site.ts (--fixtures | --run DIR) [--out DIR] [--updated-at ISO|now] [--placeholder]\n" +
        "       [--app-base URL (API origin baked into the app; default production)] [--no-app-build]",
    );
    process.exit(values.help ? 0 : 2);
  }
  const updatedAt = values["updated-at"] === "now" ? new Date().toISOString().slice(0, 19) + "Z" : values["updated-at"];
  const r = buildSite({
    runDir: values.fixtures ? FIXTURE_RUN : resolve(values.run!),
    fixtures: values.fixtures,
    placeholder: values.placeholder,
    ...(values["no-app-build"] ? {} : { appApiBase: values["app-base"] }),
    ...(values.out ? { out: values.out } : {}),
    ...(updatedAt ? { updatedAt } : {}),
  });
  console.log(`site → ${r.out}: ${r.app} + /data bundle for ${r.bundle.run.run_id}, ${r.files} files; _routes.json include ${JSON.stringify((r.routes as { include: string[] }).include)}`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
