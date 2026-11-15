# Design context

## Current direction

The November 15 user brief replaces the tilted-card hero and warm orbital ribbon with a blue, scroll-led field story. Reference Philyron only for passive-scroll pacing and sticky storytelling; use original Mudskipper copy, assets and composition. The physical scene is a judge watching the field story on a large screen, followed by an inspector reading evidence at a desk. A centered watercolor navy/cobalt opening becomes a giant brand transition, then solid ice-toned instruments and readable product surfaces.

Palette: night #091b45, cobalt #244fb6, mist #94baf0, ice #e9f2fc and ink #112348. Flooded observations use cobalt; drainage retains burnt red; uncertainty is slate hatching. The signature is drifting rice grains crossing a watercolor blue sky, followed by an oversized Mudskipper wordmark. Philyron informs the pacing; its artwork and copy are not used. Use scroll stages for explanations and solid controls for actual data operations. Avoid emoji, highlighted evidence tags, generic card grids and defensive prose.

Typography: -apple-system, BlinkMacSystemFont, system-ui, Segoe UI, sans-serif throughout. San Francisco is supplied by Apple devices; other platforms use their native system font. Never redistribute Apple font files. Use large medium-weight thesis type, compact semibold instrument labels, normal tracking for controls and tabular measurement numerals. Touch controls have at least 44px targets and visible keyboard focus.

## Story and motion

The latest user direction centers the hero and desktop navigation, shortens the headline to “Check rice-field drainage from space,” and renames Our story to How it works. Use the supplied blue watercolor image at public/img/rice-sky.png under a diffused gradient. It is a user-provided asset; do not substitute generated contour wallpaper. Transparent rice-grain particles surround the hero and a giant Mudskipper interlude before the satellite. The wordmark rises, grows and recedes with native scrolling. Rice canvases cap DPR at 1.5 and particles at 88 desktop/36 phone, and stop rendering offscreen, hidden, paused or under reduced motion.

Scroll is the narrative navigation. The satellite→field→evidence scene, drainage claims→monsoon radar→inspection priorities, field selection→passes→record, and early-season→rice-canopy→cross-check explanation advance through persistent stages. Remove three-button stage selectors and Next-step links. Actual field and pass controls, model settings, inspection tools and API endpoints remain usable. Preserve stage, focus, selected identity and scroll position across dataset redraws. Inactive stages are inert; move focus to the sequence host before hiding a focused visual. All science SVG IDs and control labels must be unique.

The actual season chart is revealed across the acquisition timeline without changing measurements or statistics. Its legend and table control must fit below navigation; use a normal-flow fallback if the measured control boundary cannot fit, and when the data table is open. Keep every narrative stage and complete record visible in normal flow on phones, short viewports, enlarged text, reduced motion or Pause animations. Scrolling never intercepts wheel/key events or advances itself.

The map renderer, country-to-district-to-field composition and explanatory components originated in IshaanLingichetty/mudskipper-redesign at 78e30453e48eca0c2c1dc6db2d172bd3fc9d4423. Stripe/Animata informed previous component composition; genuine Astryx controls remain in use. The earlier frontend is preserved in git history at f964c52. Historical palette instructions are superseded by the current direction above.

## Data boundaries

The published API run is the default: r01v1, 5,000 grid-derived field segments, nine used passes out of twelve candidates, and 45,000 HH/HV observations. Expose actual hhhv_v1 probabilities, confidence, available polarimetry, coverage, flags and AWD/DSR assessments without inventing absent measurements. The 375-field snapshot remains an explicit archive. Keep each dataset’s geometry, states, pass IDs, observations, summaries and audit results together. Never attach published-run measurements to archive or FTW field IDs. Archive confidence is not flooded probability or accuracy. Analysis follows the selected run and shared core math. Source attribution and factual run metadata remain ordinary text.
