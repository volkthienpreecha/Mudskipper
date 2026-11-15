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
export { sha256Hex } from "./sha.ts";
export { dumpJson, dumpJsonl, dumpStates, parseJsonl } from "./json.ts";
