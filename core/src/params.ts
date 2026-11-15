/**
 * Default rule parameters and their citations: identical to `PARAMS`, `PARAM_SOURCES`, `SEED` and `N_SIM`
 * in contracts/make_fixtures.py (a golden test enforces it). Ishaan reviews these values (SPEC A4); change
 * them there and here in the same commit, with a line in DECISIONS.md.
 *
 * Every parameter is cited or derived (`drained_fraction_of_cycle` derived, reviewed by Ishaan, SPEC A4).
 */
import type { ParamSource, Params } from "./contracts.gen.ts";

export const DEFAULT_SEED = 20261114;
export const DEFAULT_N_SIM = 4000;

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

export const DEFAULT_PARAMS: Params = deepFreeze({
  transplant_window: { start: "2026-06-05", end: "2026-07-15" },
  awd_window_days_after_transplant: [14, 85],
  cycle_days: [4, 10],
  drained_fraction_of_cycle: [0.3, 0.5],
  cf_single_drain_prob: 0.51,
  per_pass_accuracy: { early: 0.94, mid: 0.8, late: 0.8 },
  stage_boundaries: { mid_start: "2026-07-15", late_start: "2026-09-10" },
  cf_false_flag_max: 0.1,
  awd_miss_max: 0.1,
  dsr_min_early_looks: 2,
});

export type ParamKey = keyof Params;

export const DEFAULT_PARAM_SOURCES: { readonly [K in ParamKey]: ParamSource } = deepFreeze({
  transplant_window: {
    citation:
      "Punjab 2026 paddy schedule (Zone 3, incl. Fazilka and Sri Muktsar Sahib, from June 5), reported by " +
      "Babushahi, 29 Apr 2026; PAU Package of Practices Kharif 2026 (transplant 20 Jun-10 Jul; PR 126 by 15 Jul)",
    url: "https://babushahi.com/full-news.php?id=220401",
    status: "cited",
    note: "Start = government zone-3 opening date; end = PAU's latest date for PR 126 (https://pau.edu/content/ccil/pf/pp_kharif.pdf).",
  },
  awd_window_days_after_transplant: {
    citation: "IRRI Rice Knowledge Bank, AWD; PAU Package of Practices Kharif 2026",
    url: "http://www.knowledgebank.irri.org/step-by-step-production/growth/water-management/alternate-wetting-drying-awd",
    status: "derived",
    note:
      "Start 14: IRRI starts AWD 1-2 weeks after transplanting; PAU keeps water standing for 2 weeks. End 85: PAU stops " +
      "irrigating about 2 weeks before maturity; PR 126 matures ~93 days after transplanting (79) and PR 130-133 at " +
      "105-111 days (91-97). 85 sits inside 79-97.",
  },
  cycle_days: {
    citation: "Shah et al., Machine Learning for Sustainable Rice Production, AAAI 2026",
    url: "https://arxiv.org/abs/2507.08605",
    status: "cited",
    note: "Punjab AWD fields are irrigated 'typically every 4-10 days'.",
  },
  drained_fraction_of_cycle: {
    citation: "IRRI Rice Knowledge Bank, AWD fact sheet; ARCC Agricultural Reviews R-2043 (AWD review)",
    url: "http://www.knowledgebank.irri.org/training/fact-sheets/water-management/saving-water-alternate-wetting-drying-awd",
    status: "derived",
    note:
      "No source states the fraction directly. IRRI: non-flooded days per AWD cycle range from 1 to more than 10; a r" +
      "eview reports the best schedule as about 3 days of drainage after ponded water disappears (https://arccjournals.com/jour" +
      "nal/agricultural-reviews/R-2043). With cycle_days 4-10, about 2-3 dry days gives 0.3-0.5 (capped at 0.5, since PAU keeps fields ponded more often than dry). Reviewed by Ishaan (SPEC A4).",
  },
  cf_single_drain_prob: {
    citation:
      "India Third Biennial Update Report (MoEFCC 2021), via CEEW 'What reduces emissions in sustainable rice " +
      "cultivation', Table 1",
    url: "https://www.ceew.in/sites/default/files/what-reduces-emissions-in-sustainable-rice-cultivation.pdf",
    status: "derived",
    note:
      "Single aeration 16.44% vs continuous flooding 15.89% of India's rice area: 16.44 / (16.44 + 15.89) = 0.51 of " +
      "non-AWD irrigated fields drain once. National figure, not Punjab.",
  },
  per_pass_accuracy: {
    citation: "Islam, Oyoshi and Takeuchi, Remote Sensing 18(8):1183, 2026",
    url: "https://doi.org/10.3390/rs18081183",
    status: "cited",
    note:
      "ALOS-2 L-band full-pol + Freeman-Durden, 704 fields in Naogaon, Bangladesh: 94% early, 80% under dense canopy. " +
      "Not NISAR and not Punjab; dual-pol is expected to do worse (Jin et al. 2026, https://doi.org/10.3390/rs18132136).",
  },
  stage_boundaries: {
    citation: "Mudskipper convention (SPEC, Lane Ishaan step 4)",
    url: null,
    status: "convention",
    note: "early < Jul 15 <= mid < Sep 10 <= late.",
  },
  cf_false_flag_max: {
    citation: "Mudskipper decision rule (SPEC B3.6 k_star_rule)",
    url: null,
    status: "convention",
    note: "A continuously flooded field may be flagged as AWD at most 10% of the time.",
  },
  awd_miss_max: {
    citation: "Mudskipper decision rule (CONTRACTS.md B3.5)",
    url: null,
    status: "convention",
    note: "Call a field not consistent with AWD only if an AWD field would have shown a drained look at least 90% of the time.",
  },
  dsr_min_early_looks: {
    citation: "Mudskipper decision rule (CONTRACTS.md B3.5)",
    url: null,
    status: "convention",
    note: "At least two clear looks before Jul 15 before giving any DSR signal.",
  },
});
