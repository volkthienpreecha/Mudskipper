// The page middleware (src/site.ts, functions/_middleware.ts) inside workerd, against a Pages-like asset server
// with a top-level 404.html (so unknown paths are real 404s, as on the deployed site).
import { beforeEach, describe, expect, it } from "vitest";
import { HOME_LINKS, MARKDOWN_TYPE, clearSiteCache, handleSite, markdownAsset, pagePath, prefersMarkdown } from "../../src/site.ts";

const FILES: Record<string, [string, string]> = {
  "/": ["text/html; charset=utf-8", "<!doctype html><h1>home</h1>"],
  "/lab": ["text/html; charset=utf-8", "<!doctype html><h1>lab</h1>"],
  "/about": ["text/html; charset=utf-8", "<!doctype html><h1>about</h1>"],
  "/index.md": ["application/octet-stream", "# home\n"],
  "/lab.md": ["application/octet-stream", "# lab\n"],
  "/about.md": ["application/octet-stream", "# about\n"],
  "/404.md": ["application/octet-stream", "# Page not found\n\nThere is no page at this address on Mudskipper (HTTP 404).\n"],
  "/openapi.yaml": ["application/octet-stream", "openapi: 3.1.0\n"],
  "/.well-known/api-catalog": ["application/octet-stream", '{"linkset":[]}'],
  "/site.json": ["application/json", JSON.stringify({ markdown: ["/", "/lab", "/about"], app_prefixes: ["/field/"] })],
};

/** Pages' static asset server: exact files with a 200, `/x.html` → 308 /x, anything else 404.html with a 404. */
const assets = {
  fetches: [] as string[],
  async fetch(input: string | Request | URL): Promise<Response> {
    const url = new URL(input instanceof Request ? input.url : String(input));
    assets.fetches.push(url.pathname);
    if (url.pathname.endsWith(".html")) return new Response(null, { status: 308, headers: { location: url.pathname.slice(0, -5) } });
    const f = FILES[url.pathname];
    if (f) return new Response(f[1], { headers: { "content-type": f[0], etag: `"${url.pathname}"` } });
    return new Response("<!doctype html><h1>Page not found</h1>", { status: 404, headers: { "content-type": "text/html; charset=utf-8" } });
  },
};

const ORIGIN = "https://mudskipper-nisar.pages.dev";
const MD = "text/markdown";
const BROWSER = "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8";

/** What Pages does after the middleware calls next(): the asset server (the API has its own Function). */
async function site(path: string, accept?: string, init: RequestInit = {}) {
  const req = new Request(ORIGIN + path, { ...init, headers: { ...(accept ? { accept } : {}), ...(init.headers as Record<string, string>) } });
  let nextCalled = false;
  const res = await handleSite(req, { ASSETS: assets }, async () => {
    nextCalled = true;
    if (path.startsWith("/api")) return new Response('{"api":true}', { headers: { "content-type": "application/json" } });
    return assets.fetch(req);
  });
  return { res, body: await res.text(), nextCalled };
}

beforeEach(() => {
  clearSiteCache();
  assets.fetches = [];
});

describe("Accept negotiation", () => {
  it.each([
    ["text/markdown", true],
    ["text/markdown, text/html;q=0.9", true],
    ["text/html, text/markdown", false],
    ["text/markdown, text/html", true],
    ["text/html;q=0.5, text/markdown;q=0.8", true],
    ["text/markdown;q=0", false],
    ["text/x-markdown", true],
    [BROWSER, false],
    ["*/*", false],
    ["application/json", false],
    [null, false],
  ])("%s → markdown %s", (accept, want) => {
    expect(prefersMarkdown(accept)).toBe(want);
  });

  it("maps paths to pages and their Markdown twins", () => {
    expect(pagePath("/")).toBe("/");
    expect(pagePath("/index.html")).toBe("/");
    expect(pagePath("/about/")).toBe("/about");
    expect(pagePath("/about.html")).toBe("/about");
    expect(pagePath("/og.png")).toBeNull();
    expect(pagePath("/../etc")).toBeNull();
    expect(markdownAsset("/")).toBe("/index.md");
    expect(markdownAsset("/about")).toBe("/about.md");
  });
});

