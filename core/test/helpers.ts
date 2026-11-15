import { readFileSync } from "node:fs";
import { parseJsonl } from "../src/json.ts";

export const FIXTURES = new URL("../../contracts/fixtures/", import.meta.url);

export const fixtureText = (name: string): string => readFileSync(new URL(name, FIXTURES), "utf8");
export const fixtureBytes = (name: string): Uint8Array<ArrayBuffer> => new Uint8Array(readFileSync(new URL(name, FIXTURES)));
export const fixtureJson = <T = unknown>(name: string): T => JSON.parse(fixtureText(name)) as T;
export const fixtureJsonl = <T = unknown>(name: string): T[] => parseJsonl<T>(fixtureText(name));

/**
 * Cross-language golden comparison (CONTRACTS.md C0 "Cross-language equality"): parsed JSON values, numbers
 * compared with `===` (Python's `1.0` and JavaScript's `1` parse to the same double), strings, booleans and
 * null exactly, object keys as sets, arrays element by element. Returns the first difference, or null.
 */
export function firstDifference(actual: unknown, expected: unknown, path = "$"): string | null {
  if (typeof expected === "number") {
    if (typeof actual !== "number") return `${path}: expected number ${expected}, got ${JSON.stringify(actual)}`;
    return actual === expected ? null : `${path}: ${actual} !== ${expected}`;
  }
  if (expected === null || typeof expected !== "object") {
    return actual === expected ? null : `${path}: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`;
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return `${path}: expected an array`;
    if (actual.length !== expected.length) return `${path}: length ${actual.length} !== ${expected.length}`;
    for (let i = 0; i < expected.length; i++) {
      const d = firstDifference(actual[i], expected[i], `${path}[${i}]`);
      if (d) return d;
    }
    return null;
  }
  if (actual === null || typeof actual !== "object" || Array.isArray(actual)) return `${path}: expected an object`;
  const a = actual as Record<string, unknown>;
  const e = expected as Record<string, unknown>;
  const ak = Object.keys(a).sort();
  const ek = Object.keys(e).sort();
  if (ak.join("\u0000") !== ek.join("\u0000")) return `${path}: keys [${ak.join(", ")}] !== [${ek.join(", ")}]`;
  for (const k of ek) {
    const d = firstDifference(a[k], e[k], `${path}.${k}`);
    if (d) return d;
  }
  return null;
}

/** Throws with the path of the first difference. */
export function assertSameJson(actual: unknown, expected: unknown, label = ""): void {
  const d = firstDifference(actual, expected);
  if (d) throw new Error(`${label ? label + ": " : ""}${d}`);
}
