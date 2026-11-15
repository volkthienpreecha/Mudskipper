# core/ — the one implementation of the rules

`typescript` `zero-dependencies` `deterministic` `golden-tested` `browser · workerd · node`

**Owner:** Karthik · **Prompt:** [SPEC Lane Karthik](../docs/SPEC.md#lane-karthik-backend--connectivity-platform-core-geo) step 4 ·
**Contract:** [CONTRACTS.md](../contracts/CONTRACTS.md)

Mudskipper makes claims about rice fields from radar, so the rules that turn radar looks into verdicts must
be written down once and run the same everywhere. That is this package (SPEC A4). The simulation, the
verdicts, the DSR signal, the story headline, the map's state grid and the inspection ranking live here,
in plain TypeScript with no runtime dependencies. Three runtimes run this one copy:

```
                 contracts/schemas ──gen──▶ src/contracts.gen.ts (types)
                                                  │
 ┌──────────────── @mudskipper/core ──────────────┴───────────────────────────────┐
 │ prng · time · format ─▶ sim ─▶ verdicts ─▶ states · story ─▶ compute          │
 │ geometry · sha ───────────────▶ rank                     judges · params      │
 │ client (api | fixtures)    fixtures-vite (app)    fixtures-node (Node)        │
 └───────┬─────────────────────────┬──────────────────────────────┬──────────────┘
         ▼                         ▼                              ▼
   app/ (browser)            platform/ (workerd)           compute-run / publish (Node)
   Lab runs simulate live    POST /api/audit runs rank     writes detectability, summaries,
   every screen uses client  and validateAuditRequest      states, story, provenance list
```

`contracts/rules.py` is a Python *reference* of the same rules, used to build the fixtures and to validate
any run. It is not a second implementation: core's tests must reproduce it bit for bit, and CI proves it
three ways (see [Golden-test policy](#golden-test-policy)).

## Use it

core is consumed as TypeScript source (no build step). Vite, Wrangler and Node 24 all run it directly.

```ts
import { simulate, detectability, fieldSummary, rank, story, states, JUDGES, DEFAULT_PARAMS } from "@mudskipper/core";
import type { FieldDetail, AuditResponse, Verdict } from "@mudskipper/core";         // or "@mudskipper/core/contracts"
import { createClient, ApiError } from "@mudskipper/core/client";
```

| Entry point | What | Runs in |
|---|---|---|
| `@mudskipper/core` | every rule, constant and helper below, plus all contract types | browser, workerd, Node |
| `@mudskipper/core/client` | `createClient`, `ApiError`, `FIXTURE_FILES`, `PAGE_SIZE` | browser, workerd, Node |
| `@mudskipper/core/contracts` | the generated types only | types |
| `@mudskipper/core/fixtures-vite` | `viteFixtureLoader` (lazy `import.meta.glob`) | Vite app |
| `@mudskipper/core/fixtures-node` | `nodeFixtureLoader(root?)` | Node |

A test walks the imports of the main entry and the client and fails if anything reaches `node:` modules,
`import.meta.glob` or a package, so neither drags Node or Vite into a browser or Worker bundle.

## For Volk: the data client

The app never calls `fetch`. It calls the client, and `source` decides where data comes from (SPEC B6).

```ts
// app/src/data.ts
import { createClient } from "@mudskipper/core/client";

export const client =
  import.meta.env.VITE_DATA_SOURCE === "fixtures"
    ? createClient({ source: "fixtures", load: (await import("@mudskipper/core/fixtures-vite")).viteFixtureLoader })
    : createClient({ source: "api" }); // same origin; or { source: "api", baseUrl: "https://mudskipper-nisar.pages.dev" }
```

Vite replaces `import.meta.env.VITE_DATA_SOURCE` at build time and drops the unused branch. Checked with a
Vite 8.3.8 build: with `VITE_DATA_SOURCE=fixtures` every fixture file becomes its own lazy chunk; the API
build contains no fixture bytes at all.

| Method | Endpoint | Returns |
|---|---|---|
| `getHealth()` | `GET /api/health` | `Health` |
| `getMeta()` | `GET /api/meta` | `Meta` (season, stages, gaps, tiles, assets, Limits text) |
| `getStory()` | `GET /api/story` | `Served<Story>` |
| `getPasses()` | `GET /api/passes` | `Served<Passes>` |
| `getStates()` | `GET /api/states` | `Served<States>`: one `F`/`D`/`U`/`-` string per field for the season animation |
| `getFields({ tile?, verdict?, page? })` | `GET /api/fields` | `FieldsPage`: 500 per page, ordered by `field_id` |
| `getField(id)` | `GET /api/fields/:id` | `FieldDetail`: properties, geometry, observations by time, summary |
| `getDetectability()` | `GET /api/detectability` | `Served<Detectability>` (params, citations, `dist` for the Lab charts, sentence) |
| `getChecks()` | `GET /api/checks` | `ApiChecks` (season shape, OPERA, district table) |
| `getProvenance()` | `GET /api/provenance` | `Served<Provenance>` |
| `postAudit(body)` | `POST /api/audit` | `AuditResponse`. A string body is sent and hashed byte for byte; an object is sent as `JSON.stringify(body)` |
| `getAudit(id)` | `GET /api/audit/:id` | `AuditResponse` |
| `getClaimsSample()` | `meta.assets.claims_sample` | `Claims` (the 60 SYNTHETIC sample claims) |
| `getFieldsGeoJson()` | `meta.assets.fields_geojson` | `FieldCollection` |

`Served<T>` is `T` with `fixture: boolean` required: every API response carries it, and the SAMPLE DATA
badge reads it (T8). Errors are always `ApiError { status, code, message }`. `code` is the contract's code
(`not_found`, `invalid_json`, `invalid_request`, `too_large`, `too_many_claims`, `duplicate_claim_id`,
`invalid_geometry`), or `http_<status>` when the server sent no contract error body, `network_error`
(status 0) or `invalid_response`.

**Fixtures mode answers exactly like the API**, from `contracts/fixtures/api/` plus `run/`: fields are
filtered and paged in memory (invalid `page`, `tile` or `verdict` → 400; past the last page → an empty page),
the detail of *any* of the 300 fields is built from `run/fields.geojson`, `observations.jsonl` and
`field_summary.jsonl`, and `postAudit` runs core's `rank` on the same bytes the Worker would hash, so
`postAudit(<text of audit.request.json>)` returns `audit.response.json` exactly. Results are copies, so
mutating one never changes the next.

**The Scarecrow sample ranking in the browser** may skip the client and call `rank` directly (B6 step 8):
pass an explicit `seed`, and do not show its `audit_id`, because it is not a stored audit.

```ts
import { rank, readAuditBody, validateAuditRequest } from "@mudskipper/core";
const { request, inputHash } = await readAuditBody(JSON.stringify({ claims, budget: 20, seed: 7 }));
const result = await rank(validateAuditRequest(request), inputHash, fields.features, summariesById, runId, createdAt, true);
```

**The Lab** runs the simulation live: `simulate(looks, params, nSim, seed, "awd" | "cf")` returns counts,
`ge(counts, k)` the probability of at least `k` drained labels, `kStarFrom(cfCounts, 0.1)` the threshold,
and `sentence(...)` the one live sentence. 4,000 runs over 10 looks take about a millisecond.

## For the platform: Worker and publish

```ts
// POST /api/audit in the Worker
import { rank, readAuditBody, validateAuditRequest, RankError } from "@mudskipper/core";
try {
  const { request, inputHash } = await readAuditBody(new Uint8Array(await req.arrayBuffer()));
  const out = await rank(validateAuditRequest(request), inputHash, fields, summaries, runId, nowIso, fixture);
} catch (err) {
  if (err instanceof RankError) return c.json({ error: { code: err.code, message: err.message } }, err.status);
  throw err;
}
```

`readAuditBody` enforces the 5 MiB limit (413 `too_large`) and parses strict UTF-8 JSON; `validateAuditRequest`
checks `api/audit_request.schema.json` and the 5,000-claim limit with no dependencies; `rank` adds
`duplicate_claim_id` and `invalid_geometry`. `RankError.status` is the HTTP status.

The publish script runs `computeRun` (or the CLI below) and then uploads:

```sh
node core/scripts/compute-run.ts artifacts/r01            # writes the 4 outputs and re-lists provenance artifacts
node core/scripts/compute-run.ts artifacts/r01 --out DIR  # outputs elsewhere; provenance untouched
#   --seed N --n-sim N    override DEFAULT_SEED (20261114) and DEFAULT_N_SIM (4000)
```

`computeRun({ aoi, fields, passes, observations, runId, fixture?, params?, paramSources?, seed?, nSim? })`
returns `{ detectability, summaries, states, story }`; `provenanceArtifacts(files)` and `withArtifacts` produce
the B3.9 list; `dumpJson`, `dumpJsonl` and `dumpStates` write deterministic, finite-only JSON (T2).

## Rules reference

| Module | Exports | Contract |
|---|---|---|
| `prng.ts` | `mulberry32(seed)`, `fnv1a32(text)`, `derive(seed, key)` | B3.6a |
| `time.ts` | `parseMs`, `fmtDt`, `days`, `stageOf`, `inGap`, `DAY_MS` | C0, B3.1 |
| `format.ts` | `pct` (half up), `pctDown` (floor), `looksText`, `allLooksText`, `passesText`, `timesText` | C0, B3.5 |
| `sim.ts` | `simulate`, `ge`, `kStarFrom`, `detectability`, `sentence`, `K_STAR_RULE` | B3.6, B3.6a |
| `verdicts.ts` | `uncertainState`, `confidenceFrom`, `awdVerdict`, `awdReason`, `dsrSignal`, `clearLooks`, `fieldSummary` | B3.4, B3.5 |
| `states.ts` | `states(fieldIds, passes, observations, runId, fixture?)` | B3.13 |
| `story.ts` | `story(aoi, fieldProps, summaries, usedPasses, runId, fixture?)` | B3.11 |
| `geometry.ts` | `planarArea`, `representativePoint`, `contains`, `inRing`, `checkRings`, `bboxOf`, `bboxMayContain` | B6 step 1 |
| `field-index.ts` | `fieldIndex(fields, { boxes?, cellDeg? })`: a uniform grid whose `locate(x, y)` returns exactly the linear scan's field (smallest `field_id` containing the point); `rank` accepts it in place of the field list | B6 step 1 |
| `rank.ts` | `rank`, `readAuditBody`, `validateAuditRequest`, `seedFor`, `RankError`, weights and limits | B6 |
| `sha.ts` | `sha256Hex(data)` via WebCrypto | B6 step 8 |
| `params.ts` | `DEFAULT_PARAMS`, `DEFAULT_PARAM_SOURCES`, `DEFAULT_SEED`, `DEFAULT_N_SIM` | B3.6 |
| `compute.ts` | `computeRun`, `provenanceArtifacts`, `withArtifacts` | B3, B3.9 |
| `judges.ts` | `JUDGES` | WIN_GUIDE §8 |

Arithmetic is plain IEEE-754 doubles in exactly the order CONTRACTS.md writes it, probabilities are one
integer sum and one division, sorts compare UTF-16 code units, and ranking uses no trigonometry. Please
do not "simplify" an expression in `sim.ts`: reassociating it changes the last bit and the golden tests
will say so. `DEFAULT_PARAMS` mirrors `contracts/make_fixtures.py`; `drained_fraction_of_cycle` is still
`needs_citation`, so a real run fails validation until Ishaan cites or changes it (change both files in one
commit).

## Evidence tags and `/judges`

Every number the app shows carries one tag (SPEC evidence rule, T12); the tag per artifact field is fixed in
[`contracts/evidence_tags.json`](../contracts/evidence_tags.json), and ASSUMED values take their citation from
`detectability.param_sources`. `JUDGES` is the `/judges` table: five criteria (Impact, Creativity, Validity,
Relevance, Presentation), each with the README's "what we show" text, one sentence, one deep link
(`/scarecrow`, `/lab`, `/evidence`, `/map`, `/?tour=1`) and a `numbers` list that tags every number it
contains, with its source. Render the chip next to `numbers[i].text`.

## Golden-test policy

The rules exist once, and these checks keep it that way (DECISIONS.md D-007):

1. **Golden fixtures** (`test/golden.test.ts`): core reproduces `detectability.json` (results and sentence),
   all 300 `field_summary.jsonl` lines, `states.json`, `story.json` and `api/audit.response.json` from the
   exact bytes of `api/audit.request.json`; `computeRun` on the fixture inputs equals every fixture output.
   Values are compared parsed, numbers with `===` (Python writes `1.0` where JavaScript writes `1`; C0).
2. **Cross-language CI** (`.github/workflows/core.yml`): `compute-run.ts` rewrites the fixture run's outputs,
   then `contracts/validate.py --recompute` must pass with zero errors.
3. **Differential CI**: `scripts/differential.py` sends random parameters, looks, seeds and claim uploads
   through `rules.py`; `scripts/differential.ts` must agree on every case, rejections included.

If a golden test fails, the fix is never to edit the fixture by hand. Either core drifted (fix core), or the
contract changed (change `rules.py` and the schemas, run `make fixtures`, log it in DECISIONS.md, tell the team).

## Develop

```sh
npm ci                                   # at the repo root (npm workspaces)
npm run gen -w @mudskipper/core          # regenerate src/contracts.gen.ts after a schema change
npm run gen:check -w @mudskipper/core    # CI: fail if the committed types drifted
npm run typecheck -w @mudskipper/core    # WebWorker, DOM and Node type sets
npm test -w @mudskipper/core             # Vitest 5: rules, golden fixtures, client, compute-run
```

Toolchain: Node ≥ 24.12 (type stripping), TypeScript 7.0.2, Vitest 5.1.0, json-schema-to-typescript 16.0.0
(dev only). Relative imports carry `.ts`, type-only imports use `import type`, and there are no enums or
other non-erasable syntax, so plain `node` runs every file.
