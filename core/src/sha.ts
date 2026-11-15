/**
 * SHA-256 through WebCrypto (`crypto.subtle`), which browsers, workerd and Node (global `crypto`) all have.
 * WebCrypto is async-only, which is why `rank` is async.
 */

const encoder = new TextEncoder();

/** Lowercase hex SHA-256 of the bytes, or of the UTF-8 encoding of a string. */
export async function sha256Hex(data: ArrayBuffer | Uint8Array<ArrayBuffer> | string): Promise<string> {
  const bytes = typeof data === "string" ? encoder.encode(data) : data;
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  let hex = "";
  for (const b of new Uint8Array(digest)) hex += b.toString(16).padStart(2, "0");
  return hex;
}