describe("site middleware", () => {
  it("serves the homepage's Markdown for Accept: text/markdown, with Vary: Accept and the discovery links", async () => {
    const { res, body } = await site("/", MD);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(MARKDOWN_TYPE);
    expect(res.headers.get("vary")).toBe("Accept");
    expect(res.headers.get("link")).toBe(HOME_LINKS);
    expect(body).toBe("# home\n");
  });

  it("keeps serving HTML to browsers and to Accept: text/html, with Vary: Accept", async () => {
    for (const accept of [BROWSER, "text/html", undefined]) {
      const { res, body } = await site("/", accept);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
      expect(res.headers.get("vary")).toBe("Accept");
      expect(body).toContain("<h1>home</h1>");
    }
  });

  it("negotiates every page that has a Markdown twin, and HEAD too", async () => {
    expect((await site("/lab", MD)).body).toBe("# lab\n");
    expect((await site("/about/", MD)).body).toBe("# about\n");
    const head = await site("/about", MD, { method: "HEAD" });
    expect(head.res.status).toBe(200);
    expect(head.res.headers.get("content-type")).toBe(MARKDOWN_TYPE);
  });

  it("answers unknown paths with a real 404: HTML by default, Markdown when asked", async () => {
    const html = await site("/some-path-that-does-not-exist", BROWSER);
    expect(html.res.status).toBe(404);
    expect(html.res.headers.get("content-type")).toContain("text/html");
    expect(html.res.headers.get("vary")).toBe("Accept");
    const md = await site("/some-path-that-does-not-exist", MD);
    expect(md.res.status).toBe(404);
    expect(md.res.headers.get("content-type")).toBe(MARKDOWN_TYPE);
    expect(md.res.headers.get("vary")).toBe("Accept");
    expect(md.body).toContain("Page not found");
    expect(md.body.length).toBeGreaterThan(20);
  });

  it("keeps the app's dynamic routes (from site.json) alive with the app shell", async () => {
    const r = await site("/field/fazilka-00114", BROWSER);
    expect(r.res.status).toBe(200);
    expect(r.body).toContain("<h1>home</h1>");
    expect((await site("/field/", BROWSER)).res.status).toBe(404);
    const md = await site("/field/fazilka-00114", MD);
    expect(md.res.status).toBe(200);
    expect(md.res.headers.get("content-type")).toBe(MARKDOWN_TYPE);
  });

  it("reads site.json once per isolate", async () => {
    await site("/", MD);
    await site("/lab", MD);
    await site("/nope", MD);
    expect(assets.fetches.filter((p) => p === "/site.json")).toHaveLength(1);
  });

  it("passes /api and /tiles straight through, untouched", async () => {
    const r = await site("/api/meta", MD);
    expect(r.nextCalled).toBe(true);
    expect(r.body).toBe('{"api":true}');
    expect(r.res.headers.get("vary")).toBeNull();
    expect(assets.fetches).toEqual([]);
  });

  it("passes other methods through", async () => {
    const r = await site("/", MD, { method: "POST", body: "x" });
    expect(r.res.headers.get("content-type")).not.toBe(MARKDOWN_TYPE);
  });

  it("sets the types the static server cannot know", async () => {
    expect((await site("/.well-known/api-catalog")).res.headers.get("content-type")).toContain("application/linkset+json");
    expect((await site("/openapi.yaml")).res.headers.get("content-type")).toBe("application/yaml; charset=utf-8");
    expect((await site("/about.md")).res.headers.get("content-type")).toBe(MARKDOWN_TYPE);
  });

  it("serves a page without a Markdown twin as HTML even when Markdown is preferred", async () => {
    FILES["/terms"] = ["text/html; charset=utf-8", "<h1>terms</h1>"];
    const r = await site("/terms", MD);
    expect(r.res.status).toBe(200);
    expect(r.body).toBe("<h1>terms</h1>");
    expect(r.res.headers.get("vary")).toBe("Accept");
    delete FILES["/terms"];
  });
});
