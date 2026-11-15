// Pages middleware for every page path (DECISIONS.md K-321, K-323): Markdown negotiation, real 404s and
// Vary: Accept (src/site.ts). `_routes.json` keeps static files (/assets, /fonts, /data, images) away from it,
// and /api, /tiles pass straight through to the Hono app.
import type { Bindings } from "../src/env.ts";
import { handleSite } from "../src/site.ts";

export const onRequest = (ctx: { request: Request; env: Bindings; next: () => Promise<Response> }): Promise<Response> =>
  handleSite(ctx.request, ctx.env, () => ctx.next());
