/**
 * The words on the build-time pages (DECISIONS.md K-322, K-325, K-326): every page an agent or a reader without
 * JavaScript gets, written from the live run's own documents (story, meta, detectability, checks, provenance,
 * field rows) at build time, and the facts in app/public/{privacy,terms,credits}.html, src/audit/* and
 * src/limits.ts. Nothing here is typed in by hand that the run already knows; numbers carry their evidence tag
 * (contracts/evidence_tags.json).
 */
import type { JsonObject } from "../../src/contracts.ts";
import { ROUTES } from "../../src/app.ts";
import { defaultRateLimiter, defaultStoreBudget } from "../../src/audit/guard.ts";
import { AUDIT_TTL_SECONDS } from "../../src/audit/store.ts";
import { AUDIT_NOTICE, LIMITS_TEXT, MAX_BODY_BYTES, MAX_CLAIMS, PAGE_SIZE } from "../../src/limits.ts";
import type { BundleResult } from "../build-bundle.ts";
import { toMarkdown, type Block, type Page } from "./doc.ts";

export const REPO_URL = "https://github.com/volkthienpreecha/Mudskipper";
export const ISSUES_URL = `${REPO_URL}/issues`;
export const CHALLENGE_URL = "https://www.spaceappschallenge.org/";
/** Date the privacy, about and contact texts were last changed (by hand, with their content). */
export const PAGES_UPDATED = "15 November 2026";

/** App routes the build may serve (the app's own client-side routes; DECISIONS.md K-321). */
export const APP_ROUTE_INFO: Record<string, { label: string; title: string }> = {
  "/map": { label: "Map", title: "Map: every rice field on every NISAR pass" },
  "/lab": { label: "Lab", title: "Lab: what NISAR's pass dates can and cannot detect" },
  "/scarecrow": { label: "Inspection", title: "Inspection: rank claimed fields for a field visit" },
  "/evidence": { label: "Evidence", title: "Evidence: independent cross-checks of the radar reading" },
  "/methods": { label: "Methods", title: "Methods: how Mudskipper reads NISAR radar over rice" },
  "/judges": { label: "For judges", title: "For judges: Mudskipper in five minutes" },
};

export interface SiteContext {
  siteUrl: string;
  bundle: BundleResult;
  /** Client-side routes the deployed app answers (beyond "/"), e.g. ["/lab", "/evidence"]. */
  appRoutes: string[];
  /** Dynamic app routes by prefix, e.g. ["/field/"]. */
  appPrefixes: string[];
  /** The deployed frontend: Volk's app, or the placeholder page. */
  app: "app" | "placeholder";
  /** Extra static HTML pages the frontend ships (e.g. /terms, /credits from app/public). */
  extraPages: string[];
}

type Tag = "OBSERVED" | "INFERRED" | "ASSUMED";
const n = (x: number) => x.toLocaleString("en-US");
const t = (x: number | string, tag: Tag) => `${typeof x === "number" ? n(x) : x} {${tag}}`;
const pct = (p: number) => `${Math.floor(100 * p + 0.5)}%`;
const day = (iso: string) => iso.slice(0, 10);
const plural = (k: number, one: string, many = one + "s") => `${n(k)} ${k === 1 ? one : many}`;

interface Docs {
  meta: JsonObject & {
    season: { start: string; end: string };
    stages: { mid_start: string; late_start: string };
    gaps: { start: string; end: string; source: string }[];
    tiles: { id: string; district: string; bbox: number[] }[];
    counts: { fields: number; passes: number; passes_used: number; observations: number };
    pol_modes: string[];
    methods: string[];
    crids: string[];
    assets: { fields_geojson: string | null; fields_pmtiles: string | null; claims_sample: string | null } & JsonObject;
  };
  story: (JsonObject & { hero_tile: string; hero_field_id: string; headline: { text: string; tag: Tag }; counts: Record<string, number> }) | null;
  detectability:
    | (JsonObject & {
        n_sim: number;
        seed: number;
        pass_dates: string[];
        sentence: string;
        params: Record<string, unknown>;
        param_sources: Record<string, { citation: string; url: string; status: string }>;
        results: { k_star: number | null; k_star_rule: string };
      })
    | null;
  checks:
    | (JsonObject & {
        season_shape: { pct_flooded_by_stage: Record<string, number>; pass: boolean; rule: string } | null;
        opera: { product: string; version: string; n_dates: number; note: string } | null;
        district: { year: number; rows: { district: string; gov_dsr_acres: number | null; gov_farmers: number | null; tile_dsr_signal_frac: number | null }[]; note: string; source_urls: string[] } | null;
      })
    | null;
  provenance: JsonObject & { granules: unknown[]; artifacts: unknown[]; created_at: string; git_sha: string };
  passes: { pass_id: string; datetime: string; track: number; direction: string; pol_mode: string; used: boolean; excluded_reason: string | null }[];
}

function docs(b: BundleResult): Docs {
  return {
    meta: b.docs.meta as unknown as Docs["meta"],
    story: b.docs.story as unknown as Docs["story"],
    detectability: b.docs.detectability as unknown as Docs["detectability"],
    checks: b.docs.checks as unknown as Docs["checks"],
    provenance: b.docs.provenance as unknown as Docs["provenance"],
    passes: (b.docs.passes as unknown as { passes: Docs["passes"] }).passes,
  };
}

function verdictCounts(b: BundleResult, tile?: string) {
  const rows = b.docs.fieldRows.filter((r) => !tile || r.tile === tile);
  const c = { fields: rows.length, consistent: 0, inconsistent: 0, not_enough_evidence: 0, unsummarised: 0, dsr_signal: 0, transplant_signal: 0, unknown: 0, area: 0 };
  for (const r of rows) {
    c.area += r.area_ha;
    if (r.awd_verdict) c[r.awd_verdict]++;
    else c.unsummarised++;
    if (r.dsr_signal) c[r.dsr_signal]++;
  }
  return c;
}

const sampleNote = (b: BundleResult): Block[] =>
  b.run.fixture
    ? [{ note: `**SAMPLE DATA.** The live run is \`${b.run.run_id}\`, the project's sample fixture run: every number below has the right shape but is not a NISAR result. API responses say \`"fixture": true\` while this is so.` }]
    : [];

const limitsBlocks: Block[] = [{ h: 2, text: "Limits" }, { p: LIMITS_TEXT }];

