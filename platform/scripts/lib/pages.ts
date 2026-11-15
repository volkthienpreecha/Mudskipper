/**
 * Build-time pages for people without JavaScript and for AI agents (DECISIONS.md K-321 to K-327), written into
 * the site directory after the frontend (app/dist or the placeholder) is in place, without touching app/ sources:
 *
 *   - one HTML file per app route (/lab, /evidence, …): the app's own index.html with the route's title,
 *     canonical URL and, when the app's raw HTML has no real content (an empty mount node), the route's
 *     prerendered content inside the mount node, which the app replaces when it starts;
 *   - static pages /about, /contact, /privacy, /developers and a top-level 404.html (which turns off Pages'
 *     SPA fallback, so unknown paths are real 404s);
 *   - a Markdown twin of every page (index.md, about.md, …, 404.md), served by functions/_middleware.ts for
 *     `Accept: text/markdown`;
 *   - openapi.json / openapi.yaml, llms.txt, llms-full.txt, /.well-known/api-catalog, site.json (the
 *     middleware's manifest), sitemap.xml and robots.txt.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { BundleResult } from "../build-bundle.ts";
import { MARKDOWN_TYPE, SITE_MANIFEST, markdownAsset, type SiteManifest } from "../../src/site.ts";
import { APP_ROUTE_INFO, jsonLd, llmsFullTxt, llmsTxt, sitePages, type SiteContext, type SitePages } from "./content.ts";
import { checkHeadings, escHtml, textLength, toHtml, toMarkdown, type Page } from "./doc.ts";
import { buildOpenApi, toYaml } from "./openapi.ts";

/** Candidate client-side routes; a route is served only if the built app's code names it (K-321). */
const ROUTE_CANDIDATES = Object.keys(APP_ROUTE_INFO);
const PREFIX_CANDIDATES = ["/field/"];

/**
 * One stylesheet for every generated page and for the prerendered block: the app's palette (deep teal-black,
 * paper ink, water and mud accents), system type, WCAG AA contrast (ink 13.9:1, dim 7.6:1, links 8.4:1 on bg).
 * Scoped to `.ms` so it never touches the app's own styles.
 */
