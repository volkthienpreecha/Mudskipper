/**
 * Inspection ranking (CONTRACTS.md B6 "Ranking"). Python reference: `rules.rank`.
 *
 * The ranking depends only on the parsed claims, `budget` and `seed`; `input_hash` (sha256 of the exact
 * request body bytes, computed by the caller, see `readAuditBody`) feeds only the default seed and the
 * `audit_id`. No trigonometry and only integer arithmetic for the budget split, so Python and TypeScript
 * rank identically.
 */
import type { AuditRequest, AuditResponse, DsrSignal, RankedPick, Verdict } from "./contracts.gen.ts";
import { looksText } from "./format.ts";
import {
  bboxMayContain,
  bboxOf,
  checkRings,
  contains,
  GeometryError,
  representativePoint,
  type AreaGeometryInput,
  type BBox,
  type GeometryInput,
} from "./geometry.ts";
import { mulberry32 } from "./prng.ts";
import { sha256Hex } from "./sha.ts";
import { getSummary, type SummaryLookup } from "./story.ts";

export const NOTICE = "Ranking for inspection, not a finding about anyone.";
/** B6 limits. The body limit is 5 MiB (5,242,880 bytes); see DECISIONS.md K-204. */
export const MAX_BODY_BYTES = 5 * 1024 * 1024;
export const MAX_CLAIMS = 5000;
export const MAX_BUDGET = 500;

export const AWD_WEIGHT: { readonly [V in Verdict]: 1 | 0.6 | 0.1 } = {
  inconsistent: 1.0,
  not_enough_evidence: 0.6,
  consistent: 0.1,
};
export const DSR_WEIGHT: { readonly [S in DsrSignal]: 1 | 0.6 | 0.1 } = {
  transplant_signal: 1.0,
  unknown: 0.6,
  dsr_signal: 0.1,
};
export const UNMATCHED_WEIGHT = 0.8;
export const NO_SUMMARY_WEIGHT = 0.6;
export const UNMATCHED_STRATUM = "~unmatched";

/** B6 audit error codes. Every one is an HTTP 400 except `too_large` (413). */
export type RankErrorCode =
  | "invalid_json"
  | "invalid_request"
  | "too_large"
  | "too_many_claims"
  | "duplicate_claim_id"
  | "invalid_geometry";

/** A request the ranking rejects; `code` becomes the API error code. */
export class RankError extends Error {
  readonly code: RankErrorCode;
  constructor(code: RankErrorCode, message: string) {
    super(message);
    this.name = "RankError";
    this.code = code;
  }
  /** The HTTP status the API answers with. */
  get status(): 400 | 413 {
    return this.code === "too_large" ? 413 : 400;
  }
}

/** What ranking reads from a field feature (`fields.geojson` features are assignable). */
export interface RankField {
  readonly geometry: AreaGeometryInput;
  readonly properties: { readonly field_id: string; readonly district: string; readonly area_ha: number };
}

/** What ranking reads from a summary line (`field_summary.jsonl` lines are assignable). */
export interface RankSummary {
  readonly awd: { readonly verdict: Verdict; readonly clear_looks: number; readonly drained_hits: number };
  readonly dsr: { readonly signal: DsrSignal };
}

/** What ranking reads from the request (`AuditRequest` is assignable; uploads may carry extra members). */
export interface RankRequest {
  readonly claims: {
    readonly features: ReadonlyArray<{
      readonly geometry: GeometryInput;
      readonly properties: {
        readonly claim_id?: string | null;
        readonly claimed: ReadonlyArray<string>;
        readonly synthetic: boolean;
        readonly field_id?: string | null;
        readonly area_ha?: unknown;
      };
    }>;
  };
  readonly budget: number;
  readonly seed?: number | null;
}

const byCodeUnits = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const PRACTICES = ["awd", "dsr"] as const;
type Practice = (typeof PRACTICES)[number];

interface Candidate {
  key: string;
  claim_id: string;
  field_id: string | null;
  district: string | null;
  claimed: Practice[];
  area: number;
  weight: RankedPick["weight"];
  reason: string;
  score: number;
}

