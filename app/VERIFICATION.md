# Frontend verification — 2026-11-14

Built against repository base 0314f95 and the published Cloudflare API, using the existing core client and simulation. The API served run `fixture`, `fixture: true`; these checks do not establish real NISAR/ground-truth validity.

- Production API-mode build and TypeScript check passed on Node 24.12.0. Explicit fixture-mode build also passed.
- Shared core: 109 tests and all core typechecks passed.
- Live backend smoke: metadata, story, passes, state grid, field geometry and pagination, field details, detectability, checks and provenance; run/fixture consistency; data-gap exclusion; synthetic ranking and stored audit all passed.
- Browser: MapLibre worker loads and polygons render over contextual satellite imagery. Clicking a polygon opens its field. Lab slider changes recalculate through core. Evidence loads; sample badge remains visible. No console errors in successful smoke.
- Responsive screenshots inspected at 1440x1000 and 390x844, with no horizontal overflow; field inspector uses a mobile bottom sheet.
- Review regressions reproduced before fixes, then passed: search survives autoplay, district labels stay synchronized, Back/Forward restores field routes, and a delayed old audit cannot overwrite a newer result.
- Guided tour progression and termination verified using the browser clock at the scheduled scene boundaries; this is not a real-time video export check.

Limitations: default MapLibre bundle emits a size warning; mobile 4G startup budget has not been measured. Satellite basemap dates are contextual, not historical NISAR dates. GeoJSON upload, radar-image overlays and recording/video export are not included in this frontend release. The shared platform suite passed 201 tests but two D1-loader tests and one Pages-start suite could not run successfully on this Windows machine because existing subprocess code spawns the extensionless Wrangler executable (`ENOENT`); platform implementation was not modified.
