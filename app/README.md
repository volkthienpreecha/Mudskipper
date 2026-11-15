# Mudskipper frontend

The production entrypoint is the imported Ishaan redesign, with Apple-first system typography, its Earth/field photography and country-to-field map. Source revision and licences are recorded in REDESIGN_SOURCE.md. The prior dashboard was removed from the tree; it is in git history at commit f964c52 (`app/legacy/solid-dashboard`).

The type stack uses San Francisco on Apple devices and the native system sans serif on other platforms. Apple font files are not redistributed. See HIG_REVIEW.md for the design checks and refinements.

Run from the repository root with Node 24.12 or newer:

```sh
npm ci
npm run dev -w @mudskipper/app
npm test -w @mudskipper/app
npm run build -w @mudskipper/app
npm run test:a11y -w @mudskipper/app
```

The default `Published model run` loads r01v1 from the owning backend: 5,000 grid-derived segments, nine used dates, 45,000 observations, method hhhv_v1. `Archive · 375-field snapshot` retains the original scene data as an explicit alternate source. The adapter requires geometry, pass IDs, states, details and summaries to agree on identity. VITE_API_BASE_URL overrides https://mudskipper-nisar.pages.dev. Archive confidence is not inverted into a probability.

`src/components.ts` composes interactive field-evidence flow, field/pass walkthrough, conceptual radar scenes with measured HH, and a live request console. `src/astryx-controls.ts` mounts genuine Astryx Button and TabList controls in React islands; the existing map renderer remains imperative. Those demonstration modules load after the map/run is ready. See COMPONENT_SOURCE.md for versions and licences.

Published analysis provides simulation controls, pass schedule, ranked sample-claim inspection/export, full field observation and AWD/DSR evidence, checks, provenance and published assets. Null assets stay unavailable; they never fall back to fixture IDs. Radar overlays require matching exact pass/tile and clear when unsupported. Data suggests fields across the entire run while the search suggestion DOM is bounded to forty results.

Karthik's shared geo bundles and Ishaan's complete pipeline bundles transfer through platform/scripts/run_transfer.py. Real API activation requires a full matching measurement run and published-stage validation, not a geo-only success. See the repository README and platform/README.md for that owning workflow.
