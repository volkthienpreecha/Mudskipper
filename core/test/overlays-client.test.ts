import { describe, expect, it } from "vitest";
import { createClient } from "../src/client.ts";
import { nodeFixtureLoader } from "../src/fixtures-node.ts";
import { viteFixtureLoader } from "../src/fixtures-vite.ts";
import { fixtureJson } from "./helpers.ts";

describe("published radar overlay index", () => {
  it.each([nodeFixtureLoader(), viteFixtureLoader])(
    "loads the indexed fixture overlays without shared mutation",
    async (load) => {
      const client = createClient({ source: "fixtures", load });
      const first = await client.getOverlaysIndex();
      expect(first).toEqual(fixtureJson("run/overlays/index.json"));
      first!.overlays.length = 0;
      expect((await client.getOverlaysIndex())!.overlays).toHaveLength(3);
    },
  );

  it("follows the current run's asset URL", async () => {
    const calls: string[] = [];
    const meta = fixtureJson<any>("api/meta.json");
    const client = createClient({
      source: "api",
      baseUrl: "https://example.com",
      fetch: (async (url) => {
        calls.push(String(url));
        return Response.json(
          String(url).endsWith("/api/meta")
            ? meta
            : fixtureJson("run/overlays/index.json"),
        );
      }) as typeof fetch,
    });
    expect((await client.getOverlaysIndex())!.run_id).toBe("fixture");
    expect(calls).toEqual([
      "https://example.com/api/meta",
      "https://example.com" + meta.assets.overlays_index,
    ]);
  });

  it("returns null when the run has no overlay index", async () => {
    const meta = fixtureJson<any>("api/meta.json");
    meta.assets.overlays_index = null;
    let calls = 0;
    const client = createClient({
      source: "api",
      fetch: (async () => {
        calls++;
        return Response.json(meta);
      }) as typeof fetch,
    });
    expect(await client.getOverlaysIndex()).toBeNull();
    expect(calls).toBe(1);
  });

  it("surfaces a missing published asset instead of treating it as optional absence", async () => {
    const meta = fixtureJson<any>("api/meta.json");
    const client = createClient({
      source: "api",
      fetch: (async (url) =>
        String(url).endsWith("/api/meta")
          ? Response.json(meta)
          : Response.json(
              { error: { code: "not_found", message: "Missing image index" } },
              { status: 404 },
            )) as typeof fetch,
    });
    await expect(client.getOverlaysIndex()).rejects.toMatchObject({
      status: 404,
    });
  });

  it("surfaces backend failure instead of substituting fixture imagery", async () => {
    const client = createClient({
      source: "api",
      fetch: (async () =>
        Response.json(
          { error: { code: "internal_error", message: "Unavailable" } },
          { status: 500 },
        )) as typeof fetch,
    });
    await expect(client.getOverlaysIndex()).rejects.toMatchObject({
      status: 500,
    });
  });
});
