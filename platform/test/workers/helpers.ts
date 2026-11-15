import { env } from "cloudflare:workers";
import { createApp } from "../../src/app.ts";
import { auditId, defaultSeed } from "../../src/crypto.ts";
import type { AuditResponse, Live } from "../../src/contracts.ts";
import { diffRun, diffStatements, execute, liveStatement, planRun } from "../../src/d1/plan.ts";
import type { Bindings } from "../../src/env.ts";
import type { RankFn } from "../../src/audit/rank.ts";
import { clearD1Cache } from "../../src/repo/d1.ts";
import { clearStaticCache } from "../../src/repo/static.ts";
import type { BundleManifest } from "../../src/repo/types.ts";
import { buildApiDocs } from "../../src/shapes.ts";
import { clearTilesCache } from "../../src/tiles.ts";
import * as V from "../gen/validators.js";

export const ORIGIN = "https://mudskipper-nisar.pages.dev";
export const FIXED_NOW = new Date("2026-11-14T00:00:00Z");
export const validators = V;

export type BackendKind = "static" | "d1" | "r2";
export const DATA_BACKENDS: BackendKind[] = ["static", "d1"];

/** Bindings for one backend. `r2` = D1 for data + R2 for tiles and live.json. */
export function envFor(kind: BackendKind, overrides: Partial<Bindings> = {}): Bindings {
  const base: Bindings = { ASSETS: env.ASSETS, AUDITS: env.AUDITS };
  if (kind === "d1") Object.assign(base, { DB: env.DB });
  if (kind === "r2") Object.assign(base, { DB: env.DB, DATA: env.DATA });
  return { ...base, ...overrides };
}

export function resetCaches(): void {
  clearStaticCache();
  clearD1Cache();
  clearTilesCache();
}

export function makeApp(rank?: RankFn) {
  return createApp({ now: () => FIXED_NOW, ...(rank ? { rank } : {}) });
}

export async function call(path: string, kind: BackendKind | Bindings, init: RequestInit = {}, rank?: RankFn) {
  const bindings = typeof kind === "string" ? envFor(kind) : kind;
  return makeApp(rank).request(ORIGIN + path, init, bindings);
}

export const fixtureApi = (name: string) => structuredClone(env.TEST_FIXTURE_API[name]) as Record<string, unknown>;

/** A stand-in for core's rank: returns the golden response for the golden request (Phase 1 envelope tests). */
export const goldenRank: RankFn = async (req, inputHash, fields, summaries, runId, createdAt, fixture) => {
  const golden = fixtureApi("audit.response") as unknown as AuditResponse;
  if (summaries.size !== 300 || fields.length !== 300) throw new Error("rank inputs are incomplete");
  const seed = req.seed ?? defaultSeed(inputHash);
  const audit_id = await auditId(runId, inputHash, req.budget, seed);
  return { ...golden, run_id: runId, fixture, created_at: createdAt, input_hash: inputHash, seed, budget: req.budget, audit_id };
};

async function assetJson<T>(path: string): Promise<T> {
  const res = await env.ASSETS.fetch(ORIGIN + path);
  return (await res.json()) as T;
}

export async function loadFixtureIntoD1(): Promise<number> {
  const run = env.TEST_RUN;
  const manifest = await assetJson<BundleManifest>("/data/runs/fixture/manifest.json");
  const live = await assetJson<Live>("/data/live.json");
  const plans = planRun(run, buildApiDocs(run), manifest);
  const diffs = await diffRun(env.DB, plans, run.run_id);
  const res = await execute(env.DB, [...diffStatements(diffs), liveStatement(live)]);
  return res.rowsWritten;
}

export async function uploadTilesToR2(): Promise<void> {
  const manifest = await assetJson<BundleManifest>("/data/runs/fixture/manifest.json");
  for (const [rel, f] of Object.entries(manifest.files)) {
    const res = await env.ASSETS.fetch(`${ORIGIN}/data/runs/fixture/${rel}`);
    await env.DATA.put(`runs/fixture/${rel}`, await res.arrayBuffer(), { httpMetadata: { contentType: f.type } });
  }
  await env.DATA.put("live.json", JSON.stringify(await assetJson<Live>("/data/live.json")), {
    httpMetadata: { contentType: "application/json" },
  });
}

/** Parsed-value equality that treats -0 and 0 alike only where JSON would (it never writes -0). */
export function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));
}

function sortKeys(x: unknown): unknown {
  if (Array.isArray(x)) return x.map(sortKeys);
  if (x && typeof x === "object") {
    return Object.fromEntries(Object.keys(x as object).sort().map((k) => [k, sortKeys((x as Record<string, unknown>)[k])]));
  }
  return x;
}
