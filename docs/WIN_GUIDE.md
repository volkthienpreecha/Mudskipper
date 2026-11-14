# MUDSKIPPER — WIN GUIDE (FINAL, 3-PERSON TEAM)

NASA Space Apps 2026 · "Dancing with the SARs" · Nov 14–15

> Transcribed from the team's *Mudskipper (NASA) Specs* document (2026-11-14), word for word apart from
> layout cleanup. Companion to [`SPEC.md`](SPEC.md). Read sections 1–3 together at kickoff.

**Team roles:** Volk: frontend + UI | Karthik: backend + connectivity | Ishaan: ML

## 1. The one thing

A stranger opens our project page on a phone, with no sound and no explanation, and within 30 seconds
understands: real NISAR data, a real problem, an honest answer.

Global judges never hear our pitch. They see three things only:

1. the project page
2. the 30-second video
3. the links (site + repo)

Every hour is spent on those three, in that order. The live pitch is last.

## 2. The story (use these exact words everywhere)

- **Tagline:** Proof, not paperwork.
- **One line:** Mudskipper uses NASA-ISRO NISAR radar to show, field by field, what space can prove about
  rice-field drainage, what it can't, and where an inspector should look first.
- **Opening question:** "Was this rice field really drained?"

## 3. Who owns what judges see

| Surface | Owner | Reviewer | Inputs from |
|---------|-------|----------|-------------|
| Site: Story, tour, all screens | Volk | Karthik | API (Karthik), data (Ishaan) |
| 30-second video + hero GIF | Volk | all | record mode + capture script |
| Project page text + images | Volk | Ishaan | `docs/PAGE.md` built from the API |
| Links, deploy, link previews | Karthik | Volk | |
| README + `/judges` table | Karthik | Ishaan | |
| Every number, Methods, Limits | Ishaan | Karthik | artifacts |

**Priority order:** P1 site passes the 10-second test · P2 project page · P3 video · P4 README · P5 local
pitch.

## 4. Project page: field-by-field copy

(every [bracket] comes from a file, never typed)

**PROJECT NAME:** Mudskipper: proof, not paperwork

**HIGH-LEVEL SUMMARY** (under ~120 words; first sentence must stand alone):

> Mudskipper shows whether rice fields were flooded or drained, using NASA-ISRO NISAR radar, which sees
> through monsoon clouds and the crop canopy. Farmers in Punjab, India are now paid to drain fields: carbon
> credits for alternate wetting and drying, and a state subsidy for direct-seeded rice. Checks are done on
> foot. We processed [N] NISAR passes over [N] fields in [districts] for the 2026 season, labeled each field
> flooded, drained or uncertain on every pass, and measured how much a 12-day satellite can and cannot
> verify. Mudskipper then ranks which fields most need an inspection. It is open, free, and honest about its
> limits.

**DETAILED DESCRIPTION** (these headers, one image under each):

- **What it does:** per-field evidence, the Detectability Lab, inspection ranking.
- **How it works:** NISAR GCOV → scattering components → per-pass state → season verdict → ranked
  inspections. State the polarization mode used: [quad-pol or HH/HV].
- **What we found:** [N]% of fields had enough clear looks; with [N] passes a true AWD field is caught dry at
  least [k] times [N]% of the time; the [district] comparison table.
- **What it cannot do:** the Limits box, word for word from the site.
- **Who it is for:** subsidy offices, carbon auditors and buyers, researchers, farmers proving their work.
- **Built with:** Python, NISAR GCOV, Cloudflare Workers/D1/R2, MapLibre, TypeScript.
- **What's next:** field-sensor partners, every rice basin, an open API.

**DATA & ATTRIBUTION**

- **NASA DATA:** NISAR L2 GCOV, provisional, CRID [x], [N] granules (IDs on the provenance page); OPERA DSWx
  [NI/S1/HLS] if the cross-check ran.
- **PARTNER & OTHER DATA:** ISRO NISAR S-band via Bhoonidhi (only if used); Sentinel-2 via Fields of The
  World; Han et al. 2022 rice map; Punjab Agriculture Dept DSR figures; Ricemapper (MIT), pyNISAR (GPL-3.0),
  PMTiles (BSD). List every library.
- **AI USE:** Claude Code assisted with code and drafting. Every number comes from code run on the listed
  data. No AI-generated images [or: watermarked where used].
- **LINKS:** site, repo, video. All public, no login.

## 5. Images for the page

(JPG/PNG/GIF, each under 10 MB; captions baked in)

1. **Hero GIF, top of page:** season animation, fields flipping water to mud, pass dates ticking, data-gap
   band visible. 6–8 s loop, 1200 px wide.
   - Caption: "Rice fields, [district], Jun–Oct 2026 · NASA-ISRO NISAR".
