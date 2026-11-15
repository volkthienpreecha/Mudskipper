// The Node scripts import shared src/ modules (shapes, D1 plan, repositories) that mention Workers binding
// types. workerd's global types (worker-configuration.d.ts) clash with @types/node, so the scripts project
// gets this structural subset instead. The real types still check src/ in tsconfig.json.
interface D1Result<T = Record<string, unknown>> {
  results: T[];
  meta: { rows_written?: number; changes?: number };
}
interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  run(): Promise<D1Result>;
}
interface D1Database {
  prepare(sql: string): D1PreparedStatement;
  batch<T = Record<string, unknown>>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
}
interface KVNamespace {
  get<T>(key: string, type: "json"): Promise<T | null>;
  put(key: string, value: string, options?: { metadata?: unknown }): Promise<void>;
}
interface R2Object {
  size: number;
  httpEtag: string;
  httpMetadata?: { contentType?: string };
}
interface R2ObjectBody extends R2Object {
  body: ReadableStream;
  json<T>(): Promise<T>;
}
interface R2Bucket {
  head(key: string): Promise<R2Object | null>;
  get(key: string, options?: { range?: { offset: number; length?: number } }): Promise<R2ObjectBody | null>;
}
interface Fetcher {
  fetch(input: string | Request | URL, init?: RequestInit): Promise<Response>;
}
