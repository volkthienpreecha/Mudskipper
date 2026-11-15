# Frontend verification

The component release preserves the authored photographic map UI and adds live-run visual demonstrations with genuine Astryx controls.

Verified under Node24.12:

- 11 adapter tests cover archive data, API identity/geometry/pass alignment, observations and optional assets.
- TypeScript and production Vite build pass. Component code loads separately after the map/run is ready.
- All 12 real-browser accessibility and keyboard tests pass, including all published analysis tabs, field selection, error states, stale-response clearing, focus restoration, phone390/320 reflow, 200% zoom and legal pages. Axe uses WCAG2.0/2.1/2.2 A/AA tags.
- Live r01v1 serves5000 grid-derived segments,9 used passes and45000 observations. The browser adapter and local core simulation agree with the owning API. Archive375 remains explicit and separate.
- Actual Astryx tabs, tutorial-to-map navigation, scientific stage controls, measured HH, API GET responses, retry, clipboard invalidation and Pause animations were exercised in Chromium.
- Selection follows the field boundary. Country circles and native tap highlights are suppressed in field mode; keyboard selection keeps a dashed focus stroke.
- Independent review found and repaired field-focus loss, failed-check retry and stale API copying. No remaining material findings.

Pipeline/backend verification and the unavailable raw/internal input boundary are documented in ../pipeline/INTEGRATION.md. The published run's declared outputs are validated; physical model fitting is not independently rerun without those inputs.

Release CI and public Vercel verification are the final deployment gates.
