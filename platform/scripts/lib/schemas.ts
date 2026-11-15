/**
 * Ajv (draft 2020-12) loaded with every schema in contracts/schemas under its own $id, so cross-file $refs
 * (`../common.schema.json#/$defs/…`) resolve locally and nothing is fetched (CONTRACTS.md, schemas/).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020Module from "ajv/dist/2020.js";
import type { Options } from "ajv";

export const SCHEMA_BASE = "https://mudskipper.invalid/schemas/v1/";
export const SCHEMA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "contracts", "schemas");

type AjvCtor = new (opts: Options) => import("ajv").default;
const Ajv2020: AjvCtor =
  (Ajv2020Module as unknown as { default?: AjvCtor }).default ?? (Ajv2020Module as unknown as AjvCtor);

function walk(dir: string): string[] {
  return readdirSync(dir)
    .sort()
    .flatMap((name) => {
      const p = join(dir, name);
      return statSync(p).isDirectory() ? walk(p) : name.endsWith(".schema.json") ? [p] : [];
    });
}

export function createSchemaAjv(extra: Options = {}) {
  // strictSchema catches typos in keywords; the type/tuple/required checks are Ajv-only lint rules that the
  // shared schemas (also used by Python's jsonschema) deliberately do not follow (e.g. `allOf` + `required`).
  const ajv = new Ajv2020({
    strictSchema: true,
    strictNumbers: true,
    strictTuples: false,
    strictTypes: false,
    strictRequired: false,
    allowUnionTypes: true,
    allErrors: false,
    ...extra,
  });
  for (const file of walk(SCHEMA_DIR)) {
    const schema = JSON.parse(readFileSync(file, "utf8")) as { $id?: string };
    const expected = SCHEMA_BASE + relative(SCHEMA_DIR, file).split("\\").join("/");
    if (schema.$id !== expected) throw new Error(`${file}: $id must be ${expected}`);
    ajv.addSchema(schema);
  }
  return { ajv, base: SCHEMA_BASE };
}

/** Validate a document against a schema path like "api/meta.schema.json"; returns error strings. */
export function validatorFor(ajv: ReturnType<typeof createSchemaAjv>["ajv"], rel: string) {
  const fn = ajv.getSchema(SCHEMA_BASE + rel);
  if (!fn) throw new Error(`unknown schema ${rel}`);
  return (doc: unknown): string[] =>
    fn(doc) ? [] : (fn.errors ?? []).map((e: { instancePath: string; message?: string }) => `${e.instancePath || "/"} ${e.message ?? "invalid"}`);
}
