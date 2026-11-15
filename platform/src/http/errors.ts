/** The one error shape (schema api/error): `{"error":{"code","message"}}` with a 4xx/5xx status. */

export type ErrorCode =
  // CONTRACTS.md B6 audit codes
  | "invalid_json"
  | "invalid_request"
  | "too_large"
  | "too_many_claims"
  | "duplicate_claim_id"
  | "invalid_geometry"
  // routing and storage
  | "not_found"
  | "method_not_allowed"
  | "range_not_satisfiable"
  | "no_live_run"
  | "storage_unavailable"
  | "internal";

export class ApiError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly headers: Record<string, string>;

  constructor(status: number, code: ErrorCode, message: string, headers: Record<string, string> = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.headers = headers;
  }
}

export function errorBody(code: string, message: string): { error: { code: string; message: string } } {
  return { error: { code, message } };
}

export const notFound = (message: string) => new ApiError(404, "not_found", message);
export const badRequest = (message: string) => new ApiError(400, "invalid_request", message);
