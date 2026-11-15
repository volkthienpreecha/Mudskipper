/**
 * Keep the previous live run's map files for one release (review item 3). A browser that cached /api/meta
 * of the old run (max-age 60, stale-while-revalidate 600) still asks for /tiles/runs/<old>/…; without the old
 * files in the new deployment those requests would 404 while the new meta propagates. So publish copies the
 * old run's manifest and its /tiles files (not its API documents: the API only ever answers for the live run)
 * from the deployment being replaced into the new site, checking every sha256.
 */
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { manifestPath, tilePath } from "../../src/bundle-layout.ts";
import type { BundleManifest } from "../../src/repo/types.ts";

export interface CarryResult {
  runId: string;
  files: number;
  bytes: number;
}

/** What `base` (a deployed site) serves as live: its run_id, or null when it serves nothing yet. */
export async function liveRunOf(base: string): Promise<{ run_id: string; fixture: boolean } | null> {
  const res = await fetch(`${base}/data/live.json`);
  if (res.status === 404) return null;
  const type = res.headers.get("content-type") ?? "";
  if (!res.ok || !type.includes("json")) {
    if (type.includes("text/html")) return null; // the SPA fallback: nothing published
    throw new Error(`${base}/data/live.json: HTTP ${res.status}`);
  }
  return (await res.json()) as { run_id: string; fixture: boolean };
}

/**
 * Copy run `runId`'s manifest and /tiles files from the deployed site `base` into the site directory `out`
 * (which becomes /), and add its cache rule to `_headers`. Throws on any missing file or hash mismatch.
 */
export async function carryRun(out: string, base: string, runId: string): Promise<CarryResult> {
  const mRes = await fetch(base + manifestPath(runId));
  if (!mRes.ok || !(mRes.headers.get("content-type") ?? "").includes("json")) {
    throw new Error(`${base}${manifestPath(runId)}: HTTP ${mRes.status}`);
  }
  const manifestText = await mRes.text();
  const manifest = JSON.parse(manifestText) as BundleManifest;
  let bytes = 0;
  for (const [rel, f] of Object.entries(manifest.files)) {
    const res = await fetch(base + tilePath(runId, rel));
    if (!res.ok) throw new Error(`${base}${tilePath(runId, rel)}: HTTP ${res.status}`);
    const data = Buffer.from(await res.arrayBuffer());
    const sha = createHash("sha256").update(data).digest("hex");
    if (sha !== f.sha256) throw new Error(`${rel} of run ${runId}: sha256 ${sha.slice(0, 12)} is not the manifest's ${f.sha256.slice(0, 12)}`);
    const target = join(out, tilePath(runId, rel));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, data);
    bytes += data.byteLength;
  }
  const mTarget = join(out, manifestPath(runId));
  mkdirSync(dirname(mTarget), { recursive: true });
  writeFileSync(mTarget, manifestText);
  const cache = manifest.fixture ? "public, max-age=300, stale-while-revalidate=86400" : "public, max-age=31536000, immutable";
  appendFileSync(join(out, "_headers"), `\n/data/runs/${runId}/*\n  Cache-Control: ${cache}\n  Access-Control-Allow-Origin: *\n`);
  return { runId, files: Object.keys(manifest.files).length + 1, bytes };
}
