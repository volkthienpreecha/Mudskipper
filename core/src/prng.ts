/**
 * Seeded randomness (CONTRACTS.md B3.6a). Python reference: `rules.Mulberry32`, `rules.fnv1a32`,
 * `rules.derive`. The vectors in contracts/tests/test_rules.py pin both languages to one sequence.
 */

const encoder = new TextEncoder();

/**
 * mulberry32 on a uint32 state; each call returns `uint32 / 2^32` in [0, 1).
 * `seed` is reduced to a uint32 first (mod 2^32), as Python's `seed & 0xFFFFFFFF` does.
 */
export function mulberry32(seed: number): () => number {
  if (!Number.isInteger(seed)) throw new RangeError(`mulberry32 seed must be an integer, got ${seed}`);
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t = (t + Math.imul(t ^ (t >>> 7), t | 61)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a, 32 bit, over the UTF-8 bytes of `text` (offset basis 2166136261, prime 16777619). */
export function fnv1a32(text: string): number {
  let h = 0x811c9dc5;
  for (const byte of encoder.encode(text)) {
    h ^= byte;
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** `derive(seed, key) = fnv1a32(String(seed) + "|" + key)`: one independent stream per purpose. */
export function derive(seed: number, key: string): number {
  if (!Number.isInteger(seed)) throw new RangeError(`derive seed must be an integer, got ${seed}`);
  return fnv1a32(`${seed}|${key}`);
}