export const PAGE_CSS = [
  ":root{color-scheme:dark}",
  "body.ms{margin:0;background:#0E1A1F}",
  ".ms{--bg:#0E1A1F;--bg2:#16262D;--line:#2C3E46;--ink:#EAE6DA;--dim:#A9B8B1;--link:#7FD3EE;--water:#3FD0C9;--mud:#E2725B;--violet:#B7ABFF;background:var(--bg);color:var(--ink);font:1.0625rem/1.65 -apple-system,BlinkMacSystemFont,system-ui,\"Segoe UI\",Roboto,sans-serif;-webkit-font-smoothing:antialiased;min-height:100vh}",
  ".ms *{box-sizing:border-box}",
  ".ms a{color:var(--link);text-underline-offset:3px}",
  ".ms a:focus-visible{outline:2px solid var(--water);outline-offset:3px;border-radius:2px}",
  ".ms .skip{position:absolute;left:-999px}.ms .skip:focus{left:16px;top:12px;background:var(--bg2);padding:8px 12px;z-index:10}",
  ".ms .top{display:flex;flex-wrap:wrap;gap:12px 28px;align-items:center;justify-content:space-between;max-width:960px;margin:0 auto;padding:20px 24px;border-bottom:1px solid var(--line)}",
  ".ms .brand{display:inline-flex;align-items:center;gap:10px;color:var(--ink);text-decoration:none;font-weight:600;letter-spacing:-.01em;min-height:44px}",
  ".ms .brand i{width:10px;height:10px;border-radius:2px;background:var(--water);box-shadow:12px 0 0 var(--mud);margin-right:12px}",
  ".ms .top nav{display:flex;flex-wrap:wrap;gap:4px 20px;font-size:.9375rem}",
  ".ms .top nav a{color:var(--dim);text-decoration:none;display:inline-flex;align-items:center;min-height:44px}",
  ".ms .top nav a:hover,.ms .top nav a[aria-current=page]{color:var(--ink)}",
  ".ms main{max-width:760px;margin:0 auto;padding:56px 24px 72px}",
  ".ms h1{font-size:clamp(2rem,5vw,3rem);line-height:1.12;letter-spacing:-.02em;margin:0 0 20px;font-weight:650;overflow-wrap:anywhere}",
  ".ms h2{font-size:1.3rem;line-height:1.3;margin:44px 0 10px;font-weight:620}",
  ".ms h3{font-size:1.05rem;margin:28px 0 8px}",
  ".ms p,.ms li{color:#D3D7CE;overflow-wrap:anywhere}",
  ".ms ul,.ms ol{padding-left:22px}.ms li{margin:6px 0}",
  ".ms code{font:.9em ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;background:var(--bg2);border:1px solid var(--line);border-radius:5px;padding:1px 5px}",
  ".ms pre{background:var(--bg2);border:1px solid var(--line);border-radius:10px;padding:14px 16px;overflow-x:auto;line-height:1.5}",
  ".ms pre code{background:none;border:0;padding:0;font-size:.875rem;white-space:pre}",
  ".ms .note{border-left:3px solid var(--mud);background:var(--bg2);padding:12px 16px;border-radius:0 10px 10px 0}",
  ".ms .table{overflow-x:auto;margin:12px 0}.ms table{border-collapse:collapse;width:100%;font-size:.9375rem}",
  ".ms th,.ms td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);vertical-align:top}.ms th{color:var(--ink);font-weight:600}",
  ".ms .tag{display:inline-block;font:600 .68rem/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.06em;border:1px solid currentColor;border-radius:4px;padding:0 5px;vertical-align:.12em}",
  ".ms .tag-observed{color:var(--water)}.ms .tag-inferred{color:var(--violet)}.ms .tag-assumed{color:#F0A08F}",
  ".ms .foot{max-width:960px;margin:0 auto;padding:24px 24px 48px;border-top:1px solid var(--line);color:var(--dim);font-size:.875rem}",
  ".ms .foot a{color:var(--dim)}.ms .foot nav{display:flex;flex-wrap:wrap;gap:4px 18px;margin-bottom:8px}",
  ".ms .foot nav a{display:inline-flex;align-items:center;min-height:32px}",
].join("\n");

/** CSP source for PAGE_CSS as a <style> body (added to the placeholder's hash-pinned style-src). */
export const PAGE_CSS_HASH = `'sha256-${createHash("sha256").update(PAGE_CSS, "utf8").digest("base64")}'`;

const NAV: [string, string][] = [
  ["/", "App"],
  ["/developers", "Developers"],
  ["/about", "About"],
  ["/contact", "Contact"],
  ["/privacy", "Privacy"],
];

const DEV_LINKS: [string, string][] = [
  ["/developers", "API docs"],
  ["/openapi.json", "OpenAPI"],
  ["/llms.txt", "llms.txt"],
  ["/api", "API index"],
  ["/about", "About"],
  ["/contact", "Contact"],
  ["/privacy", "Privacy"],
];

function header(current: string): string {
  const links = NAV.map(([href, label]) => `<a href="${href}"${href === current ? ' aria-current="page"' : ""}>${label}</a>`).join("");
  return `<header class="top"><a class="brand" href="/"><i aria-hidden="true"></i>Mudskipper</a><nav aria-label="Site">${links}</nav></header>`;
}

function footer(ctx: SiteContext): string {
  const links = [...DEV_LINKS, ["/sitemap.xml", "Sitemap"], ...ctx.extraPages.map((p) => [p, p === "/terms" ? "Terms" : p === "/credits" ? "Credits" : p.slice(1)])]
    .map(([h, l]) => `<a href="${h}">${l}</a>`)
    .join("");
  return `<footer class="foot"><nav aria-label="For developers and AI agents">${links}</nav><p>A NASA Space Apps Challenge 2026 project. Code under GPL-3.0-only. Radar: NISAR L2 GCOV (NASA-ISRO) via the Alaska Satellite Facility DAAC.</p></footer>`;
}

const fullTitle = (p: Page) => (/Mudskipper/.test(p.title) ? p.title : `${p.title} · Mudskipper`);
const pageUrl = (ctx: SiteContext, path: string) => `${ctx.siteUrl}${path === "/" ? "/" : path}`;

