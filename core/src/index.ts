/**
 * @mudskipper/core: the one implementation of Mudskipper's rules (SPEC A4). Pure, deterministic, zero
 * runtime dependencies; runs unchanged in the browser (Lab), workerd (audit ranking) and Node (publish).
 *
 * The typed API client lives at `@mudskipper/core/client`; generated contract types at
 * `@mudskipper/core/contracts` (also re-exported here).
 */
export type * from "./contracts.gen.ts";

export { mulberry32, fnv1a32, derive } from "./prng.ts";
export { DAY_MS, parseMs, fmtDt, days, stageOf, inGap, type StageBoundaries, type GapInterval } from "./time.ts";
export { pct, pctDown, looksText, allLooksText, passesText, timesText } from "./format.ts";
export {
  K_STAR_RULE,
  simulate,
  ge,
  kStarFrom,
  sentence,
  detectability,
  type SimParams,
  type RuleParams,
  type Look,
  type Scenario,
  type PassTime,
  type DetectabilityCore,
} from "./sim.ts";
export { sha256Hex } from "./sha.ts";
export { DEFAULT_PARAMS, DEFAULT_PARAM_SOURCES, DEFAULT_SEED, DEFAULT_N_SIM, type ParamKey } from "./params.ts";
export { dumpJson, dumpJsonl, dumpStates, parseJsonl } from "./json.ts";
