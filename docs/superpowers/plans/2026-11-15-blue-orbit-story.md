# Blue orbit story

The approved brief replaces the tilted-card landing page with a blue, scroll-led narrative inspired by Philyron's pacing, not its copy, colors or assets. Preserve the current API, ML analysis, archive choice and system fonts.

1. Replace the opening with a full-bleed cobalt atmospheric horizon and a sparse thesis. Move the existing live field report, with its IDs and controls intact, into a sticky three-stage story: locate a segment, read the passes, inspect evidence. Use real selected-run geometry and measurements in the report.
2. Add a small native scroll controller, separate from data loading, for progress, landscape movement and active chapter emphasis. Never intercept wheel events or alter scroll position. Reduced motion, pause, mobile and enlarged text must retain every chapter and working control.
3. Carry the blue palette through the existing product components with solid, accessible reading surfaces. Update project design context.
4. Verify build, data tests, accessibility suite, scroll/pause/resume/mobile behavior, live API and core analysis flows. Inspect desktop and mobile renders, obtain independent review, fix findings, then merge and verify the existing personal Vercel deployment.

Files: index.html (composition), journey.ts / journey.css (story and motion), blue-theme.css (product palette), main.ts (imports), DESIGN.md (current direction), browser tests (scroll and reduced-motion acceptance).
