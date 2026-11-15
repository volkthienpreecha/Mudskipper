/**
 * Everything the publish script computes for a run: `detectability.json`, `field_summary.jsonl`,
 * `states.json` and `story.json` (CONTRACTS.md B3.5, B3.6, B3.11, B3.13), plus the provenance artifact list
 * (B3.9). Pure apart from SHA-256, which is async.
 */
import type {
  Aoi,
  Detectability,
  FieldCollection,
  FieldSummaryLine,
  ObservationLine,
  Pass,
  ParamSource,
  Params,
  Provenance,
  States,
  Story,
} from "./contracts.gen.ts";
import { DEFAULT_N_SIM, DEFAULT_PARAMS, DEFAULT_PARAM_SOURCES, DEFAULT_SEED } from "./params.ts";
import { sha256Hex } from "./sha.ts";
import { detectability } from "./sim.ts";
import { states } from "./states.ts";
import { story } from "./story.ts";
import { fieldSummary, type ObservationInput } from "./verdicts.ts";

export interface ComputeRunInput {
  readonly aoi: Pick<Aoi, "tiles" | "stages">;
  readonly fields: Pick<FieldCollection, "features">;
  readonly passes: ReadonlyArray<Pass>;
  readonly observations: ReadonlyArray<Pick<ObservationLine, "field_id"> & ObservationInput>;
  readonly runId: string;
  /** Written as `fixture` into every output when given (fixture runs pass true; real runs omit it). */
  readonly fixture?: boolean;
  readonly params?: Params;
  readonly paramSources?: { readonly [key: string]: ParamSource };
  readonly seed?: number;
  readonly nSim?: number;
}

export interface ComputeRunOutput {
  detectability: Detectability;
  /** One line per field, sorted by field_id (the order `field_summary.jsonl` is written in). */
  summaries: FieldSummaryLine[];
  states: States;
  story: Story;
}

const byCodeUnits = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Run every rule on a run's inputs. Throws if `params.stage_boundaries` differs from `aoi.stages` (B3.6). */
export function computeRun(input: ComputeRunInput): ComputeRunOutput {
  const params = input.params ?? DEFAULT_PARAMS;
  const paramSources = input.paramSources ?? DEFAULT_PARAM_SOURCES;
  const seed = input.seed ?? DEFAULT_SEED;
  const nSim = input.nSim ?? DEFAULT_N_SIM;
  const { aoi, runId, fixture } = input;
  const sb = params.stage_boundaries;
  if (sb.mid_start !== aoi.stages.mid_start || sb.late_start !== aoi.stages.late_start) {
    throw new RangeError(
      `params.stage_boundaries ${JSON.stringify(sb)} must equal aoi.stages ${JSON.stringify(aoi.stages)} (CONTRACTS.md B3.6)`,
    );
  }
  const hdr = { v: 1 as const, run_id: runId, ...(fixture === undefined ? {} : { fixture }) };

  const det = detectability(input.passes, params, nSim, seed);
  const detectabilityDoc: Detectability = {
    ...hdr,
    seed,
    n_sim: nSim,
    pass_dates: det.pass_dates,
    params,
    param_sources: paramSources,
    results: det.results,
    sentence: det.sentence,
  };

  const passById = new Map(input.passes.map((p) => [p.pass_id, p] as const));
  const obsByField = new Map<string, ObservationInput[]>();
  for (const o of input.observations) {
    const list = obsByField.get(o.field_id);
    if (list) list.push(o);
    else obsByField.set(o.field_id, [o]);
  }
  const props = input.fields.features.map((f) => f.properties);
  const summaries = props
    .map((p) =>
      fieldSummary(p.field_id, obsByField.get(p.field_id) ?? [], passById, params, aoi.stages, nSim, seed, runId, fixture),
    )
    .sort((a, b) => byCodeUnits(a.field_id, b.field_id));
  const byId = new Map(summaries.map((s) => [s.field_id, s] as const));
  const usedCount = input.passes.filter((p) => p.used).length;

  return {
    detectability: detectabilityDoc,
    summaries,
    states: states(
      props.map((p) => p.field_id),
      input.passes,
      input.observations,
      runId,
      fixture,
    ),
    story: story(aoi, props, byId, usedCount, runId, fixture),
  };
}

export interface ArtifactFile {
  /** Relative POSIX path inside the run directory, e.g. `overlays/index.json`. */
  readonly path: string;
  readonly bytes: Uint8Array<ArrayBuffer>;
}

/**
 * B3.9 `artifacts`: every file of the run except `provenance.json`, with its sha256, sorted by path
 * (code units, as validate.py's `sorted()`).
 */
export async function provenanceArtifacts(files: Iterable<ArtifactFile>): Promise<Provenance["artifacts"]> {
  const list = [...files].filter((f) => f.path !== "provenance.json");
  const seen = new Set<string>();
  for (const f of list) {
    if (seen.has(f.path)) throw new RangeError(`artifact ${f.path} listed twice`);
    seen.add(f.path);
  }
  const out = await Promise.all(list.map(async (f) => ({ path: f.path, sha256: await sha256Hex(f.bytes) })));
  return out.sort((a, b) => byCodeUnits(a.path, b.path));
}

/** The same provenance document with its `artifacts` list replaced (key order kept). */
export function withArtifacts<T extends Pick<Provenance, "artifacts">>(provenance: T, artifacts: Provenance["artifacts"]): T {
  return { ...provenance, artifacts };
}
