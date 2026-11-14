# core/ — the one implementation of the rules

**Owner:** Karthik · **Language:** TypeScript, zero runtime dependencies ·
**Prompt:** [SPEC Lane Karthik](../docs/SPEC.md#lane-karthik-backend--connectivity-platform-core-geo) step 4

`types.ts` (generated from `contracts/schemas`), `sim.ts`, `verdicts.ts`, `rank.ts`, `story.ts`, and
`client.ts` (typed API client with an `api | fixtures` switch). Used by the publish script (Node), the Worker
(ranking for uploads) and the app (the Lab runs the simulation live).

**Definition of done:** core reproduces every rule output in `contracts/fixtures/` exactly. That covers
`detectability.json`, every `field_summary.jsonl` line, `story.json`, and `api/audit.response.json` from
`api/audit.request.json`. It also passes the PRNG vectors in `contracts/tests/test_rules.py`. That
golden test is how SPEC A4's "the rules exist once" stays true while `contracts/rules.py` exists as a reference
([DECISIONS.md D-007](../DECISIONS.md)).

Not started yet. Lane work begins after `v0-foundation`.
