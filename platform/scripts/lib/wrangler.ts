/** Reading wrangler.jsonc and running wrangler with the right account, from the Node scripts. */
import { spawnSync, type SpawnSyncOptions } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PLATFORM_ROOT, REPO_ROOT } from "./run.ts";

/** The only Cloudflare account this project deploys to (DECISIONS.md K-002). */
export const ACCOUNT_ID = "e5e342f3ca2f33158f6f1dd40c039be0";
export const PROJECT = "mudskipper-nisar";
export const PRODUCTION_URL = "https://mudskipper-nisar.pages.dev";
export const WRANGLER_CONFIG = join(PLATFORM_ROOT, "wrangler.jsonc");
export const LOCAL_STATE = join(PLATFORM_ROOT, ".wrangler", "state");

/** Strip // and /* comments and trailing commas from JSONC, leaving strings intact. */
export function parseJsonc<T>(text: string): T {
  let out = "";
  let i = 0;
  let inString = false;
  while (i < text.length) {
    const ch = text[i]!;
    const next = text[i + 1];
    if (inString) {
      out += ch;
      if (ch === "\\") {
        out += next ?? "";
        i += 2;
        continue;
      }
      if (ch === '"') inString = false;
      i++;
    } else if (ch === '"') {
      inString = true;
      out += ch;
      i++;
    } else if (ch === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (ch === "/" && next === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i += 2;
    } else {
      out += ch;
      i++;
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1")) as T;
}

export interface WranglerConfig {
  name: string;
  compatibility_date: string;
  kv_namespaces?: { binding: string; id: string }[];
  d1_databases?: { binding: string; database_name: string; database_id: string; migrations_dir?: string }[];
  r2_buckets?: { binding: string; bucket_name: string }[];
}

export function readWranglerConfig(path = WRANGLER_CONFIG): WranglerConfig {
  return parseJsonc<WranglerConfig>(readFileSync(path, "utf8"));
}

export function d1Binding(cfg: WranglerConfig) {
  return cfg.d1_databases?.find((d) => d.binding === "DB") ?? null;
}

export function r2Binding(cfg: WranglerConfig) {
  return cfg.r2_buckets?.find((b) => b.binding === "DATA") ?? null;
}

/**
 * A Workers-style config containing only the D1 binding, for wrangler's D1 commands and getPlatformProxy
 * (they need a database_id; locally any stable id works). Written under platform/.wrangler/.
 */
export function writeD1Config(remote: boolean): string {
  const cfg = readWranglerConfig();
  const db = d1Binding(cfg);
  if (remote && !db) {
    throw new Error(
      "D1 is not configured: wrangler.jsonc has no d1_databases entry for DB. The account is at the free plan's " +
        "10-database limit; see platform/README.md, \"Switch to D1\".",
    );
  }
  const binding = db ?? { binding: "DB", database_name: "mudskipper", database_id: "00000000-0000-4000-8000-00000000d1d1" };
  const dir = join(PLATFORM_ROOT, ".wrangler", "tmp");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, remote ? "d1.remote.json" : "d1.local.json");
  writeFileSync(
    path,
    JSON.stringify(
      {
        name: "mudskipper-d1-loader",
        compatibility_date: cfg.compatibility_date,
        d1_databases: [{ ...binding, migrations_dir: join(PLATFORM_ROOT, "migrations"), ...(remote ? { remote: true } : {}) }],
      },
      null,
      2,
    ),
  );
  return path;
}

/** Run the workspace's wrangler with CLOUDFLARE_ACCOUNT_ID pinned. Throws on a non-zero exit. */
export function wrangler(args: string[], opts: SpawnSyncOptions & { quiet?: boolean } = {}): string {
  const bin = join(REPO_ROOT, "node_modules", "wrangler", "bin", "wrangler.js");
  const res = spawnSync(process.execPath, [bin, ...args], {
    cwd: PLATFORM_ROOT,
    encoding: "utf8",
    stdio: opts.quiet ? ["ignore", "pipe", "pipe"] : ["ignore", "pipe", "inherit"],
    ...opts,
    env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: process.env.CLOUDFLARE_ACCOUNT_ID ?? ACCOUNT_ID, CI: "true", ...opts.env },
  });
  const stdout = String(res.stdout ?? "");
  if (res.status !== 0) {
    throw new Error(`wrangler ${args.join(" ")} failed (exit ${res.status}):\n${stdout}\n${res.error?.message ?? String(res.stderr ?? "")}`);
  }
  return stdout;
}