function reasonParts(claimed: ReadonlyArray<Practice>, summary: RankSummary | undefined): string {
  if (summary === undefined) return "No season summary yet";
  const parts: string[] = [];
  if (claimed.includes("awd")) {
    const a = summary.awd;
    const looks = looksText(a.clear_looks);
    const text = {
      inconsistent: `Not consistent with AWD (${a.drained_hits} of ${looks} drained)`,
      not_enough_evidence: `Not enough evidence for AWD (${looks})`,
      consistent: `Consistent with AWD (${a.drained_hits} of ${looks} drained)`,
    }[a.verdict];
    if (text === undefined) throw new RangeError(`unknown verdict ${String(a.verdict)}`);
    parts.push(text);
  }
  if (claimed.includes("dsr")) {
    const text = {
      transplant_signal: "DSR: transplant signal",
      unknown: "DSR: signal unknown",
      dsr_signal: "DSR: DSR signal",
    }[summary.dsr.signal];
    if (text === undefined) throw new RangeError(`unknown DSR signal ${String(summary.dsr.signal)}`);
    parts.push(text);
  }
  return parts.join("; ");
}

function isUint32(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= 4294967295;
}

/**
 * Parse an audit request body and hash its exact bytes (B6 step 8). A string is hashed as its UTF-8 bytes,
 * which are the bytes `fetch` sends for a string body. Throws `RankError` (`too_large`, `invalid_json`).
 */
export async function readAuditBody(body: string | Uint8Array<ArrayBuffer>): Promise<{ request: unknown; inputHash: string }> {
  const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
  if (bytes.byteLength > MAX_BODY_BYTES) throw new RankError("too_large", `request body is larger than ${MAX_BODY_BYTES} bytes`);
  let request: unknown;
  try {
    // ignoreBOM: a leading U+FEFF stays in the text, so JSON.parse rejects it like Python's json.loads (C0: no BOM).
    request = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes));
  } catch {
    throw new RankError("invalid_json", "request body is not valid UTF-8 JSON");
  }
  return { request, inputHash: await sha256Hex(bytes) };
}

const CLAIM_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const FIELD_ID_RE = /^[a-z][a-z0-9]{0,15}-[0-9]{5}$/;
const RUN_ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function checkPosition(p: unknown, where: string): void {
  if (!Array.isArray(p) || p.length < 2 || p.length > 3 || !p.every(isNum)) {
    throw new RankError("invalid_request", `${where}: a position is [lon, lat] or [lon, lat, altitude]`);
  }
  const [lon, lat] = p as [number, number];
  if (lon < -180 || lon > 180 || lat < -90 || lat > 90) {
    throw new RankError("invalid_request", `${where}: position out of range (lon -180..180, lat -90..90)`);
  }
}

function checkPolygonCoords(c: unknown, where: string): void {
  if (!Array.isArray(c) || c.length < 1) throw new RankError("invalid_request", `${where}: a polygon needs at least one ring`);
  for (const ring of c) {
    if (!Array.isArray(ring) || ring.length < 4) {
      throw new RankError("invalid_request", `${where}: a ring needs at least 4 positions`);
    }
    for (const p of ring) checkPosition(p, where);
  }
}

/**
 * Structural check of a parsed `POST /api/audit` body against `api/audit_request.schema.json` and the B6
 * limits, with no dependencies (so the Worker and the fixtures client can share it). Returns the request
 * typed; throws `RankError` (`too_many_claims` above 5,000 claims, otherwise `invalid_request`).
 * Ring closure is checked later by `rank` (`invalid_geometry`), as the contract assigns that code.
 */
