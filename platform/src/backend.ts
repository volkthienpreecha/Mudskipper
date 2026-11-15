/**
 * Backend selection from binding presence (DECISIONS.md K-003). No code change is needed to switch: bind DB
 * (and DATA) in wrangler.jsonc and redeploy.
 *
 *   data  : D1Repo when DB is bound (unless BACKEND=static), else StaticRepo over ASSETS /data/.
 *   audits: D1 `audits` when DB is bound, else KV AUDITS, else none (POST answers 503).
 *   tiles : R2 DATA when bound, else static assets /data/.
 */
import type { Bindings } from "./env.ts";
import { D1AuditStore, KvAuditStore, type AuditStore } from "./audit/store.ts";
import { D1Repo } from "./repo/d1.ts";
import { StaticRepo } from "./repo/static.ts";
import type { Repo } from "./repo/types.ts";

export interface Backend {
  repo: Repo;
  audits: AuditStore | null;
  tiles: "r2" | "static";
}

export function selectBackend(env: Bindings, origin: string): Backend {
  const useD1 = env.DB !== undefined && env.BACKEND !== "static";
  const repo: Repo = useD1 ? new D1Repo(env.DB!, env.ASSETS, origin) : new StaticRepo(env.ASSETS, origin);
  const audits = env.DB ? new D1AuditStore(env.DB) : env.AUDITS ? new KvAuditStore(env.AUDITS) : null;
  return { repo, audits, tiles: env.DATA ? "r2" : "static" };
}
