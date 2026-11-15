/**
 * A tiny JSON Schema (draft 2020-12) validator for tests: exactly the keywords contracts/schemas use, with
 * $ref resolved against the local files. It keeps core free of a validator dependency; the authoritative
 * check is still contracts/validate.py (jsonschema), which CI runs on core's outputs.
 */
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SCHEMAS = new URL("../../contracts/schemas/", import.meta.url);
type Schema = boolean | Record<string, unknown>;

const docs = new Map<string, Record<string, unknown>>();
for (const f of readdirSync(fileURLToPath(SCHEMAS), { recursive: true }).map(String)) {
  if (f.endsWith(".schema.json")) docs.set(f.split("\\").join("/"), JSON.parse(readFileSync(new URL(f, SCHEMAS), "utf8")));
}
const KNOWN = new Set([
  "$schema", "$id", "$defs", "$ref", "title", "description", "type", "enum", "const", "pattern", "minimum", "maximum",
  "exclusiveMinimum", "minLength", "maxLength", "items", "prefixItems", "minItems", "maxItems", "uniqueItems", "properties",
  "required", "additionalProperties", "propertyNames", "anyOf", "oneOf", "allOf", "if", "then", "else",
]);

function resolve(ref: string, base: string): { schema: Schema; base: string } {
  const [path, pointer = ""] = ref.split("#");
  let file = base;
  if (path) {
    const parts = base.split("/").slice(0, -1);
    for (const seg of path.split("/")) {
      if (seg === "..") parts.pop();
      else if (seg !== ".") parts.push(seg);
    }
    file = parts.join("/");
  }
  let node: unknown = docs.get(file);
  if (node === undefined) throw new Error(`schema ${file} not found (ref ${ref} from ${base})`);
  for (const key of pointer.split("/").filter(Boolean)) node = (node as Record<string, unknown>)[key];
  if (node === undefined) throw new Error(`bad $ref ${ref} from ${base}`);
  return { schema: node as Schema, base: file };
}

const typeOf = (v: unknown): string =>
  v === null ? "null" : Array.isArray(v) ? "array" : typeof v === "number" ? (Number.isInteger(v) ? "integer" : "number") : typeof v;
const typeMatches = (v: unknown, t: string): boolean => {
  const actual = typeOf(v);
  return actual === t || (t === "number" && actual === "integer");
};
const equal = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

function check(v: unknown, s: Schema, base: string, path: string, errs: string[]): void {
  if (s === true) return;
  if (s === false) {
    errs.push(`${path}: not allowed`);
    return;
  }
  for (const k of Object.keys(s)) if (!KNOWN.has(k)) throw new Error(`schema keyword ${k} not supported by test/schema.ts`);
  if (typeof s.$ref === "string") {
    const r = resolve(s.$ref, base);
    check(v, r.schema, r.base, path, errs);
  }
  if (s.type !== undefined) {
    const types = Array.isArray(s.type) ? (s.type as string[]) : [s.type as string];
    if (!types.some((t) => typeMatches(v, t))) {
      errs.push(`${path}: expected ${types.join("|")}, got ${typeOf(v)}`);
      return;
    }
  }
  if (s.enum && !(s.enum as unknown[]).some((e) => equal(e, v))) errs.push(`${path}: ${JSON.stringify(v)} not in enum`);
  if ("const" in s && !equal(s.const, v)) errs.push(`${path}: must be ${JSON.stringify(s.const)}`);
  if (typeof v === "string") {
    if (typeof s.pattern === "string" && !new RegExp(s.pattern, "u").test(v)) errs.push(`${path}: ${JSON.stringify(v)} !~ ${s.pattern}`);
    if (typeof s.minLength === "number" && [...v].length < s.minLength) errs.push(`${path}: too short`);
    if (typeof s.maxLength === "number" && [...v].length > s.maxLength) errs.push(`${path}: too long`);
  }
  if (typeof v === "number") {
    if (!Number.isFinite(v)) errs.push(`${path}: non-finite`);
    if (typeof s.minimum === "number" && v < s.minimum) errs.push(`${path}: ${v} < ${s.minimum}`);
    if (typeof s.maximum === "number" && v > s.maximum) errs.push(`${path}: ${v} > ${s.maximum}`);
    if (typeof s.exclusiveMinimum === "number" && v <= s.exclusiveMinimum) errs.push(`${path}: ${v} <= ${s.exclusiveMinimum}`);
  }
  if (Array.isArray(v)) {
    const prefix = (s.prefixItems as Schema[] | undefined) ?? [];
    prefix.forEach((ps, i) => i < v.length && check(v[i], ps, base, `${path}[${i}]`, errs));
    if (s.items !== undefined) for (let i = prefix.length; i < v.length; i++) check(v[i], s.items as Schema, base, `${path}[${i}]`, errs);
    if (typeof s.minItems === "number" && v.length < s.minItems) errs.push(`${path}: fewer than ${s.minItems} items`);
    if (typeof s.maxItems === "number" && v.length > s.maxItems) errs.push(`${path}: more than ${s.maxItems} items`);
    if (s.uniqueItems === true && new Set(v.map((x) => JSON.stringify(x))).size !== v.length) errs.push(`${path}: items not unique`);
  }
  if (v !== null && typeof v === "object" && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    const props = (s.properties as Record<string, Schema> | undefined) ?? {};
    for (const r of (s.required as string[] | undefined) ?? []) if (!(r in o)) errs.push(`${path}: missing ${r}`);
    for (const [k, val] of Object.entries(o)) {
      if (s.propertyNames !== undefined) check(k, s.propertyNames as Schema, base, `${path}{${k}}`, errs);
      if (k in props) check(val, props[k]!, base, `${path}.${k}`, errs);
      else if (s.additionalProperties !== undefined) check(val, s.additionalProperties as Schema, base, `${path}.${k}`, errs);
    }
  }
  if (s.allOf) for (const sub of s.allOf as Schema[]) check(v, sub, base, path, errs);
  if (s.anyOf && !(s.anyOf as Schema[]).some((sub) => errorsFor(v, sub, base, path).length === 0)) errs.push(`${path}: matches no anyOf branch`);
  if (s.oneOf && (s.oneOf as Schema[]).filter((sub) => errorsFor(v, sub, base, path).length === 0).length !== 1) {
    errs.push(`${path}: must match exactly one oneOf branch`);
  }
  if (s.if !== undefined) {
    const branch = errorsFor(v, s.if as Schema, base, path).length === 0 ? s.then : s.else;
    if (branch !== undefined) check(v, branch as Schema, base, path, errs);
  }
}

function errorsFor(v: unknown, s: Schema, base: string, path: string): string[] {
  const errs: string[] = [];
  check(v, s, base, path, errs);
  return errs;
}

/** Errors of `value` against `contracts/schemas/<name>.schema.json` (e.g. `api/field_detail`); [] if valid. */
export function schemaErrors(name: string, value: unknown): string[] {
  const file = `${name}.schema.json`;
  const doc = docs.get(file);
  if (!doc) throw new Error(`no schema ${file}`);
  return errorsFor(value, doc, file, "$");
}
