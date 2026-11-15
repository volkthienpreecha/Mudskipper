/**
 * Where stored audits live: D1 `audits` when DB is bound (SPEC B4), else the KV namespace AUDITS (K-003).
 * Only the ranking result is stored, never the uploaded claims (no geometry, no names).
 *
 * Audits are stored per content version of the run (the bundle_hash), not only per `audit_id`: `audit_id`
 * is the contract's hash of run_id, input, budget and seed (B6 step 8) and does not change when a run is
 * regenerated in place (the fixture run) or re-published with --allow-republish, but the ranking can. So a
 * stored result is only served for the version it was computed on (DECISIONS.md K-315):
 *
 * - KV: key `audit:<first 16 hex of bundle_hash>:<audit_id>`, kept 30 days (`expirationTtl`).
 * - D1: the row carries `bundle_hash` (migrations/0002); a row from another version is not served, and the
 *   next POST of that body re-ranks and replaces it.
 */
import type { AuditResponse } from "../contracts.ts";

/** Stored audits expire after 30 days (KV; the free plan has no other cleanup). */
export const AUDIT_TTL_SECONDS = 30 * 86_400;

export interface AuditStore {
  readonly kind: "d1" | "kv";
  get(auditId: string, version: string): Promise<AuditResponse | null>;
  /** Stores the result for this version unless one exists (first write wins); returns the stored copy. */
  put(result: AuditResponse, version: string): Promise<AuditResponse>;
}

export const kvAuditKey = (version: string, auditId: string) => `audit:${version.slice(0, 16)}:${auditId}`;

export class KvAuditStore implements AuditStore {
  readonly kind = "kv" as const;
  readonly kv: KVNamespace;

  constructor(kv: KVNamespace) {
    this.kv = kv;
  }

  async get(auditId: string, version: string): Promise<AuditResponse | null> {
    return this.kv.get<AuditResponse>(kvAuditKey(version, auditId), "json");
  }

  async put(result: AuditResponse, version: string): Promise<AuditResponse> {
    const existing = await this.get(result.audit_id, version);
    if (existing) return existing;
    await this.kv.put(kvAuditKey(version, result.audit_id), JSON.stringify(result), {
      expirationTtl: AUDIT_TTL_SECONDS,
      metadata: { run_id: result.run_id, created_at: result.created_at, bundle_hash: version },
    });
    return result;
  }
}

export class D1AuditStore implements AuditStore {
  readonly kind = "d1" as const;
  private readonly db: D1Database;

  constructor(db: D1Database) {
    this.db = db;
  }

  async get(auditId: string, version: string): Promise<AuditResponse | null> {
    const row = await this.db
      .prepare("SELECT result_json FROM audits WHERE audit_id = ? AND bundle_hash = ?")
      .bind(auditId, version)
      .first<{ result_json: string }>();
    return row ? (JSON.parse(row.result_json) as AuditResponse) : null;
  }

  async put(result: AuditResponse, version: string): Promise<AuditResponse> {
    await this.db
      .prepare(
        "INSERT INTO audits (audit_id, run_id, created_at, budget, seed, input_hash, synthetic, result_json, bundle_hash) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (audit_id) DO UPDATE SET run_id = excluded.run_id, " +
          "created_at = excluded.created_at, budget = excluded.budget, seed = excluded.seed, input_hash = excluded.input_hash, " +
          "synthetic = excluded.synthetic, result_json = excluded.result_json, bundle_hash = excluded.bundle_hash " +
          "WHERE audits.bundle_hash IS NOT excluded.bundle_hash",
      )
      .bind(
        result.audit_id,
        result.run_id,
        result.created_at,
        result.budget,
        result.seed,
        result.input_hash,
        result.synthetic ? 1 : 0,
        JSON.stringify(result),
        version,
      )
      .run();
    return (await this.get(result.audit_id, version)) ?? result;
  }
}
