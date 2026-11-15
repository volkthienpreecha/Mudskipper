// Pages Function for /tiles/* (CONTRACTS.md B5): the same Hono app, which serves run files with Range support.
import { handle } from "hono/cloudflare-pages";
import { app } from "../../src/app.ts";

export const onRequest = handle(app);