const tagBlocks: Block[] = [
  { h: 2, text: "Evidence tags" },
  {
    ul: [
      "{OBSERVED}: a radar measurement (backscatter in dB, pass dates, valid pixel fractions).",
      "{INFERRED}: our model's reading of those measurements (per-pass states, season verdicts, field areas, rankings).",
      "{ASSUMED}: a cited parameter or a study setting (season dates, AWD cycle lengths, government DSR figures), always with its source.",
    ],
  },
];

function apiLinks(ctx: SiteContext): string[] {
  return [
    "[Developer guide](/developers): quickstart with curl, endpoints, limits, errors, evidence tags.",
    "[OpenAPI 3.1 description](/openapi.json) (also [YAML](/openapi.yaml)), generated from the contract's JSON Schemas.",
    "[llms.txt](/llms.txt): when and how an AI agent should use Mudskipper; [llms-full.txt](/llms-full.txt) has every page in one file.",
    "[API index](/api) and the [RFC 9727 API catalog](/.well-known/api-catalog).",
    `Every page is also Markdown: request it with \`Accept: text/markdown\` (for example \`curl -H 'Accept: text/markdown' ${ctx.siteUrl}/\`).`,
  ];
}

function home(ctx: SiteContext): Page {
  const b = ctx.bundle;
  const d = docs(b);
  const m = d.meta;
  const c = verdictCounts(b);
  const tiles = m.tiles.map((x) => `\`${x.id}\` in ${x.district} district`).join(" and ");
  const blocks: Block[] = [
    { h: 1, text: "Mudskipper: NISAR radar evidence of rice-field drainage, field by field" },
    {
      p:
        "Was this rice field really drained? Mudskipper uses NASA-ISRO NISAR L-band radar to show, field by field, what space can prove about rice-field drainage in Punjab, India, what it can't, and where an inspector should look first. " +
        "Punjab pays farmers to save water: carbon programs reward alternate wetting and drying (AWD) and a state subsidy rewards direct-seeded rice (DSR), and today those fields are checked on foot. Monsoon cloud blinds optical satellites; L-band radar sees through cloud and the crop canopy, and standing water and drained mud scatter it very differently.",
    },
    { p: `Mudskipper is a student team project for the [NASA Space Apps Challenge 2026](${CHALLENGE_URL}) ("Dancing with the SARs"). The data, the API and the code are open.` },
    ...sampleNote(b),
    { h: 2, text: `This run: ${b.run.run_id}` },
  ];
  if (d.story) blocks.push({ p: `${d.story.headline.text} {${d.story.headline.tag}}` });
  const facts = [
    `${t(m.counts.passes_used, "OBSERVED")} NISAR passes used of ${t(m.counts.passes, "OBSERVED")} found over the study area (CRID ${m.crids.join(", ")}, polarization modes ${m.pol_modes.join(", ")}).`,
    `${t(m.counts.fields, "INFERRED")} mapped rice fields covering ${t(Math.round(c.area * 10) / 10, "INFERRED")} ha, in ${t(m.tiles.length, "ASSUMED")} study tiles: ${tiles}.`,
    `Season ${day(m.season.start)} to ${day(m.season.end)} {ASSUMED}` +
      m.gaps.map((g) => `; NISAR data gap ${day(g.start)} to ${day(g.end)} {OBSERVED} ([source](${g.source}))`).join("") +
      ".",
  ];
  if (c.unsummarised < c.fields)
    facts.push(
      `AWD season verdicts: ${t(c.consistent, "INFERRED")} consistent with AWD, ${t(c.inconsistent, "INFERRED")} not consistent with AWD, ${t(c.not_enough_evidence, "INFERRED")} not enough evidence. DSR signal: ${t(c.dsr_signal, "INFERRED")} fields dry before mid-season, ${t(c.transplant_signal, "INFERRED")} with standing water typical of transplanting, ${t(c.unknown, "INFERRED")} unknown.`,
    );
  if (d.story) facts.push(`Hero field: [${d.story.hero_field_id}](/api/fields/${d.story.hero_field_id}) in the \`${d.story.hero_tile}\` tile.`);
  if (d.detectability) facts.push(`Detectability: ${d.detectability.sentence} {INFERRED}`);
  blocks.push({ ul: facts });

  blocks.push({ h: 2, text: "What you can do here" });
  const routeItems =
    ctx.app === "app"
      ? [`[The map](/): every field, coloured by its state on each NISAR pass, with a field card for each one.`]
      : ["Read every number on this page, and much more, from the [API](/developers); the interactive map is not deployed on this build."];
  const describe: Record<string, string> = {
    "/lab": "what the real pass dates can detect, and how often a field practicing AWD is caught drained.",
    "/scarecrow": "upload claimed fields as GeoJSON and get a reproducible inspection ranking.",
    "/evidence": "independent cross-checks: season shape, NASA OPERA surface water and the district table.",
    "/methods": "how the radar reading, verdicts and evidence tags work.",
    "/judges": "a five-minute tour of the project.",
    "/map": "the map on its own page.",
  };
  for (const r of ctx.appRoutes) if (APP_ROUTE_INFO[r]) routeItems.push(`[${APP_ROUTE_INFO[r]!.label}](${r}): ${describe[r]}`);
  blocks.push({ ul: routeItems });

  blocks.push(...tagBlocks);
  blocks.push({ h: 2, text: "For developers and AI agents" }, { p: "The same data is a public JSON API with no key and open CORS." }, { ul: apiLinks(ctx) });
  blocks.push(...limitsBlocks);
  blocks.push({ h: 2, text: "About the project" }, { ul: aboutLinks(ctx) });
  return {
    path: "/",
    title: "Mudskipper: NISAR radar evidence of rice-field drainage in Punjab",
    description:
      "Was this rice field really drained? Mudskipper uses NASA-ISRO NISAR radar to show, field by field, what space can prove about rice-field drainage in Punjab, what it can't, and where to inspect first.",
    blocks,
  };
}

function aboutLinks(ctx: SiteContext): string[] {
  const out = ["[About](/about): who built Mudskipper and why.", "[Contact](/contact): questions, corrections and bug reports.", "[Privacy](/privacy): no cookies, no tracking; what an audit upload keeps."];
  if (ctx.extraPages.includes("/terms")) out.push("[Terms of use](/terms).");
  if (ctx.extraPages.includes("/credits")) out.push("[Data, licences and credits](/credits).");
  out.push(`[Source code](${REPO_URL}) under GPL-3.0-only.`);
  return out;
}

