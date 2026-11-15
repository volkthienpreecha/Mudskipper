/**
 * `states.json` (CONTRACTS.md B3.13): one character per field per used pass, for the map's season
 * animation. Python reference: `rules.states`.
 */
import type { State, States } from "./contracts.gen.ts";
import { parseMs } from "./time.ts";

export const STATE_CODE: { readonly [S in State]: "F" | "D" | "U" } = { flooded: "F", drained: "D", uncertain: "U" };

export interface StatesPass {
  readonly pass_id: string;
  readonly datetime: string;
  readonly used: boolean;
}

export interface StatesObservation {
  readonly field_id: string;
  readonly pass_id: string;
  readonly inferred: { readonly state: State };
}

const byCodeUnits = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * `pass_ids` = used passes sorted by (datetime, pass_id); `field_ids` = all fields sorted (code units);
 * `states[i]` has `F`, `D`, `U` or `-` (no observation) per pass. Observations on unknown or excluded passes
 * and unknown fields are ignored, as in the reference; a later line for the same cell wins.
 */
export function states(
  fieldIds: Iterable<string>,
  passes: ReadonlyArray<StatesPass>,
  observations: Iterable<StatesObservation>,
  runId: string,
  fixture?: boolean,
): States {
  const used = passes
    .filter((p) => p.used)
    .map((p) => ({ p, ms: parseMs(p.datetime) }))
    .sort((a, b) => a.ms - b.ms || byCodeUnits(a.p.pass_id, b.p.pass_id))
    .map((e) => e.p);
  const col = new Map<string, number>();
  used.forEach((p, i) => col.set(p.pass_id, i));
  const ids = [...fieldIds].sort(byCodeUnits);
  const row = new Map<string, number>();
  ids.forEach((id, i) => row.set(id, i));
  const grid = ids.map(() => new Array<string>(used.length).fill("-"));
  for (const o of observations) {
    const c = col.get(o.pass_id);
    const r = row.get(o.field_id);
    if (c === undefined || r === undefined) continue;
    const code = STATE_CODE[o.inferred.state];
    if (code === undefined) throw new RangeError(`unknown state ${String(o.inferred.state)}`);
    grid[r]![c] = code;
  }
  return {
    v: 1,
    run_id: runId,
    ...(fixture === undefined ? {} : { fixture }),
    pass_ids: used.map((p) => p.pass_id),
    field_ids: ids,
    states: grid.map((cells) => cells.join("")),
  };
}