export function validateAuditRequest(value: unknown): AuditRequest {
  if (!isObject(value)) throw new RankError("invalid_request", "request body must be a JSON object");
  for (const key of Object.keys(value)) {
    if (key !== "claims" && key !== "budget" && key !== "seed") throw new RankError("invalid_request", `unknown member ${key}`);
  }
  const { claims, budget, seed } = value;
  if (!(Number.isInteger(budget) && (budget as number) >= 1 && (budget as number) <= MAX_BUDGET)) {
    throw new RankError("invalid_request", `budget must be an integer from 1 to ${MAX_BUDGET}`);
  }
  if (seed !== undefined && !isUint32(seed)) throw new RankError("invalid_request", "seed must be an integer from 0 to 4294967295");
  if (!isObject(claims) || claims.type !== "FeatureCollection" || !Array.isArray(claims.features)) {
    throw new RankError("invalid_request", "claims must be a GeoJSON FeatureCollection");
  }
  if (claims.features.length > MAX_CLAIMS) throw new RankError("too_many_claims", `at most ${MAX_CLAIMS} claims per request`);
  if (claims.features.length < 1) throw new RankError("invalid_request", "claims.features must not be empty");
  if (claims.v !== undefined && claims.v !== 1) throw new RankError("invalid_request", "claims.v must be 1");
  if (claims.run_id !== undefined && !(typeof claims.run_id === "string" && RUN_ID_RE.test(claims.run_id))) {
    throw new RankError("invalid_request", "claims.run_id is not a valid run id");
  }
  if (claims.fixture !== undefined && typeof claims.fixture !== "boolean") {
    throw new RankError("invalid_request", "claims.fixture must be a boolean");
  }
  claims.features.forEach((claim: unknown, i: number) => {
    const where = `claims.features[${i}]`;
    if (!isObject(claim) || claim.type !== "Feature") throw new RankError("invalid_request", `${where} must be a GeoJSON Feature`);
    if (claim.id !== undefined && typeof claim.id !== "string" && !Number.isInteger(claim.id)) {
      throw new RankError("invalid_request", `${where}.id must be a string or an integer`);
    }
    const g = claim.geometry;
    if (!isObject(g)) throw new RankError("invalid_request", `${where}.geometry must be a Point, Polygon or MultiPolygon`);
    if (g.type === "Point") checkPosition(g.coordinates, `${where}.geometry`);
    else if (g.type === "Polygon") checkPolygonCoords(g.coordinates, `${where}.geometry`);
    else if (g.type === "MultiPolygon") {
      if (!Array.isArray(g.coordinates) || g.coordinates.length < 1) {
        throw new RankError("invalid_request", `${where}.geometry: a MultiPolygon needs at least one polygon`);
      }
      for (const poly of g.coordinates) checkPolygonCoords(poly, `${where}.geometry`);
    } else throw new RankError("invalid_request", `${where}.geometry must be a Point, Polygon or MultiPolygon`);
    const p = claim.properties;
    if (!isObject(p)) throw new RankError("invalid_request", `${where}.properties must be an object`);
    const claimed = p.claimed;
    if (
      !Array.isArray(claimed) ||
      claimed.length < 1 ||
      claimed.length > 2 ||
      !claimed.every((c) => c === "awd" || c === "dsr") ||
      new Set(claimed).size !== claimed.length
    ) {
      throw new RankError("invalid_request", `${where}.properties.claimed must be a non-empty list of awd and/or dsr`);
    }
    if (typeof p.synthetic !== "boolean") throw new RankError("invalid_request", `${where}.properties.synthetic must be a boolean`);
    if (p.claim_id !== undefined && !(typeof p.claim_id === "string" && CLAIM_ID_RE.test(p.claim_id))) {
      throw new RankError("invalid_request", `${where}.properties.claim_id must match ${CLAIM_ID_RE.source}`);
    }
    if (p.field_id !== undefined && !(typeof p.field_id === "string" && FIELD_ID_RE.test(p.field_id))) {
      throw new RankError("invalid_request", `${where}.properties.field_id is not a field id`);
    }
    if (p.area_ha !== undefined && !(isNum(p.area_ha) && p.area_ha >= 0 && p.area_ha <= 10000)) {
      throw new RankError("invalid_request", `${where}.properties.area_ha must be a number from 0 to 10000`);
    }
  });
  return value as unknown as AuditRequest;
}

/** The seed B6 step 8 uses: the request's, or the first 8 hex digits of the input hash as a uint32. */
export function seedFor(request: Pick<RankRequest, "seed">, inputHash: string): number {
  return request.seed === undefined || request.seed === null ? parseInt(inputHash.slice(0, 8), 16) : request.seed;
}

/**
 * B6 ranking. `request` is the parsed body (already schema-checked by the API), `inputHash` the sha256 hex of
 * its exact bytes, `fields` the run's features, `summaries` field_id → summary line. Async only because
 * `audit_id` needs SHA-256. Throws `RankError` for requests the contract rejects.
 */