function lab(ctx: SiteContext): Page {
  const b = ctx.bundle;
  const det = docs(b).detectability;
  const blocks: Block[] = [{ h: 1, text: APP_ROUTE_INFO["/lab"]!.title }, ...sampleNote(b)];
  blocks.push({
    p: "NISAR revisits each field every 12 days, but a field practicing alternate wetting and drying may be dry for only two or three days of a four- to ten-day cycle. The Lab asks how much the real pass dates can verify: it simulates many seasons of a field practicing AWD and of a continuously flooded field, observed only on the dates NISAR actually flew, with the per-pass accuracy the literature reports.",
  });
  if (det) {
    blocks.push({ h: 2, text: "Result for this run" }, { p: `${det.sentence} {INFERRED}` });
    blocks.push({
      ul: [
        `Pass dates simulated: ${t(det.pass_dates.length, "OBSERVED")}, from ${day(det.pass_dates[0] ?? "")} to ${day(det.pass_dates.at(-1) ?? "")}.`,
        `k_star (${det.results.k_star_rule}): ${det.results.k_star === null ? "none" : t(det.results.k_star, "INFERRED")}. A field needs at least that many drained looks to be called consistent with AWD.`,
        `Simulations: ${t(det.n_sim, "ASSUMED")} per series, seed ${t(String(det.seed), "ASSUMED")}, so anyone can reproduce them.`,
      ],
    });
    blocks.push({ h: 2, text: "Parameters and their sources" });
    blocks.push({
      table: {
        head: ["Parameter", "Value", "Source"],
        rows: Object.entries(det.param_sources).map(([k, s]) => [`\`${k}\``, `${JSON.stringify(det.params[k]).replace(/,"/g, ', "').replace(/":/g, '": ').replace(/,(?=\d)/g, ", ")} {ASSUMED}`, `[${s.citation.replace(/[[\]]/g, "")}](${s.url}) (${s.status})`]),
      },
    });
  } else blocks.push({ p: "The detectability simulation has not been published for this run yet." });
  blocks.push({ h: 2, text: "Get the numbers" }, { p: "[GET /api/detectability](/api/detectability) returns the full result, including the distribution of drained looks for both series." });
  blocks.push(...limitsBlocks);
  return { path: "/lab", title: APP_ROUTE_INFO["/lab"]!.title, description: "How often NISAR's real 2026 pass dates catch a rice field practicing alternate wetting and drying, and how often a flooded field is falsely flagged.", blocks };
}

function evidence(ctx: SiteContext): Page {
  const b = ctx.bundle;
  const d = docs(b);
  const ch = d.checks;
  const blocks: Block[] = [{ h: 1, text: APP_ROUTE_INFO["/evidence"]!.title }, ...sampleNote(b)];
  blocks.push({ p: "There is no 2026 ground truth for Punjab yet, so Mudskipper checks its radar reading against what it can: the shape of the season, NASA's own surface-water product and the state government's DSR figures. Each check says what it can and cannot show." });
  if (ch?.season_shape) {
    const s = ch.season_shape;
    blocks.push({ h: 2, text: "Season shape" }, { p: `${s.rule} Result: ${s.pass ? "passed" : "did not pass"}.` });
    blocks.push({ ul: Object.entries(s.pct_flooded_by_stage).map(([k, v]) => `Fields flooded in the ${k} stage: ${t(`${v}%`, "INFERRED")}`) });
  }
  if (ch?.opera) {
    blocks.push({ h: 2, text: "NASA OPERA cross-check" }, { p: `${ch.opera.product}, ${ch.opera.version}, on ${t(ch.opera.n_dates, "OBSERVED")} dates. ${ch.opera.note}` });
  }
  if (ch?.district) {
    const dc = ch.district;
    blocks.push({ h: 2, text: `District table, ${dc.year}` }, { p: dc.note });
    blocks.push({
      table: {
        head: ["District", "Government DSR acres", "Farmers", "Tile DSR signal share"],
        rows: dc.rows.map((r) => [
          r.district,
          r.gov_dsr_acres === null ? "n/a" : t(r.gov_dsr_acres, "ASSUMED"),
          r.gov_farmers === null ? "n/a" : t(r.gov_farmers, "ASSUMED"),
          r.tile_dsr_signal_frac === null ? "no tile" : t(pct(r.tile_dsr_signal_frac), "INFERRED"),
        ]),
      },
    });
    if (dc.source_urls.length) blocks.push({ p: `Sources: ${dc.source_urls.map((u, i) => `[${i + 1}](${u})`).join(", ")}.` });
  }
  if (!ch) blocks.push({ p: "The cross-checks have not been published for this run yet." });
  blocks.push({ h: 2, text: "Provenance" });
  blocks.push({
    p: `This run lists ${t(d.provenance.granules.length, "OBSERVED")} NISAR granules and the sha256 of ${plural(d.provenance.artifacts.length, "artifact")}, created ${d.provenance.created_at} from commit \`${d.provenance.git_sha}\`. See [GET /api/provenance](/api/provenance) and [GET /api/checks](/api/checks).`,
  });
  blocks.push(...limitsBlocks);
  return { path: "/evidence", title: APP_ROUTE_INFO["/evidence"]!.title, description: "Season shape, NASA OPERA surface-water cross-check and the Punjab district DSR table for Mudskipper's NISAR rice-field reading.", blocks };
}

