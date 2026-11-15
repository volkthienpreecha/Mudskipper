# Mudskipper frontend

The production entrypoint is the imported Ishaan redesign, with Apple-first system typography, its Earth/field photography and country-to-field map. Source revision and licences are recorded in REDESIGN_SOURCE.md. The prior dashboard was removed from the tree; it is in git history at commit f964c52 (`app/legacy/solid-dashboard`).

The type stack uses San Francisco on Apple devices and the native system sans serif on other platforms. Apple font files are not redistributed. See HIG_REVIEW.md for the design checks and refinements.

Run from the repository root with Node 24.12 or newer:

```sh
npm ci
npm run dev -w @mudskipper/app
npm test -w @mudskipper/app
npm run build -w @mudskipper/app
```

The default `2026 radar snapshot` contains the original 375 r01v1 segments, nine acquisition dates, state labels, HH measurements and classifier confidence. The `Published API run` selector loads the owning backend as a complete alternate dataset through @mudskipper/core/client. Its geometry, pass IDs, state matrix, summaries and lazy measurements must share run_id and fixture identity. VITE_API_BASE_URL overrides the backend origin; the default is https://mudskipper-nisar.pages.dev. There is no substitution of sample API measurements onto snapshot polygons.

Published-run analysis includes detectability simulation, inspection ranking, checks and provenance. Radar images require an exact pass/tile entry from the matching run's overlay index; unsupported passes clear the old raster. Snapshot confidence is not flooded probability. Actual API p_flooded and classifier methods are displayed only when supplied in validated field details.

Karthik's shared geo bundles and Ishaan's complete pipeline bundles transfer through platform/scripts/run_transfer.py. Real API activation requires a full matching measurement run and published-stage validation, not a geo-only success. See the repository README and platform/README.md for that owning workflow.
