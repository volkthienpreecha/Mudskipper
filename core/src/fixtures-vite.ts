/**
 * Fixture loader for the Vite app. Every fixture file becomes its own lazy chunk (`import.meta.glob`
 * without `eager`), fetched only when a client call needs it.
 *
 * Use it behind the build-time switch so API builds ship no fixture data at all; Vite replaces
 * `import.meta.env.VITE_DATA_SOURCE` at build time and drops the dead branch together with this module:
 *
 *   import { createClient } from "@mudskipper/core/client";
 *
 *   export const client =
 *     import.meta.env.VITE_DATA_SOURCE === "fixtures"
 *       ? createClient({ source: "fixtures", load: (await import("@mudskipper/core/fixtures-vite")).viteFixtureLoader })
 *       : createClient({ source: "api" });
 *
 * The glob paths are relative to this file (core/src/), so they work from any importer. Vite allows serving
 * them because they sit inside the npm workspace root.
 */
import type { FixtureLoader, FixtureName } from "./client.ts";
import { parseJsonl } from "./json.ts";

type Modules = Record<string, () => Promise<unknown>>;

// Vite rewrites these calls at build time. Core's own type check runs without vite/client types, so
// `import.meta.glob` is unknown there; the app's check (with vite/client) sees the real signature.
// @ts-ignore -- import.meta.glob is provided by Vite
const jsonModules: Modules = import.meta.glob(["../../contracts/fixtures/api/*.json", "../../contracts/fixtures/run/*.json"], {
  import: "default",
});
// .geojson and .jsonl are not JSON modules for Vite: load them as text.
// @ts-ignore -- import.meta.glob is provided by Vite
const textModules: Modules = import.meta.glob(["../../contracts/fixtures/run/*.geojson", "../../contracts/fixtures/run/*.jsonl"], {
  query: "?raw",
  import: "default",
});

const PREFIX = "../../contracts/fixtures/";

export const viteFixtureLoader: FixtureLoader = async (name: FixtureName) => {
  const key = PREFIX + name;
  const json = jsonModules[key];
  if (json) return json();
  const text = textModules[key];
  if (!text) throw new Error(`no fixture ${name} in the Vite bundle`);
  const raw = (await text()) as string;
  return name.endsWith(".jsonl") ? parseJsonl(raw) : JSON.parse(raw);
};