function methods(ctx: SiteContext): Page {
  const b = ctx.bundle;
  const d = docs(b);
  const m = d.meta;
  const tracks = [...new Set(d.passes.filter((p) => p.used).map((p) => `track ${p.track} ${p.direction}`))].join(", ");
  const det = d.detectability;
  const thr = det?.params as { cf_false_flag_max?: number; awd_miss_max?: number; dsr_min_early_looks?: number; awd_window_days_after_transplant?: number[] } | undefined;
  const win = thr?.awd_window_days_after_transplant ?? [14, 85];
  const blocks: Block[] = [
    { h: 1, text: APP_ROUTE_INFO["/methods"]!.title },
    ...sampleNote(b),
    { h: 2, text: "Data" },
    {
      p: `NISAR L2 GCOV (geocoded polarimetric covariance), provisional products ${m.crids.join(", ")}, from the Alaska Satellite Facility DAAC: ${t(m.counts.passes_used, "OBSERVED")} used passes (${tracks}) over the season ${day(m.season.start)} to ${day(m.season.end)} {ASSUMED}. Field outlines come from Fields of The World (CC-BY-4.0) and are kept only if at least 0.5 ha and mostly rice in the GlobalRice20 map (CC-BY-4.0).`,
    },
    { h: 2, text: "How radar reads a rice field" },
    {
      ul: [
        "Before the canopy closes (June to July), open water acts like a mirror and bounces the radar away from the satellite, so HH backscatter drops on a flooded field.",
        "Under a canopy (August to October), stems standing in water bounce the radar straight back, so a flooded field looks brighter.",
        `Per pass, each field's radar values (averaged in linear power, then in dB {OBSERVED}) become a probability of being flooded with the method ${m.methods.map((x) => `\`${x}\``).join(" or ")}. The state is flooded at p ≥ 0.65, drained at p ≤ 0.35, and uncertain in between or when under 60% of the field's pixels are valid {INFERRED}.`,
      ],
    },
    { h: 2, text: "Season verdicts" },
    {
      ol: [
        `The AWD window starts ${win[0]} days after the field's first early-season flooded look (or the middle of the transplanting window when there is none) and ends ${win[1]} days after it {ASSUMED}.`,
        `Clear looks (flooded or drained) inside the window are counted. **Consistent with AWD** when the drained looks reach k_star, the fewest that a continuously flooded field would show with at most ${pct(thr?.cf_false_flag_max ?? 0.1)} probability {ASSUMED}.`,
        `**Not consistent with AWD** when no look is drained although these dates would have caught an AWD field at least ${pct(1 - (thr?.awd_miss_max ?? 0.1))} of the time; **not enough evidence** otherwise.`,
        `DSR signal: standing water on an early-season look suggests puddled transplanting; dry on all of at least ${thr?.dsr_min_early_looks ?? 2} early looks suggests direct seeding; fewer looks give unknown. DSR is a signal, not proof.`,
      ],
    },
    { h: 2, text: "Ranking for inspection" },
    {
      p: "Claims are matched to fields, weighted by verdict (not consistent 1.0, not enough evidence 0.6, consistent 0.1; unmatched claims 0.8) and area, and 80% of the budget is picked by score, 20% at random by district so every field can be visited. The same upload always gives the same ranking.",
    },
    ...tagBlocks,
    { h: 2, text: "Reproducibility" },
    { p: `The rules exist once, in TypeScript (\`core/\`), with a Python reference that must agree exactly; every response is validated against the published JSON Schemas. The full contract is CONTRACTS.md in the [repository](${REPO_URL}).` },
    ...limitsBlocks,
  ];
  return { path: "/methods", title: APP_ROUTE_INFO["/methods"]!.title, description: "How Mudskipper turns NISAR L-band radar into per-pass flooded or drained states, AWD season verdicts, a DSR signal and an inspection ranking.", blocks };
}

function inspection(ctx: SiteContext): Page {
  const b = ctx.bundle;
  const sample = docs(b).meta.assets.claims_sample;
  const blocks: Block[] = [
    { h: 1, text: APP_ROUTE_INFO["/scarecrow"]!.title },
    ...sampleNote(b),
    {
      p: "A program that pays for AWD or DSR cannot visit every field. Upload the claimed fields as GeoJSON and Mudskipper ranks them for inspection: fields whose radar record contradicts the claim come first, a fifth of the visits are random so nobody can predict them, and the result is reproducible from the upload alone.",
    },
    { h: 2, text: "What to upload" },
    {
      ul: [
        "A GeoJSON FeatureCollection of claims: Point, Polygon or MultiPolygon, each with `properties.claimed` (`awd` and/or `dsr`) and `properties.synthetic`.",
        `At most ${n(MAX_CLAIMS)} claims and ${n(MAX_BODY_BYTES)} bytes; an inspection budget of 1 to 500.`,
        "Never names, phone numbers or ID numbers: use your own claim ids. Only the ranking is stored, never the geometry.",
        ...(sample ? [`Try it with the [sample claims](${sample}) (synthetic).`] : []),
      ],
    },
    { h: 2, text: "What comes back" },
    {
      p: `A ranked list with a reason for each pick (for example "Not consistent with AWD (0 of 5 drained)"), the matched and unmatched counts, and an audit id you can share. Every ranking says: "${AUDIT_NOTICE}"`,
    },
    { h: 2, text: "From a script" },
    { p: "`POST /api/audit` takes the same upload; see the [developer guide](/developers#rank-claims-for-inspection) for a curl example and the rate limits." },
    ...limitsBlocks,
  ];
  return { path: "/scarecrow", title: APP_ROUTE_INFO["/scarecrow"]!.title, description: "Upload claimed AWD or DSR rice fields as GeoJSON and get a reproducible, partly random inspection ranking from NISAR radar evidence.", blocks };
}

function mapPage(ctx: SiteContext): Page {
  const b = ctx.bundle;
  const m = docs(b).meta;
  const blocks: Block[] = [
    { h: 1, text: APP_ROUTE_INFO["/map"]!.title },
    ...sampleNote(b),
    { p: "The map colours every mapped rice field by its state on each NISAR pass, flooded, drained or uncertain, and plays the season. Open a field for its radar values, its season verdict and the reason behind it." },
    { h: 2, text: "Study tiles" },
    {
      table: {
        head: ["Tile", "District", "Fields", "Consistent with AWD", "Not consistent", "Not enough evidence"],
        rows: m.tiles.map((tile) => {
          const c = verdictCounts(b, tile.id);
          return [`\`${tile.id}\``, tile.district, t(c.fields, "INFERRED"), t(c.consistent, "INFERRED"), t(c.inconsistent, "INFERRED"), t(c.not_enough_evidence, "INFERRED")];
        }),
      },
    },
    { h: 2, text: "Map data" },
    {
      ul: [
        "[GET /api/states](/api/states): every field's state on every pass, in one request.",
        ...(m.assets.fields_geojson ? [`[Field polygons (GeoJSON)](${m.assets.fields_geojson}).`] : []),
        ...(m.assets.fields_pmtiles ? [`[Field polygons (PMTiles, Range requests)](${m.assets.fields_pmtiles}).`] : []),
        "[GET /api/fields](/api/fields?page=1): fields with verdicts, filterable by tile and verdict.",
      ],
    },
    ...limitsBlocks,
  ];
  return { path: "/map", title: APP_ROUTE_INFO["/map"]!.title, description: "Every mapped rice field in Mudskipper's Punjab study tiles, coloured by its state on each NISAR radar pass.", blocks };
}

function judges(ctx: SiteContext): Page {
  const h = home(ctx);
  return {
    path: "/judges",
    title: APP_ROUTE_INFO["/judges"]!.title,
    description: "A short tour of Mudskipper, a NASA Space Apps 2026 project on NISAR radar evidence of rice-field drainage.",
    blocks: [{ h: 1, text: APP_ROUTE_INFO["/judges"]!.title }, ...h.blocks.slice(1).filter((b) => !("h" in b && b.h === 1))],
  };
}

