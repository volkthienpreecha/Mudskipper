# platform/ — Cloudflare Worker, D1, R2, publish, CI

**Owner:** Karthik · **Prompt:** [SPEC Lane Karthik](../docs/SPEC.md#lane-karthik-backend--connectivity-platform-core-geo) steps 2 and 5

- `wrangler.jsonc` (SPEC B7): one Worker serves `app/dist` and runs first on `/api/*` and `/tiles/*`.
- `migrations/0001_init.sql` (SPEC B4).
- `src/` Hono routes for every endpoint in [CONTRACTS.md B6](../contracts/CONTRACTS.md#b6-http-api).
  Response shapes are pinned by `contracts/schemas/api/` and by examples in `contracts/fixtures/api/`.
- `scripts/publish.ts`: validate → run core → upload to R2 → idempotent D1 load → flip `live.json`
  (`make publish RUN_ID=r01`, or `make publish FIXTURES=1`).

Not started yet. Lane work begins after `v0-foundation`.