export async function rank(
  request: AuditRequest | RankRequest,
  inputHash: string,
  fields: ReadonlyArray<RankField>,
  summaries: SummaryLookup<RankSummary>,
  runId: string,
  createdAt: string,
  fixture: boolean,
): Promise<AuditResponse> {
  const req = request as RankRequest;
  const claims = req.claims?.features;
  if (!Array.isArray(claims)) throw new RankError("invalid_request", "claims.features must be an array");
  if (claims.length > MAX_CLAIMS) throw new RankError("too_many_claims", `at most ${MAX_CLAIMS} claims per request`);
  const budget = req.budget;
  if (!(Number.isInteger(budget) && budget >= 1 && budget <= MAX_BUDGET)) {
    throw new RankError("invalid_request", `budget must be an integer from 1 to ${MAX_BUDGET}`);
  }
  if (req.seed !== undefined && req.seed !== null && !isUint32(req.seed)) {
    throw new RankError("invalid_request", "seed must be an integer from 0 to 4294967295");
  }
  if (!/^[0-9a-f]{64}$/.test(inputHash)) throw new RangeError("inputHash must be a lowercase sha256 hex digest");
  const seed = seedFor(req, inputHash);

  // Claim ids, then geometry checks (all claims), then duplicates: the reference's order of errors. Like
  // rules.rank, the first loop also computes every claim's point, so a degenerate ring is invalid_geometry
  // even when a field_id hint would have matched, and wins over a duplicate_claim_id earlier in the upload.
  const ids: string[] = [];
  const points: Array<[number, number]> = [];
  claims.forEach((claim, i) => {
    const cid = claim.properties.claim_id;
    ids.push(cid === undefined || cid === null ? `#${i + 1}` : cid);
    try {
      if (claim.geometry.type !== "Point") checkRings(claim.geometry);
      points.push(representativePoint(claim.geometry));
    } catch (err) {
      if (err instanceof GeometryError) throw new RankError("invalid_geometry", `claim ${ids[ids.length - 1]}: ${err.message}`);
      throw err;
    }
  });
  const seen = new Map<string, number>();
  for (const id of ids) seen.set(id, (seen.get(id) ?? 0) + 1);
  const dup = ids.find((id) => seen.get(id)! > 1);
  if (dup !== undefined) throw new RankError("duplicate_claim_id", `claim_id '${dup}' appears more than once`);

  const byId = new Map<string, RankField>();
  for (const f of fields) byId.set(f.properties.field_id, f);
  const ordered = [...fields].sort((a, b) => byCodeUnits(a.properties.field_id, b.properties.field_id));
  let boxes: BBox[] | null = null; // computed on first geometry match; the prefilter never changes results

  const candidates = new Map<string, Candidate>();
  const order: string[] = [];
  let matched = 0;
  let unmatched = 0;
  claims.forEach((claim, i) => {
    const claimId = ids[i]!;
    const props = claim.properties;
    const claimed = PRACTICES.filter((c) => props.claimed.includes(c));
    let field = props.field_id ? byId.get(props.field_id) : undefined;
    if (field === undefined) {
      const [px, py] = points[i]!;
      boxes ??= ordered.map((f) => bboxOf(f.geometry));
      const at = ordered.findIndex((f, k) => bboxMayContain(boxes![k]!, px, py) && contains(f.geometry, px, py));
      field = at < 0 ? undefined : ordered[at];
    }
    if (field === undefined) {
      unmatched += 1;
      const key = "~" + claimId;
      const area = props.area_ha;
      candidates.set(key, {
        key,
        claim_id: claimId,
        field_id: null,
        district: null,
        claimed,
        area: typeof area === "number" && area > 0 ? area : 1.0,
        weight: UNMATCHED_WEIGHT,
        reason: "Claim does not match a mapped rice field",
        score: 0,
      });
      order.push(key);
      return;
    }
    matched += 1;
    const fid = field.properties.field_id;
    const merged = candidates.get(fid);
    if (merged !== undefined) {
      merged.claimed = PRACTICES.filter((c) => merged.claimed.includes(c) || claimed.includes(c));
    } else {
      candidates.set(fid, {
        key: fid,
        claim_id: claimId,
        field_id: fid,
        district: field.properties.district,
        claimed,
        area: field.properties.area_ha,
        weight: NO_SUMMARY_WEIGHT,
        reason: "",
        score: 0,
      });
      order.push(fid);
    }
  });

  for (const cand of candidates.values()) {
    if (cand.field_id !== null) {
      const summary = getSummary(summaries, cand.field_id);
      if (summary === undefined) {
        cand.weight = NO_SUMMARY_WEIGHT;
      } else {
        const ws: Array<number | undefined> = [];
        if (cand.claimed.includes("awd")) ws.push(AWD_WEIGHT[summary.awd.verdict]);
        if (cand.claimed.includes("dsr")) ws.push(DSR_WEIGHT[summary.dsr.signal]);
        if (ws.length === 0) {
          throw new RankError("invalid_request", `claim ${cand.claim_id}: claimed must name awd and/or dsr`);
        }
        if (ws.some((w) => w === undefined)) throw new RangeError(`summary of ${cand.field_id} has an unknown verdict or signal`);
        cand.weight = Math.max(...(ws as number[])) as RankedPick["weight"];
      }
      cand.reason = reasonParts(cand.claimed, summary);
    }
    cand.score = cand.weight * cand.area;
  }

  const pool = order.map((k) => candidates.get(k)!);
  const n = Math.min(budget, pool.length);
  const nRandom = Math.floor((n + 2) / 5);
  const nScore = n - nRandom;
  const byScore = [...pool].sort((a, b) => {
    if (a.score !== b.score) return a.score > b.score ? -1 : 1;
    if (a.weight !== b.weight) return a.weight > b.weight ? -1 : 1;
    return byCodeUnits(a.key, b.key);
  });
  const scorePicks = byScore.slice(0, nScore);
  const rest = byScore.slice(nScore);

  // Stratified random picks with integer quotas (B6 step 6).
  const strata = new Map<string, Candidate[]>();
  for (const cand of rest) {
    const name = cand.district || UNMATCHED_STRATUM;
    const list = strata.get(name);
    if (list) list.push(cand);
    else strata.set(name, [cand]);
  }
  const names = [...strata.keys()].sort(byCodeUnits);
  const quotas = new Map<string, number>();
  if (rest.length > 0) {
    const remainders: Array<{ rem: number; name: string }> = [];
    for (const name of names) {
      const exactNum = nRandom * strata.get(name)!.length;
      quotas.set(name, Math.floor(exactNum / rest.length));
      remainders.push({ rem: exactNum % rest.length, name });
    }
    let leftover = nRandom;
    for (const q of quotas.values()) leftover -= q;
    remainders.sort((a, b) => b.rem - a.rem || byCodeUnits(a.name, b.name));
    for (const { name } of remainders) {
      if (leftover === 0) break;
      if (quotas.get(name)! < strata.get(name)!.length) {
        quotas.set(name, quotas.get(name)! + 1);
        leftover -= 1;
      }
    }
  }
  const rng = mulberry32(seed);
  const randomPicks: Candidate[] = [];
  for (const name of names) {
    const items = [...strata.get(name)!].sort((a, b) => byCodeUnits(a.key, b.key));
    const m = items.length;
    const quota = quotas.get(name) ?? 0;
    for (let i = 0; i < quota; i++) {
      const j = i + Math.floor(rng() * (m - i));
      const tmp = items[i]!;
      items[i] = items[j]!;
      items[j] = tmp;
    }
    randomPicks.push(...items.slice(0, quota));
  }

  const ranked: RankedPick[] = [];
  for (const [pick, group] of [
    ["score", scorePicks],
    ["random", randomPicks],
  ] as const) {
    for (const cand of group) {
      ranked.push({
        rank: ranked.length + 1,
        claim_id: cand.claim_id,
        field_id: cand.field_id,
        district: cand.district,
        weight: cand.weight,
        score: cand.score,
        reason: pick === "score" ? cand.reason : "Random check; " + cand.reason,
        pick,
      });
    }
  }

  const auditId = "a_" + (await sha256Hex(`${runId}|${inputHash}|${budget}|${seed}`)).slice(0, 16);
  return {
    v: 1,
    run_id: runId,
    fixture,
    audit_id: auditId,
    created_at: createdAt,
    budget,
    seed,
    input_hash: inputHash,
    synthetic: claims.every((c) => Boolean(c.properties.synthetic)),
    matched,
    unmatched,
    ranked,
    notice: NOTICE,
  };
}
