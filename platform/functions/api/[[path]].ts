// Pages Function for /api and /api/* (DECISIONS.md K-002): the whole Hono app, routed by its full path.
import { handle } from "hono/cloudflare-pages";
import { app } from "../../src/app.ts";

export const onRequest = handle(app);