const ROUTE_PAGES: Record<string, (ctx: SiteContext) => Page> = { "/map": mapPage, "/lab": lab, "/scarecrow": inspection, "/evidence": evidence, "/methods": methods, "/judges": judges };

function about(ctx: SiteContext): Page {
  const b = ctx.bundle;
  const m = docs(b).meta;
  return {
    path: "/about",
    title: "About Mudskipper",
    description: "Mudskipper is a student team project for the NASA Space Apps Challenge 2026 that turns NISAR radar into field-by-field evidence of rice-field drainage in Punjab.",
    blocks: [
      { h: 1, text: "About Mudskipper" },
      {
        p: `Mudskipper is a student team project built for the [NASA Space Apps Challenge 2026](${CHALLENGE_URL}), in the challenge "Dancing with the SARs". It asks one question of NASA-ISRO's NISAR radar: was this rice field really drained?`,
      },
      { h: 2, text: "Why it exists" },
      {
        p: "Flooded rice paddies release methane and draw down groundwater. In Punjab, carbon programs pay for alternate wetting and drying (AWD) and a state subsidy pays for direct-seeded rice (DSR), but checking either means someone walking to the field. Optical satellites are blind under monsoon cloud. L-band radar is not, and water and mud look very different to it.",
      },
      { h: 2, text: "What it does" },
      {
        ul: [
          `Labels each mapped rice field flooded, drained or uncertain on every NISAR pass, in ${plural(m.tiles.length, "study tile")} {ASSUMED} in ${m.tiles.map((x) => x.district).join(" and ")}.`,
          "Gives each field a season verdict (consistent with AWD, not consistent with AWD, or not enough evidence) and a DSR signal, with the reason in words.",
          "Measures what a 12-day revisit can and cannot verify, instead of claiming an accuracy nobody has measured.",
          "Ranks claimed fields for inspection, with a random share so the ranking cannot be gamed.",
          "Tags every number OBSERVED, INFERRED or ASSUMED, so a reader always knows what was measured and what was modelled.",
        ],
      },
      { h: 2, text: "Who built it" },
      {
        p: "A three-person team: Ishaan (radar and machine-learning pipeline, methods), Karthik (backend, data platform, field geometry) and Volk (frontend, design and video). We are not affiliated with, endorsed by or speaking for NASA, ISRO, ESA, the Government of Punjab or any carbon registry.",
      },
      { h: 2, text: "Open by default" },
      {
        p: `The code is free software under GPL-3.0-only (pyNISAR and polsartools, which the pipeline builds on, are GPL-3.0). The data and the API are public with no key: see the [developer guide](/developers) and the [OpenAPI description](/openapi.json). Third-party data keep their own licences${ctx.extraPages.includes("/credits") ? " ([data, licences and credits](/credits))" : ""}.`,
      },
      { h: 2, text: "AI use" },
      { p: "Claude Code assisted with code and drafting. Every number on the site comes from code run on the listed data; no images are AI-generated." },
      ...limitsBlocks,
      { h: 2, text: "More" },
      { ul: ["[Contact](/contact)", "[Privacy](/privacy)", `[Source code](${REPO_URL})`] },
    ],
  };
}

function contact(ctx: SiteContext): Page {
  void ctx;
  return {
    path: "/contact",
    title: "Contact the Mudskipper team",
    description: "How to reach the Mudskipper team: questions, data corrections and bug reports through the project's GitHub issues.",
    blocks: [
      { h: 1, text: "Contact the Mudskipper team" },
      {
        p: "Mudskipper is a student hackathon project, not a company: there is no office, phone line or support desk. The team reads the project's GitHub issues, and that is the one place to reach us, so that questions and answers stay public and useful to the next person.",
      },
      { h: 2, text: "Ask a question or report a problem" },
      {
        ul: [
          `Open an issue at [${ISSUES_URL.replace("https://", "")}](${ISSUES_URL}).`,
          "For a number or a field that looks wrong, include the run_id (from [GET /api/health](/api/health)), the field_id, and what you expected.",
          "For an API problem, include the request (method, path, status) and the error code from the response body.",
          "For an inspection ranking, include its audit_id rather than the uploaded file.",
        ],
      },
      { h: 2, text: "Please do not send personal data" },
      { p: "Do not post farmer names, phone numbers, ID numbers or land records in an issue or in an upload. Mudskipper describes land, not people, and has no use for them." },
      { h: 2, text: "Security" },
      { p: "If you find a security problem, open an issue that says so without the details, and we will arrange a private channel." },
      { h: 2, text: "The challenge" },
      { p: `Mudskipper is an entry to the [NASA Space Apps Challenge 2026](${CHALLENGE_URL}). NASA and the challenge organisers are not responsible for it; please contact the team, not them, about the project.` },
      { h: 2, text: "Elsewhere on this site" },
      { ul: ["[About](/about)", "[Privacy](/privacy)", "[Developer guide](/developers)", `[Source code](${REPO_URL})`] },
    ],
  };
}

function privacy(ctx: SiteContext): Page {
  const limiter = defaultRateLimiter();
  const budget = defaultStoreBudget();
  const days = AUDIT_TTL_SECONDS / 86_400;
  const third: string[] = ["Cloudflare, which hosts the site and the API (Cloudflare Pages), receives every request, including your IP address, under [Cloudflare's privacy policy](https://www.cloudflare.com/privacypolicy/)."];
  if (ctx.app === "app") third.push("Esri, whose World Imagery basemap tiles (server.arcgisonline.com) your browser loads when you open the map, receives your IP address and the map area you view.");
  return {
    path: "/privacy",
    title: "Privacy policy: Mudskipper",
    description: "Mudskipper sets no cookies, runs no analytics and asks for no account. What an inspection upload keeps, for how long, and who else sees your requests.",
    blocks: [
      { h: 1, text: "Privacy policy" },
      { p: `Last updated ${PAGES_UPDATED}. Short version: Mudskipper does not ask who you are, sets no cookies, runs no analytics or advertising trackers, and keeps nothing personal.` },
      { h: 2, text: "What we collect" },
      {
        ul: [
          "Nothing personal. There are no accounts, sign-ups, cookies, analytics or tracking scripts on this site.",
          "Pages and API responses are the same for everyone; nothing is personalised.",
        ],
      },
      { h: 2, text: "Inspection uploads (POST /api/audit)" },
      {
        ul: [
          "When you rank claims, the uploaded GeoJSON is read in memory, checked, hashed (sha256) and ranked. The upload itself, including its geometry, is never stored or logged, and error messages never quote it.",
          `What is stored is the ranking: field ids, your claim ids, scores, reasons, the sha256 of the upload, the budget and the seed. It is kept in Cloudflare Workers KV for ${days} days, then deleted automatically, and it stops resolving earlier if its run is replaced.`,
          "Anyone who has an audit id can read that ranking. Use claim ids that mean nothing outside your organisation, and never names, phone numbers or ID numbers.",
          `To keep the free service up, uploads are rate-limited: ${limiter.capacity} at once per IP address, then one every ${Math.round(1 / limiter.perSecond)} seconds. The address is held only in the server's memory for this count and is not written anywhere. A daily counter (a number, no addresses) caps stored rankings at ${budget.perDay} a day.`,
        ],
      },
      { h: 2, text: "Third parties your browser contacts" },
      { ul: third },
      { h: 2, text: "Field data" },
      { p: "Field outlines and states come from satellite radar and public maps. They describe land, not people. Field ids are never derived from a person or a parcel register, and we do not link fields to owners." },
      { h: 2, text: "Children" },
      { p: "The site is not directed at children and collects no data from anyone." },
      { h: 2, text: "Changes and contact" },
      { p: "If this policy changes, the date above changes with it. Questions: see [Contact](/contact)." },
    ],
  };
}

