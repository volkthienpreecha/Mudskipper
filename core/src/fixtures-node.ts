/**
 * Fixture loader for Node (tests, scripts, the publish script's `--fixtures` dry runs):
 *
 *   import { createClient } from "@mudskipper/core/client";
 *   import { nodeFixtureLoader } from "@mudskipper/core/fixtures-node";
 *   const client = createClient({ source: "fixtures", load: nodeFixtureLoader() });
 *
 * Kept out of the main entry and of `@mudskipper/core/client` so that browser and Worker bundles never see
 * `node:` imports.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { FixtureLoader } from "./client.ts";
import { parseJsonl } from "./json.ts";

/** contracts/fixtures in this repository. */
export const DEFAULT_FIXTURES_DIR = fileURLToPath(new URL("../../contracts/fixtures/", import.meta.url));

/** Reads `<root>/<name>` and parses it (`.jsonl` into an array of lines). */
export function nodeFixtureLoader(root: string = DEFAULT_FIXTURES_DIR): FixtureLoader {
  const base = root.endsWith("/") ? root : root + "/";
  return async (name) => {
    const text = await readFile(base + name, "utf8");
    return name.endsWith(".jsonl") ? parseJsonl(text) : JSON.parse(text);
  };
}