function headExtras(page: Page): string {
  return [
    '<meta name="is-agentic-site-type" content="app">',
    '<link rel="service-desc" type="application/vnd.oai.openapi+json" href="/openapi.json">',
    '<link rel="service-doc" type="text/html" href="/developers">',
    '<link rel="api-catalog" href="/.well-known/api-catalog">',
    `<link rel="alternate" type="text/markdown" href="${markdownAsset(page.path)}" title="${escHtml(fullTitle(page))} (Markdown)">`,
    '<link rel="alternate" type="text/plain" href="/llms.txt" title="llms.txt">',
  ]
    .map((t) => `    ${t}\n`)
    .join("");
}

/** A complete static page (about, contact, privacy, developers, 404). */
export function staticPageHtml(ctx: SiteContext, page: Page): string {
  const canonical = page.path === "/404" ? "" : `<link rel="canonical" href="${pageUrl(ctx, page.path)}">\n`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escHtml(fullTitle(page))}</title>
<meta name="description" content="${escHtml(page.description)}">
<meta name="theme-color" content="#0E1A1F">
${page.path === "/404" ? '<meta name="robots" content="noindex">\n' : ""}${canonical}<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Mudskipper">
<meta property="og:title" content="${escHtml(fullTitle(page))}">
<meta property="og:description" content="${escHtml(page.description)}">
<meta property="og:image" content="${ctx.siteUrl}/og.png">
${headExtras(page)}<style>${PAGE_CSS}</style>
</head>
<body class="ms">
<a class="skip" href="#main">Skip to content</a>
${header(page.path)}
<main id="main">
${toHtml(page)}
</main>
${footer(ctx)}
</body>
</html>
`;
}

/** Visible text of an HTML document without scripts, styles and markup (what a crawler without JS reads). */
export function visibleText(html: string): string {
  return html
    .replace(/<head[\s\S]*?<\/head>/i, " ")
    .replace(/<(script|style|svg|noscript|template)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z#0-9]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** True if a built page already has real content in its raw HTML (an h1 and 500+ characters). */
export function hasRawContent(html: string): boolean {
  return /<h1[\s>]/i.test(html.replace(/<(script|template)\b[\s\S]*?<\/\1>/gi, "")) && visibleText(html).length >= 500;
}

const MOUNT = /<div id="app">\s*<\/div>/;
const PRERENDER_STYLE =
  `<style>${PAGE_CSS}\n.ms-prerender{display:none}.ms-prerender .top{background:var(--bg)!important;position:static!important}.ms-prerender .brand,.ms-prerender h1,.ms-prerender h2{color:var(--ink)!important}</style>\n` +
  `    <noscript><style>.ms-prerender{display:block}body{background:#0E1A1F!important;margin:0}</style></noscript>`;

/**
 * The app's index.html, made into `page`: its title, description and canonical URL, the agent links in <head>,
 * JSON-LD on the homepage, and either the prerendered content in the mount node (hidden while JavaScript runs
 * the app, shown without it) or, when the app already has its own content, a links row in its footer (a div
 * with role="navigation", because app styles may target every <nav>: the current app's is a fixed top bar).
 */
export function appPageHtml(ctx: SiteContext, template: string, page: Page, ld: string | null): string {
  let html = template;
  const title = escHtml(fullTitle(page));
  html = html.replace(/<title>[\s\S]*?<\/title>/, `<title>${title}</title>`);
  const desc = `<meta name="description" content="${escHtml(page.description)}">`;
  html = /<meta\s+name="description"[^>]*>/.test(html) ? html.replace(/<meta\s+name="description"[^>]*>/, desc) : html.replace("</title>", `</title>\n    ${desc}`);
  html = html.replace(/<link rel="canonical" href="[^"]*">/, `<link rel="canonical" href="${pageUrl(ctx, page.path)}">`);
  html = html.replace(/<meta property="og:url" content="[^"]*">/, `<meta property="og:url" content="${pageUrl(ctx, page.path)}">`);
  html = html.replace(/<meta property="og:title" content="[^"]*">/, `<meta property="og:title" content="${title}">`);
  let head = headExtras(page);
  if (ld) head += `    <script type="application/ld+json">${ld}</script>\n`;

  if (!hasRawContent(template)) {
    const block = `<div class="ms ms-prerender">${header(page.path)}<main id="prerender-main">\n${toHtml(page)}\n</main>${footer(ctx)}</div>`;
    head += `    ${PRERENDER_STYLE}\n`;
    html = MOUNT.test(html) ? html.replace(MOUNT, `<div id="app">${block}</div>`) : html.replace(/<body([^>]*)>/, `<body$1>\n${block}`);
  } else {
    const links = DEV_LINKS.map(([h, l]) => `<a href="${h}">${l}</a>`).join("");
    if (html.includes('<div class="foot-meta"')) {
      html = html.replace('<div class="foot-meta"', `<div class="foot-col" role="navigation" aria-label="For developers and AI agents" style="grid-column:1/-1;flex-direction:row;flex-wrap:wrap;gap:0 24px;align-items:center"><b style="margin:0 8px 0 0">Developers and agents</b>${links}</div>\n  <div class="foot-meta"`);
    } else if (html.includes("</footer>")) {
      html = html.replace("</footer>", `<div role="navigation" aria-label="For developers and AI agents">${links}</div></footer>`);
    } else {
      html = html.replace("</body>", `<div role="navigation" aria-label="For developers and AI agents">${links}</div>\n</body>`);
    }
  }
  if (!html.includes("</head>")) throw new Error("app index.html has no </head>");
  return html.replace("</head>", `${head}  </head>`);
}

/** Client-side routes the built app's JavaScript names (K-321): only those get their own HTML file. */
export function detectAppRoutes(out: string): { routes: string[]; prefixes: string[] } {
  const dir = join(out, "assets");
  if (!existsSync(dir)) return { routes: [], prefixes: [] };
  const js = readdirSync(dir)
    .filter((f) => f.endsWith(".js"))
    .map((f) => readFileSync(join(dir, f), "utf8"))
    .join("\n");
  const named = (p: string) => new RegExp(`["'\`]${p.replace(/\//g, "\\/")}["'\`]`).test(js);
  return { routes: ROUTE_CANDIDATES.filter(named), prefixes: PREFIX_CANDIDATES.filter(named) };
}

function write(out: string, rel: string, body: string): void {
  const p = join(out, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, body);
}

export interface AgentSiteOptions {
  siteUrl: string;
  bundle: BundleResult;
  app: "app" | "placeholder";
}

export interface AgentSiteResult {
  ctx: SiteContext;
  pages: SitePages;
  /** Extra `_headers` rules for the generated files. */
  headers: string;
  /** Every page path the sitemap lists. */
  sitemap: string[];
}

/**
 * _routes.json for the site in `out` (call it once every file is written): Functions on every path except the
 * top-level files and directories that never need the middleware (no page, no Markdown twin, no type fix).
 */
export function siteRoutes(out: string): { version: 1; include: string[]; exclude: string[] } {
  const exclude = staticExcludes(out);
  if (1 + exclude.length > 100) throw new Error(`_routes.json would have ${1 + exclude.length} rules (Pages allows 100)`);
  return { version: 1, include: ["/*"], exclude };
}

function staticExcludes(out: string): string[] {
  const ex: string[] = [];
  for (const name of readdirSync(out).sort()) {
    if (name.startsWith("_") || name === ".well-known") continue;
    const st = statSync(join(out, name));
    if (st.isDirectory()) ex.push(`/${name}/*`);
    else if (/\.[A-Za-z0-9]+$/.test(name) && !/\.(html|md|yaml)$/.test(name)) ex.push(`/${name}`);
  }
  return ex;
}

/** Write every agent-facing file into `out` (the app or placeholder index.html must already be there). */
export function writeAgentSite(out: string, opts: AgentSiteOptions): AgentSiteResult {
  const { bundle: b, siteUrl } = opts;
  const detected = opts.app === "app" ? detectAppRoutes(out) : { routes: [], prefixes: [] };
  const extraPages = ["terms", "credits"].filter((n) => existsSync(join(out, `${n}.html`))).map((n) => `/${n}`);
  const ctx: SiteContext = { siteUrl, bundle: b, appRoutes: detected.routes, appPrefixes: detected.prefixes, app: opts.app, extraPages };
  const pages = sitePages(ctx);
  const all = [pages.home, ...pages.routes, ...pages.statics, pages.notFound];
  for (const p of all) {
    checkHeadings(p);
    if (p.path !== "/404" && textLength(p) < 500) throw new Error(`${p.path}: only ${textLength(p)} characters of text (needs 500)`);
  }
  const ld = JSON.stringify(jsonLd(ctx)).replace(/</g, "\\u003c");

  // Pages: the app's routes from its own index.html; the placeholder keeps its index (with the agent links).
  const indexPath = join(out, "index.html");
  const template = readFileSync(indexPath, "utf8");
  if (opts.app === "app") {
    for (const p of pages.routes) write(out, `${p.path.slice(1)}.html`, appPageHtml(ctx, template, p, null));
    writeFileSync(indexPath, appPageHtml(ctx, template, pages.home, ld));
  } else {
    let html = template.replace("</head>", `${headExtras(pages.home)}</head>`);
    const links = DEV_LINKS.map(([h, l]) => `<a href="${h}">${l}</a>`).join(" · ");
    html = html.replace("</footer>", `  <nav class="devlinks" aria-label="For developers and AI agents"><p>${links}</p></nav>\n</footer>`);
    writeFileSync(indexPath, html);
  }
  for (const p of pages.statics) write(out, `${p.path.slice(1)}.html`, staticPageHtml(ctx, p));
  write(out, "404.html", staticPageHtml(ctx, pages.notFound));

  // Markdown twins, and the middleware's manifest.
  for (const p of all) write(out, markdownAsset(p.path).slice(1), toMarkdown(p, siteUrl));
  const manifest: SiteManifest = { markdown: [pages.home, ...pages.routes, ...pages.statics].map((p) => p.path), app_prefixes: detected.prefixes };
  write(out, SITE_MANIFEST.slice(1), JSON.stringify(manifest, null, 2) + "\n");

  // Machine-readable descriptions.
  const story = b.docs.story as { hero_field_id?: string } | null;
  const spec = buildOpenApi({ siteUrl, exampleRunId: b.run.run_id, exampleFieldId: story?.hero_field_id ?? b.docs.fieldRows[0]?.field_id ?? null, terms: extraPages.includes("/terms") });
  write(out, "openapi.json", JSON.stringify(spec, null, 2) + "\n");
  write(out, "openapi.yaml", "# Mudskipper API, OpenAPI 3.1. Generated by platform/scripts/build-site.ts from contracts/schemas.\n" + toYaml(spec as never) + "\n");
  write(out, "llms.txt", llmsTxt(ctx, pages));
  write(out, "llms-full.txt", llmsFullTxt(ctx, pages));
  write(
    out,
    ".well-known/api-catalog",
    JSON.stringify(
      {
        linkset: [
          {
            anchor: `${siteUrl}/api`,
            "service-desc": [
              { href: `${siteUrl}/openapi.json`, type: "application/vnd.oai.openapi+json" },
              { href: `${siteUrl}/openapi.yaml`, type: "application/vnd.oai.openapi" },
            ],
            "service-doc": [{ href: `${siteUrl}/developers`, type: "text/html" }],
            "service-meta": [{ href: `${siteUrl}/llms.txt`, type: "text/plain" }],
            status: [{ href: `${siteUrl}/api/health`, type: "application/json" }],
          },
        ],
      },
      null,
      2,
    ) + "\n",
  );

  const sitemap = [pages.home, ...pages.routes, ...pages.statics].map((p) => p.path).concat(extraPages);
  const headers = [
    "/openapi.json",
    "  Access-Control-Allow-Origin: *",
    "  Cache-Control: public, max-age=300",
    "",
    "/openapi.yaml",
    "  Access-Control-Allow-Origin: *",
    "  Cache-Control: public, max-age=300",
    "",
    "/llms.txt",
    "  Access-Control-Allow-Origin: *",
    "  Cache-Control: public, max-age=300",
    "",
    "/llms-full.txt",
    "  Access-Control-Allow-Origin: *",
    "  Cache-Control: public, max-age=300",
    "",
    "/.well-known/*",
    "  Access-Control-Allow-Origin: *",
    "  Cache-Control: public, max-age=3600",
    "",
    "/*.md",
    `  Content-Type: ${MARKDOWN_TYPE}`,
    "",
  ].join("\n");
  return { ctx, pages, headers, sitemap };
}