/** The audit example from the developer guide (a real, valid request: test/workers/site.test.ts POSTs it). */
export function exampleAuditBody(b: BundleResult): string {
  const row = b.docs.fieldRows.find((r) => r.field_id === (b.docs.story as JsonObject | null)?.["hero_field_id"]) ?? b.docs.fieldRows[0];
  const point = row ? [row.lon, row.lat] : [74.12, 30.33];
  return JSON.stringify({
    budget: 5,
    seed: 1,
    claims: {
      type: "FeatureCollection",
      features: [{ type: "Feature", geometry: { type: "Point", coordinates: point }, properties: { claim_id: "my-claim-1", claimed: ["awd"], synthetic: true } }],
    },
  });
}

function developers(ctx: SiteContext): Page {
  const b = ctx.bundle;
  const u = ctx.siteUrl;
  const story = docs(b).story;
  const field = story?.hero_field_id ?? b.docs.fieldRows[0]?.field_id ?? "fazilka-00001";
  const tile = docs(b).meta.tiles[0]?.id ?? "fazilka";
  const limiter = defaultRateLimiter();
  const budget = defaultStoreBudget();
  const files = Object.keys(b.manifest.files);
  const rangeFile = files.includes("fields.pmtiles") ? "fields.pmtiles" : "fields.geojson";
  return {
    path: "/developers",
    title: "Mudskipper API: developer guide and quickstart",
    description: "Public JSON API for NISAR radar evidence of rice-field drainage in Punjab: no key, open CORS, OpenAPI 3.1, curl quickstart, limits and evidence tags.",
    blocks: [
      { h: 1, text: "Mudskipper API: developer guide" },
      {
        p: `The Mudskipper API serves everything the site shows as JSON: NISAR passes, every mapped rice field with its per-pass states and season verdict, what the pass dates can detect, cross-checks and provenance, plus an endpoint that ranks claimed fields for inspection. It is public: no account, no API key, no cookies, and CORS is open to every origin. The base URL is \`${u}\`.`,
      },
      ...sampleNote(b),
      { h: 2, text: "Machine-readable descriptions" },
      {
        ul: [
          "[OpenAPI 3.1 (JSON)](/openapi.json) and [YAML](/openapi.yaml): every operation with an operationId, typed parameters and the response schemas, generated from the contract's JSON Schemas.",
          "[API catalog](/.well-known/api-catalog) (RFC 9727 linkset) and [llms.txt](/llms.txt) for agents.",
          "[GET /api](/api): the endpoint index with this deployment's limits.",
        ],
      },
      { h: 2, text: "Quickstart" },
      { p: "Check that the API is up and which run it serves:" },
      { code: `curl -s ${u}/api/health`, lang: "sh" },
      { p: "Read the headline, then the fields with a verdict, then one field's whole record:" },
      { code: [`curl -s ${u}/api/story`, `curl -s "${u}/api/fields?tile=${tile}&verdict=consistent&page=1"`, `curl -s ${u}/api/fields/${field}`].join("\n"), lang: "sh" },
      { p: "Revalidate cheaply: every run document has an ETag, and a matching If-None-Match answers 304 with no body." },
      { code: `etag=$(curl -sI ${u}/api/meta | awk -F': ' 'tolower($1)=="etag"{print $2}' | tr -d '\\r')\ncurl -s -o /dev/null -w '%{http_code}\\n' -H "If-None-Match: $etag" ${u}/api/meta`, lang: "sh" },
      { h: 2, text: "Endpoints" },
      {
        table: {
          head: ["Method", "Path", "Returns"],
          rows: [["GET", "`/api`", "Endpoint index and limits"], ...ROUTES.map((r) => [r.methods.join(", "), `\`${r.path}\``, r.description])],
        },
      },
      { h: 2, text: "Rank claims for inspection" },
      {
        p: `POST a GeoJSON FeatureCollection of claims with a budget (1 to 500). The same bytes against the same run always return the same audit_id and ranking; 201 means stored (Location names it), 200 means it was already stored or the daily store budget was spent (x-audit-stored: false).`,
      },
      { code: `cat > claims.json <<'EOF'\n${exampleAuditBody(b)}\nEOF\ncurl -s -X POST ${u}/api/audit -H 'content-type: application/json' --data-binary @claims.json`, lang: "sh" },
      { h: 2, text: "Run files with Range" },
      { p: "Run files (field polygons, PMTiles, overlays, histograms) are under /tiles/runs/<run_id>/ and honour single byte ranges (206), If-None-Match (304) and If-Range; GET /api/meta lists the live run's file URLs." },
      { code: `curl -s -H 'Range: bytes=0-16383' -o part.bin -w '%{http_code}\\n' ${u}/tiles/runs/${b.run.run_id}/${rangeFile}`, lang: "sh" },
      { h: 2, text: "Limits" },
      {
        ul: [
          `Audit uploads: at most ${n(MAX_BODY_BYTES)} bytes (413 too_large) and ${n(MAX_CLAIMS)} claims (400 too_many_claims).`,
          `Audit rate limit: ${limiter.capacity} at once per client IP, then one every ${Math.round(1 / limiter.perSecond)} s, per Cloudflare location; over it, 429 rate_limited with Retry-After.`,
          `Stored audits: up to ${budget.perDay} new ones a day, kept ${AUDIT_TTL_SECONDS / 86_400} days.`,
          `GET /api/fields pages hold ${PAGE_SIZE} fields.`,
          "Run documents may be cached for 60 s (then revalidate with the ETag). The service runs on Cloudflare's free plan (100,000 Function requests a day across all users), so please cache and do not poll.",
        ],
      },
      { h: 2, text: "Errors" },
      {
        p: "Every error is JSON `{\"error\":{\"code\",\"message\"}}` with a 4xx or 5xx status. Codes: invalid_json, invalid_request, too_large, too_many_claims, duplicate_claim_id, invalid_geometry, rate_limited, not_found, method_not_allowed (405 with Allow), range_not_satisfiable, precondition_failed, no_live_run, storage_unavailable, internal.",
      },
      { h: 2, text: "Evidence tags and the fixture flag" },
      {
        p: "Every response carries `fixture`: true while the live run is the SAMPLE fixture run, whose numbers are not results. Every number has one evidence tag, fixed per field in contracts/evidence_tags.json: OBSERVED (a radar measurement), INFERRED (our model's reading) or ASSUMED (a cited parameter, with its source in the response).",
      },
      { h: 2, text: "Data licence" },
      {
        p: `The code is GPL-3.0-only. The API's data are derived from NISAR L2 GCOV (NASA-ISRO, via the Alaska Satellite Facility; NASA Earth science data are openly shared without restriction), Fields of The World field boundaries (CC-BY-4.0) and the GlobalRice20 rice map (CC-BY-4.0). The project has not set a separate licence for its derived data; if you reuse them, credit Mudskipper and those sources.${ctx.extraPages.includes("/credits") ? " Full list: [data, licences and credits](/credits)." : ""}`,
      },
      { h: 2, text: "Markdown for agents" },
      { p: "Every page on this site answers `Accept: text/markdown` with a Markdown version (Vary: Accept), and unknown paths return a real 404 in either format." },
      { code: `curl -s -H 'Accept: text/markdown' ${u}/developers`, lang: "sh" },
      { h: 2, text: "Help" },
      { p: "Questions and bug reports: see [Contact](/contact). Contract changes are additive only; the contract version is `v` in every response." },
    ],
  };
}

