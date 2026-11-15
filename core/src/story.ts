/**
 * `story.json` (CONTRACTS.md B3.11): what the Story screen leads with. Python reference: `rules.story`.
 */
import type { Story, Verdict } from "./contracts.gen.ts";
import { pct } from "./format.ts";

export interface StoryAoi {
  readonly tiles: ReadonlyArray<{ readonly id: string }>;
}

export interface StoryField {
  readonly field_id: string;
  readonly tile: string;
  readonly area_ha: number;
}

export interface StorySummary {
  readonly awd: { readonly verdict: Verdict; readonly drained_hits: number; readonly clear_looks: number };
}

/** Summaries by field_id: a Map or a plain object. */
export type SummaryLookup<S> = ReadonlyMap<string, S> | { readonly [fieldId: string]: S | undefined };

export function getSummary<S>(summaries: SummaryLookup<S>, fieldId: string): S | undefined {
  if (summaries instanceof Map) return summaries.get(fieldId);
  return Object.prototype.hasOwnProperty.call(summaries, fieldId)
    ? (summaries as Record<string, S | undefined>)[fieldId]
    : undefined;
}

const byCodeUnits = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * B3.11. `fields` are feature properties; `summaries` maps every field_id to its summary line (a missing
 * one throws, as in the reference). Tiles with no fields are skipped; a run with no fields has no story.
 */
export function story(
  aoi: StoryAoi,
  fields: ReadonlyArray<StoryField>,
  summaries: SummaryLookup<StorySummary>,
  usedPasses: number,
  runId: string,
  fixture?: boolean,
): Story {
  const summaryOf = (fieldId: string): StorySummary => {
    const s = getSummary(summaries, fieldId);
    if (s === undefined) throw new RangeError(`story: no summary for field ${fieldId}`);
    return s;
  };
  const decided = (fieldId: string): boolean => summaryOf(fieldId).awd.verdict !== "not_enough_evidence";

  const total = fields.length;
  if (total === 0) throw new RangeError("story needs at least one field");
  let nDecided = 0;
  for (const f of fields) if (decided(f.field_id)) nDecided += 1;
  const share = nDecided / total;

  let bestTile: string | null = null;
  let bestShare = -1;
  for (const tile of aoi.tiles) {
    const tf = fields.filter((f) => f.tile === tile.id);
    if (tf.length === 0) continue; // a tile with no fields can never be the hero tile
    let d = 0;
    for (const f of tf) if (decided(f.field_id)) d += 1;
    const s = d / tf.length;
    if (s > bestShare) {
      bestTile = tile.id;
      bestShare = s;
    }
  }
  if (bestTile === null) throw new RangeError("story: no field lies in any aoi tile");
  const inTile = fields.filter((f) => f.tile === bestTile).sort((a, b) => byCodeUnits(a.field_id, b.field_id));

  // Most drained hits, then most clear looks, then largest area, then smallest field_id.
  const better = (a: StoryField, b: StoryField): boolean => {
    const sa = summaryOf(a.field_id).awd;
    const sb = summaryOf(b.field_id).awd;
    if (sa.drained_hits !== sb.drained_hits) return sa.drained_hits > sb.drained_hits;
    if (sa.clear_looks !== sb.clear_looks) return sa.clear_looks > sb.clear_looks;
    if (a.area_ha !== b.area_ha) return a.area_ha > b.area_ha;
    return a.field_id < b.field_id;
  };
  const consistent = inTile.filter((f) => summaryOf(f.field_id).awd.verdict === "consistent");
  const pool = consistent.length > 0 ? consistent : inTile.filter((f) => decided(f.field_id));
  let hero = inTile[0]!;
  if (pool.length > 0) {
    hero = pool[0]!;
    for (const f of pool.slice(1)) if (better(f, hero)) hero = f; // strict: the first best wins, like min()
  }
  const p = pct(share);
  return {
    v: 1,
    run_id: runId,
    ...(fixture === undefined ? {} : { fixture }),
    hero_tile: bestTile,
    hero_field_id: hero.field_id,
    headline: { text: `${p}% of ${total} rice fields had enough clear radar looks for a drainage verdict.`, tag: "INFERRED" },
    counts: { passes: usedPasses, fields: total, tiles: aoi.tiles.length, pct_fields_with_enough_looks: p },
  };
}
