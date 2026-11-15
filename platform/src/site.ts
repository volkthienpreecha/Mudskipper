/**
 * The site middleware (functions/_middleware.ts, DECISIONS.md K-321, K-323): runs in front of the static pages,
 * never in front of /assets, /fonts, /data or other static files (`_routes.json` excludes them), and does three
 * small things without parsing any page:
 *
 * 1. Markdown negotiation: a request that prefers `text/markdown` gets the page's build-time Markdown
 *    (`/about` → `/about.md`, `/` → `/index.md`) with `Content-Type: text/markdown; charset=utf-8`.
 * 2. Real 404s: the site ships a top-level 404.html, so Pages answers unknown paths with 404 (no SPA fallback);
 *    a Markdown-preferring client gets `/404.md` with the same 404. The app's dynamic routes (`/field/<id>`,
 *    listed in /site.json by the build) still get the app shell with 200.
 * 3. `Vary: Accept` on every page response, because the body depends on Accept.
 *
 * /api and /tiles pass straight through to the Hono app. CPU: one header parse and at most two asset fetches.
 */

export const MARKDOWN_TYPE = "text/markdown; charset=utf-8";
/** Built by scripts/build-site.ts: which paths have Markdown and which prefixes are app routes. */
export const SITE_MANIFEST = "/site.json";

export interface SiteManifest {
  /** Page paths with a Markdown twin, e.g. "/", "/about". */
  markdown: string[];
  /** Client-side app routes answered with the app shell, e.g. "/field/". */
  app_prefixes: string[];
}

interface Assets {
  fetch(input: string | Request | URL, init?: RequestInit): Promise<Response>;
}

/** Content types the static server cannot know from the file name. */
const TYPE_FIX: Record<string, string> = {
  "/.well-known/api-catalog": 'application/linkset+json; profile="https://www.rfc-editor.org/info/rfc9727"; charset=utf-8',
  "/openapi.yaml": "application/yaml; charset=utf-8",
};

/** Homepage Link header (RFC 8288; RFC 9727 asks for rel="api-catalog" on the site's root). */
export const HOME_LINKS = [
  '</.well-known/api-catalog>; rel="api-catalog"',
  '</openapi.json>; rel="service-desc"; type="application/vnd.oai.openapi+json"',
  '</developers>; rel="service-doc"; type="text/html"',
  '</llms.txt>; rel="describedby"; type="text/plain"',
  '</index.md>; rel="alternate"; type="text/markdown"',
].join(", ");

function q(params: string[]): number {
  for (const p of params) {
    const m = /^\s*q\s*=\s*([0-9.]+)\s*$/i.exec(p);
    if (m) return Math.max(0, Math.min(1, Number(m[1])));
  }
  return 1;
}

/**
 * True when the client prefers Markdown to HTML: `text/markdown` (or `text/x-markdown`) has q > 0 and a q at
 * least that of `text/html`; on a tie the one listed first wins. Browsers never list Markdown, so they keep
 * getting HTML; `*\/*` alone means HTML.
 */
export function prefersMarkdown(accept: string | null): boolean {
  if (!accept) return false;
  let md = 0;
  let html = 0;
  let mdAt = Infinity;
  let htmlAt = Infinity;
  accept.split(",").forEach((range, i) => {
    const [type = "", ...params] = range.split(";");
    const t = type.trim().toLowerCase();
    const w = q(params);
    if (t === "text/markdown" || t === "text/x-markdown") {
      if (w > md) [md, mdAt] = [w, i];
    } else if (t === "text/html" || t === "application/xhtml+xml") {
      if (w > html) [html, htmlAt] = [w, i];
    }
  });
  return md > 0 && (md > html || (md === html && mdAt < htmlAt));
}

/** The page a path names: "/" → "/", "/about/" → "/about", "/about.html" → "/about"; null for files. */
export function pagePath(path: string): string | null {
  if (path === "/" || path === "/index.html") return "/";
  const p = path.replace(/\/+$/, "").replace(/\.html$/, "");
  return /^\/[a-z0-9][a-z0-9_-]*(\/[a-z0-9][a-z0-9_-]*)*$/.test(p) ? p : null;
}

export const markdownAsset = (page: string) => (page === "/" ? "/index.md" : `${page}.md`);

let manifest: Promise<SiteManifest> | null = null;

/** The build's site manifest, read once per isolate (an empty one if it is missing). */
function siteManifest(assets: Assets, origin: string): Promise<SiteManifest> {
  manifest ??= assets
    .fetch(new URL(SITE_MANIFEST, origin))
    .then((r) => (r.ok ? (r.json() as Promise<SiteManifest>) : { markdown: [], app_prefixes: [] }))
    .catch(() => ({ markdown: [], app_prefixes: [] }));
  return manifest;
}

export function clearSiteCache(): void {
  manifest = null;
}

function withHeaders(res: Response, set: Record<string, string>, status = res.status): Response {
  const out = new Response(res.body, { status, statusText: status === res.status ? res.statusText : "", headers: res.headers });
  for (const [k, v] of Object.entries(set)) out.headers.set(k, v);
  const vary = out.headers.get("vary");
  if (!vary || !/\baccept\b/i.test(vary)) out.headers.set("vary", vary ? `${vary}, Accept` : "Accept");
  return out;
}

async function asset(assets: Assets, req: Request, path: string): Promise<Response> {
  const h = new Headers();
  for (const k of ["if-none-match", "if-modified-since"]) {
    const v = req.headers.get(k);
    if (v) h.set(k, v);
  }
  return assets.fetch(new Request(new URL(path, req.url), { method: req.method === "HEAD" ? "HEAD" : "GET", headers: h }));
}

export async function handleSite(req: Request, env: { ASSETS: Assets }, next: () => Promise<Response>): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  if (path === "/api" || path.startsWith("/api/") || path.startsWith("/tiles/")) return next();
  if (req.method !== "GET" && req.method !== "HEAD") return next();

  const fix = TYPE_FIX[path];
  if (fix) {
    const res = await next();
    return res.ok ? withHeaders(res, { "content-type": fix }) : res;
  }
  if (path.endsWith(".md")) {
    const res = await next();
    return res.ok ? withHeaders(res, { "content-type": MARKDOWN_TYPE }) : res;
  }

  const page = pagePath(path);
  const md = prefersMarkdown(req.headers.get("accept"));
  const links: Record<string, string> = page === "/" ? { link: HOME_LINKS } : {};
  if (md && page) {
    const site = await siteManifest(env.ASSETS, url.origin);
    if (site.markdown.includes(page)) {
      const res = await asset(env.ASSETS, req, markdownAsset(page));
      if (res.status === 200 || res.status === 304) return withHeaders(res, { "content-type": MARKDOWN_TYPE, ...links });
    }
  }

  const res = await next();
  if (res.status !== 404) return withHeaders(res, links);

  const site = await siteManifest(env.ASSETS, url.origin);
  if (site.app_prefixes.some((p) => path.startsWith(p) && path.length > p.length)) {
    await res.body?.cancel();
    const shell = await asset(env.ASSETS, req, md ? "/index.md" : "/");
    if (shell.ok) return withHeaders(shell, md ? { "content-type": MARKDOWN_TYPE } : {}, 200);
    return withHeaders(shell, {});
  }
  if (md) {
    const body = await asset(env.ASSETS, req, "/404.md");
    if (body.ok) {
      await res.body?.cancel();
      return withHeaders(body, { "content-type": MARKDOWN_TYPE, "cache-control": "no-store" }, 404);
    }
  }
  return withHeaders(res, {});
}