function notFound(ctx: SiteContext): Page {
  void ctx;
  return {
    path: "/404",
    title: "Page not found: Mudskipper",
    description: "This page does not exist on Mudskipper.",
    blocks: [
      { h: 1, text: "Page not found" },
      { p: "There is no page at this address on Mudskipper (HTTP 404). It may have moved, or the link may be mistyped." },
      { h: 2, text: "Where to go instead" },
      {
        ul: [
          "[Home](/): NISAR radar evidence of rice-field drainage, field by field.",
          "[Developer guide](/developers) and the [OpenAPI description](/openapi.json) for the JSON API.",
          "[llms.txt](/llms.txt): a map of the site for AI agents.",
          "[Sitemap](/sitemap.xml) of every page.",
          "[API index](/api): the API's own 404s are JSON and list the valid routes.",
        ],
      },
    ],
  };
}

export interface SitePages {
  home: Page;
  routes: Page[];
  statics: Page[];
  notFound: Page;
}

export function sitePages(ctx: SiteContext): SitePages {
  return {
    home: home(ctx),
    routes: ctx.appRoutes.filter((r) => ROUTE_PAGES[r]).map((r) => ROUTE_PAGES[r]!(ctx)),
    statics: [about(ctx), contact(ctx), privacy(ctx), developers(ctx)],
    notFound: notFound(ctx),
  };
}

/** llms.txt (llmstxt.org): H1, summary, when to use, how to call, then link lists. */
export function llmsTxt(ctx: SiteContext, pages: SitePages): string {
  const u = ctx.siteUrl;
  const b = ctx.bundle;
  const field = docs(b).story?.hero_field_id ?? b.docs.fieldRows[0]?.field_id ?? "fazilka-00001";
  const tile = docs(b).meta.tiles[0]?.id ?? "fazilka";
  const page = (p: { path: string; title: string; description: string }) => `- [${p.title}](${u}${p.path === "/" ? "/" : p.path}): ${p.description}`;
  return [
    "# Mudskipper",
    "",
    "> NASA-ISRO NISAR L-band radar evidence of rice-field drainage in Punjab, India, field by field: per-pass flooded/drained states, AWD season verdicts, a DSR signal, what the 12-day revisit can detect, and inspection rankings. Public JSON API, no key. A student team project for the NASA Space Apps Challenge 2026.",
    "",
    b.run.fixture
      ? `The live run is \`${b.run.run_id}\`, the SAMPLE fixture run: responses say \`"fixture": true\` and their numbers are not NISAR results. Say so whenever you quote them.`
      : `The live run is \`${b.run.run_id}\` (real NISAR data, provisional products).`,
    "",
    "## When to use Mudskipper",
    "",
    "- Checking whether a specific rice field in the Fazilka or Sri Muktsar Sahib study tiles (Punjab, India, Kharif 2026) shows drainage on NISAR passes: get its per-pass states and its AWD verdict with the reason in words (`GET /api/fields/{id}`).",
    "- Finding fields by verdict: consistent with alternate wetting and drying (AWD), not consistent, or not enough evidence, per tile (`GET /api/fields?tile=&verdict=`).",
    "- Ranking claimed AWD or DSR fields for an inspection visit from a GeoJSON of claims, reproducibly and partly at random (`POST /api/audit`).",
    "- Explaining what a 12-day radar revisit can and cannot verify about intermittent drainage, with cited parameters (`GET /api/detectability`).",
    "- Getting a field's evidence with provenance: NISAR granule ids, artifact hashes and independent cross-checks (NASA OPERA surface water, government DSR figures) (`GET /api/provenance`, `GET /api/checks`).",
    "",
    "Do not use Mudskipper for areas outside its two study tiles, for years other than 2026, for emissions estimates (it shows irrigation evidence, not emissions), or as proof about a person: a verdict is evidence about land, and a ranking is for inspection, not a finding about anyone.",
    "",
    "## How to call the API",
    "",
    `- Base URL ${u}. No authentication, CORS open, JSON only. Start with \`GET ${u}/api\` (endpoint index) or the OpenAPI description.`,
    `- One field: \`curl ${u}/api/fields/${field}\`. Fields of a tile with a verdict: \`curl "${u}/api/fields?tile=${tile}&verdict=inconsistent"\` (${PAGE_SIZE} per page, \`page\` from 1).`,
    `- Rank claims: \`POST ${u}/api/audit\` with \`{"budget": 1-500, "claims": <GeoJSON FeatureCollection>}\`; each feature needs \`properties.claimed\` (["awd"] and/or ["dsr"]) and \`properties.synthetic\`. At most ${n(MAX_CLAIMS)} claims and ${n(MAX_BODY_BYTES)} bytes; rate-limited (429 with Retry-After). Never send personal data.`,
    "- Errors are `{\"error\":{\"code\",\"message\"}}`; 404 for unknown fields; revalidate with ETag/If-None-Match instead of polling.",
    "- Every web page also answers `Accept: text/markdown`.",
    "",
    "## Evidence tags",
    "",
    "Every number carries exactly one tag; keep it when you quote the number.",
    "",
    "- OBSERVED: a radar measurement (backscatter in dB, pass dates, valid fractions).",
    "- INFERRED: the model's reading of measurements (per-pass state, season verdict, field area, ranking score).",
    "- ASSUMED: a cited parameter or study setting (season dates, AWD cycle length, government DSR figures); the response carries its source URL.",
    "",
    `Limits: ${LIMITS_TEXT}`,
    "",
    "## Docs",
    "",
    `- [OpenAPI 3.1 description](${u}/openapi.json): every operation, parameter and response schema (also [YAML](${u}/openapi.yaml)).`,
    page(pages.statics.find((p) => p.path === "/developers")!),
    `- [API catalog](${u}/.well-known/api-catalog): RFC 9727 linkset.`,
    `- [API index](${u}/api): live endpoint list and limits.`,
    "",
    "## Pages",
    "",
    page(pages.home),
    ...pages.routes.map(page),
    ...pages.statics.filter((p) => p.path !== "/developers").map(page),
    "",
    "## Optional",
    "",
    `- [llms-full.txt](${u}/llms-full.txt): every page above in one Markdown file.`,
    `- [Source code and contract](${REPO_URL}): CONTRACTS.md defines every response; GPL-3.0-only.`,
    `- [Sitemap](${u}/sitemap.xml)`,
    "",
  ].join("\n");
}

