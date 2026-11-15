// Structural types for the Workers bindings and modules the platform uses, mirroring workerd's signatures.
//
// Why not workerd's generated runtime types: the platform imports @mudskipper/core as TypeScript source, and
// core is written against the web-standard `lib: WebWorker` set (DECISIONS.md K-202). workerd's runtime types
// differ in small ways (TextDecoder options, TextEncoder's buffer type), so they reject core's source. Both
// tsconfig projects therefore use `lib: WebWorker`/Node plus this subset; `wrangler types --include-runtime=false`
// still generates the Env interface from wrangler.jsonc and CI checks it for drift.
interface D1Result<T = Record<string, unknown>> {
  results: T[];
  success: boolean;
  meta: { rows_written?: number; rows_read?: number; changes?: number; duration?: number };
}
interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(column?: string): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  run<T = Record<string, unknown>>(): Promise<D1Result<T>>;
}
interface D1Database {
  prepare(sql: string): D1PreparedStatement;
  batch<T = Record<string, unknown>>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
  exec(sql: string): Promise<unknown>;
}
interface KVNamespace {
  get(key: string): Promise<string | null>;
  get<T>(key: string, type: "json"): Promise<T | null>;
  put(key: string, value: string | ArrayBuffer | ReadableStream, options?: { metadata?: unknown; expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}
interface R2HTTPMetadata {
  contentType?: string;
  cacheControl?: string;
}
interface R2Object {
  key: string;
  size: number;
  etag: string;
  httpEtag: string;
  uploaded: Date;
  httpMetadata?: R2HTTPMetadata;
}
interface R2ObjectBody extends R2Object {
  body: ReadableStream;
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
  json<T>(): Promise<T>;
}
interface R2Bucket {
  head(key: string): Promise<R2Object | null>;
  get(key: string, options?: { range?: { offset: number; length?: number } | { suffix: number } }): Promise<R2ObjectBody | null>;
  /** With a failed `onlyIf` precondition, the object comes back without a body. */
  get(
    key: string,
    options: { range?: { offset: number; length?: number } | { suffix: number }; onlyIf: { etagMatches?: string } },
  ): Promise<R2ObjectBody | R2Object | null>;
  put(
    key: string,
    value: string | ArrayBuffer | ArrayBufferView | ReadableStream | null,
    options?: { httpMetadata?: R2HTTPMetadata },
  ): Promise<R2Object | null>;
}
interface Fetcher {
  fetch(input: string | Request | URL, init?: RequestInit): Promise<Response>;
}

declare module "cloudflare:workers" {
  export const env: Cloudflare.Env;
}