2. **Field card:** "Caught drained on [x] of [n] clear looks".
3. **Detectability chart:** with the one-sentence result.
4. **Scarecrow list + map:** with "Ranking for inspection, not a finding about anyone."
5. **Pipeline diagram (5 boxes):** with the three evidence tags.

All five come out of `npm run capture`. Each must read as a phone thumbnail.

## 6. The site: 10-second test

- **Core experience:** Without scrolling or tapping, a judge must see: the question; the map already animating
  real fields; one number in plain words; buttons "See it in 45 seconds" and "For judges".
- **Requirements:** under 3 s on mobile data; portrait works; no login; no blank states; the link preview
  (image + title) looks right when pasted into a chat.
- **`/judges` page:** five criteria, each with one sentence and one link into the app.

## 7. The 30-second video

(over 30.0 s = no Global Judging; target 29.0 s)

- Design for mute, phone, first 3 seconds. Captions burned in, max 7 words.
- Recorded by the capture script from the site's record mode, not by hand.

| Time | Picture | Caption |
|------|---------|---------|
| 0:00–0:03 | Fields flipping water→mud, full frame; corner: "[Team] · Dancing with the SARs" | Was this rice field really drained? |
| 0:03–0:07 | Two stat cards | Farmers are paid to drain fields. Checks happen on foot. |
| 0:07–0:10 | Logo card | Mudskipper: proof, not paperwork |
| 0:10–0:16 | Season animation, pass chips, gap band | NASA-ISRO NISAR sees through clouds and crop |
| 0:16–0:20 | Field card opens | Flooded, drained, or not enough evidence |
| 0:20–0:24 | Lab chart, slider moves once | We measure what 12 days can't see |
| 0:24–0:28 | Scarecrow list fills | Inspectors go where it matters |
| 0:28–0:30 | End card: URL | Free, open NASA data |

- Voiceover optional; it must add nothing the captions lack.
- Export 1920×1080 H.264 plus a 1080×1920 cut. Upload to YouTube (public) AND Google Drive (anyone with link).
  Open both in a private window on a phone before submitting.
- Note: No NASA logos. Sample data keeps its SAMPLE badge on screen.

## 8. Criterion → evidence

(also on `/judges` and in the README)

| Criterion | What we show |
|-----------|--------------|
| Impact | Rs 61 crore DSR subsidy checked by hand; 1.5M rice credits committed in 2026; groundwater + methane; four named user groups |
| Creativity | A tool that measures its own blind spots and turns them into an inspection plan |
| Validity | Peer-reviewed physics; reference-checked decomposition; district table; NASA OPERA cross-check; Limits box; no invented accuracy |
| Relevance | NISAR GCOV at the core; polarizations; time series; human driver on natural resources; NASA-ISRO partnership |
| Presentation | Hero animation, 45-second tour, phone-first, three evidence tags |

## 9. Awards we aim at

Targets: Best Use of Science (primary) · Best Use of Data · Galactic Impact · Local Impact.
A science judge should see method and limits on the first screen of the page.

## 10. Honesty rules

- No field accuracy percentage. No "beats Microsoft". No measured methane tonnes.
- "Satellite evidence", never "proof of". "Not consistent with AWD", never "cheating".
- DSR is a signal, not proof. We show irrigation evidence, not emissions.
- Sample or synthetic data is labeled on screen, on the page and in the video.
- If quad-pol was unavailable, say so in the summary and say why it matters.

## 11. Local pitch (2:00)

(Karthik opens and closes, Volk drives the site, Ishaan takes science questions)

Flow: 0:00 the question + two facts · 0:40 tour on the deployed site · 1:45 close: "It tells you what space
can prove, what it can't, and where to look."

Handling Q&A:

- "12 days is too slow." → We measured exactly how often it catches AWD. That's the Lab.
- "How accurate?" → No 2026 ground truth exists, so we claim none; here are our checks.
- "Microsoft did this." → With Sentinel-1 in 2024. We credit them and add NISAR, detectability and triage.
- "Surveillance?" → Evidence for programs farmers opt into; we never label a person.

## 12. Presentation timeline

- H+4: Hero animation live on sample data, deployed
- H+10: Page draft v1 + hero GIF
- Day 2 Morning: Real images and numbers
- Day 2 Midday: Video recorded
- Freeze (deadline −3 h): Page final, links tested in a private window · then submit.

Submission opens Sat 9:00 a.m. local; confirm the closing time in the 2026 guide.

## 13. Final checklist

- [ ] Site passes the 10-second test on two phones
- [ ] Tour runs unattended
- [ ] Hero GIF under 10 MB at top of page
- [ ] Video ≤ 30.0 s, captions burned in
- [ ] All links open in a private window, no login
- [ ] Every number traced to a file
- [ ] NASA data, partner data, libraries, AI use listed
- [ ] Limits box on page and site
- [ ] Repo public, README has the criterion table
- [ ] "Submit for Judging" clicked early