export function llmsFullTxt(ctx: SiteContext, pages: SitePages): string {
  const all = [pages.home, ...pages.routes, ...pages.statics];
  return [llmsTxt(ctx, pages).trimEnd(), ...all.map((p) => `---\n\nSource: ${ctx.siteUrl}${p.path}\n\n${toMarkdown(p, ctx.siteUrl)}`)].join("\n\n") + "\n";
}

/** schema.org JSON-LD for the homepage: WebSite, WebApplication, Dataset, WebAPI and the team (true facts only). */
export function jsonLd(ctx: SiteContext): Record<string, unknown> {
  const u = ctx.siteUrl;
  const b = ctx.bundle;
  const m = docs(b).meta;
  const keywords = ["NISAR", "synthetic aperture radar", "L-band radar", "rice", "alternate wetting and drying", "AWD", "direct-seeded rice", "DSR", "Punjab", "irrigation", "field inspection", "open data API"];
  const lons = m.tiles.flatMap((x) => [x.bbox[0]!, x.bbox[2]!]);
  const lats = m.tiles.flatMap((x) => [x.bbox[1]!, x.bbox[3]!]);
  const org = { "@id": `${u}/#team` };
  const description =
    "Mudskipper uses NASA-ISRO NISAR radar to show, field by field, what space can prove about rice-field drainage in Punjab, India, what it can't, and where an inspector should look first.";
  return {
    "@context": "https://schema.org",
    "@graph": [
      { "@type": "WebSite", "@id": `${u}/#website`, name: "Mudskipper", url: `${u}/`, description, inLanguage: "en", publisher: org },
      {
        "@type": "WebApplication",
        "@id": `${u}/#app`,
        name: "Mudskipper",
        alternateName: "Mudskipper: proof, not paperwork",
        url: `${u}/`,
        description,
        applicationCategory: "ScientificApplication",
        operatingSystem: "Any (web browser)",
        browserRequirements: "Requires JavaScript for the interactive map; every page is also readable without it.",
        isAccessibleForFree: true,
        offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
        keywords: keywords.join(", "),
        license: "https://spdx.org/licenses/GPL-3.0-only.html",
        creator: org,
        isPartOf: { "@id": `${u}/#website` },
      },
      {
        "@type": "WebAPI",
        "@id": `${u}/#api`,
        name: "Mudskipper API",
        description: "Public JSON API (no key) for NISAR rice-field states, AWD verdicts, detectability, cross-checks and inspection rankings.",
        url: `${u}/api`,
        documentation: `${u}/developers`,
        isAccessibleForFree: true,
        provider: org,
      },
      {
        "@type": "Dataset",
        "@id": `${u}/#dataset`,
        name: `Mudskipper NISAR rice-field drainage evidence, run ${b.run.run_id}${b.run.fixture ? " (sample data)" : ""}`,
        description:
          `Per-pass flooded, drained or uncertain states and AWD season verdicts for ${m.counts.fields} mapped rice fields in ${m.tiles.map((x) => x.district).join(" and ")}, Punjab, from ${m.counts.passes_used} NISAR L2 GCOV passes.` +
          (b.run.fixture ? " This is the project's SAMPLE fixture run, not NISAR results." : ""),
        url: `${u}/developers`,
        keywords,
        isAccessibleForFree: true,
        creator: org,
        temporalCoverage: `${day(m.season.start)}/${day(m.season.end)}`,
        spatialCoverage: {
          "@type": "Place",
          name: `${m.tiles.map((x) => x.district).join(" and ")}, Punjab, India`,
          geo: { "@type": "GeoShape", box: `${Math.min(...lats)} ${Math.min(...lons)} ${Math.max(...lats)} ${Math.max(...lons)}` },
        },
        measurementTechnique: "L-band synthetic aperture radar (NISAR L2 GCOV)",
        distribution: [
          { "@type": "DataDownload", encodingFormat: "application/json", contentUrl: `${u}/api/fields` },
          ...(m.assets.fields_geojson ? [{ "@type": "DataDownload", encodingFormat: "application/geo+json", contentUrl: `${u}${m.assets.fields_geojson}` }] : []),
        ],
      },
      {
        "@type": "Organization",
        "@id": `${u}/#team`,
        name: "Mudskipper team",
        description: "A three-person student team project for the NASA Space Apps Challenge 2026.",
        url: `${u}/about`,
        sameAs: [REPO_URL],
        knowsAbout: ["NISAR", "synthetic aperture radar", "rice irrigation", "alternate wetting and drying"],
        contactPoint: { "@type": "ContactPoint", contactType: "technical support", url: `${u}/contact`, availableLanguage: "en" },
      },
    ],
  };
}
