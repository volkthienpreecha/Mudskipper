/**
 * Where stored audits live: D1 `audits` when DB is bound (SPEC B4), else the KV namespace AUDITS (K-003).
 * Keyed by audit_id. Only the ranking result is stored, never the uploaded claims (no geometry, no names).
 */
import type { AuditResponse } from "../contracts.ts";

export interface AuditStore {
  readonly kind: "d1" | "kv";
  get(auditId: string): Promise<AuditResponse | null>;
  /** Stores the result unless one with this audit_id exists; returns the stored copy (first write wins). */
  put(result: AuditResponse): Promise<AuditResponse>;
}

export class KvAuditStore implements AuditStore {
  readonly kind = "kv" as const;
  private readonly kv: KVNamespace;

  constructor(kv: KVNamespace) {
    this.kv = kv;
  }

  async get(auditId: string): Promise<AuditResponse | null> {
    return this.kv.get<AuditResponse>(`audit:${auditId}`, "json");
  }

  async put(result: AuditResponse): Promise<AuditResponse> {
    const existing = await this.get(result.audit_id);
    if (existing) return existing;
    await this.kv.put(`audit:${result.audit_id}`, JSON.stringify(result), {
      metadata: { run_id: result.run_id, created_at: result.created_at },
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

  async get(auditId: string): Promise<AuditResponse | null> {
    const row = await this.db
      .prepare("SELECT result_json FROM audits WHERE audit_id = ?")
      .bind(auditId)
      .first<{ result_json: string }>();
    return row ? (JSON.parse(row.result_json) as AuditResponse) : null;
  }

  async put(result: AuditResponse): Promise<AuditResponse> {
    await this.db
      .prepare(
        "INSERT INTO audits (audit_id, run_id, created_at, budget, seed, input_hash, synthetic, result_json) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (audit_id) DO NOTHING",
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
      )
      .run();
    return (await this.get(result.audit_id)) ?? result;
  }
}
