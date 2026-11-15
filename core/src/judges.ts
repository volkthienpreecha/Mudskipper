/**
 * The data behind `/judges` and the README's "For judges" table: the five criteria of docs/WIN_GUIDE.md §8,
 * with the corrected Impact wording (DECISIONS.md F-001), one sentence and one deep link into the app each.
 *
 * Evidence rule (T12): every number in `shows` or `sentence` is listed in `numbers` with its tag and source,
 * so the page can render the tag chip next to it. Sentences avoid numbers that have no source.
 */
import type { Tag } from "./contracts.gen.ts";

export type JudgeCriterion = "impact" | "creativity" | "validity" | "relevance" | "presentation";

/** App routes from SPEC Lane Volk that a criterion may link to. */
export type AppRoute = "/lab" | "/evidence" | "/map" | "/?tour=1" | "/scarecrow" | "/methods";

export interface TaggedNumber {
  /** The exact substring as it appears in `shows` or `sentence`. */
  readonly text: string;
  readonly tag: Tag;
  readonly source: { readonly citation: string; readonly url: string | null };
}

export interface JudgeEntry {
  readonly id: JudgeCriterion;
  readonly criterion: string;
  /** The "What we show" cell of WIN_GUIDE §8 (README wording). */
  readonly shows: string;
  /** One plain sentence for the `/judges` page. */
  readonly sentence: string;
  /** One deep link into the app. */
  readonly href: AppRoute;
  readonly linkLabel: string;
  readonly numbers: ReadonlyArray<TaggedNumber>;
}

const DTNEXT =
  "https://www.dtnext.in/news/business/punjab-dsr-area-rises-36-to-over-4-lakh-acres-in-kharif-2026-minister";

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

export const JUDGES: ReadonlyArray<JudgeEntry> = deepFreeze([
  {
    id: "impact",
    criterion: "Impact",
    shows:
      "Rs 61 crore DSR subsidy checked by hand; rice methane credits contracted in 2026; groundwater + methane; four named user groups",
    sentence:
      "Punjab's Rs 61 crore direct-seeded rice subsidy and the rice methane credits contracted in 2026 are both checked on foot, so Mudskipper ranks which fields an inspector should visit first.",
    href: "/scarecrow",
    linkLabel: "Rank claims for inspection",
    numbers: [
      {
        text: "Rs 61 crore",
        tag: "ASSUMED",
        source: { citation: "Punjab Kharif 2026 DSR subsidy, DT Next / PTI, 19 Jul 2026", url: DTNEXT },
      },
      {
        text: "four",
        tag: "ASSUMED",
        source: {
          citation:
            "docs/WIN_GUIDE.md §4: subsidy offices, carbon auditors and buyers, researchers, farmers proving their work",
          url: null,
        },
      },
    ],
  },
  {
    id: "creativity",
    criterion: "Creativity",
    shows: "A tool that measures its own blind spots and turns them into an inspection plan",
    sentence:
      "The Detectability Lab simulates what the real NISAR pass dates can and cannot catch, and that same measure decides which fields get a verdict and which go on the inspection list.",
    href: "/lab",
    linkLabel: "Open the Detectability Lab",
    numbers: [],
  },
  {
    id: "validity",
    criterion: "Validity",
    shows:
      "Peer-reviewed physics; reference-checked decomposition; district table; NASA OPERA cross-check; Limits box; no invented accuracy",
    sentence:
      "Every number carries its source and an evidence tag, the decomposition is checked against a reference implementation, and the district table, OPERA cross-check and Limits box sit side by side.",
    href: "/evidence",
    linkLabel: "See the evidence",
    numbers: [],
  },
  {
    id: "relevance",
    criterion: "Relevance",
    shows:
      "NISAR GCOV at the core; polarizations; time series; human driver on natural resources; NASA-ISRO partnership",
    sentence:
      "NASA-ISRO NISAR GCOV radar sees through monsoon clouds and the crop canopy, and its pass-by-pass time series shows each field flooded, drained or uncertain.",
    href: "/map",
    linkLabel: "Watch the season on the map",
    numbers: [],
  },
  {
    id: "presentation",
    criterion: "Presentation",
    shows: "Hero animation, 45-second tour, phone-first, three evidence tags",
    sentence: "A phone-first site with a guided tour that runs on its own, a season animation and an evidence tag on every number.",
    href: "/?tour=1",
    linkLabel: "Take the tour",
    numbers: [
      {
        text: "45-second",
        tag: "ASSUMED",
        source: { citation: "SPEC A3: the tour runs unattended for 45 s (app/src/tour.json)", url: null },
      },
      {
        text: "three",
        tag: "ASSUMED",
        source: { citation: "SPEC evidence rule: OBSERVED, INFERRED, ASSUMED", url: null },
      },
    ],
  },
] satisfies JudgeEntry[]);
