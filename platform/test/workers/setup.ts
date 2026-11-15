// Runs before every workers test file: schema in D1, the fixture run loaded by the loader's own code, tiles in R2.
import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll } from "vitest";
import { loadFixtureIntoD1, uploadTilesToR2 } from "./helpers.ts";

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await loadFixtureIntoD1();
  await uploadTilesToR2();
});
