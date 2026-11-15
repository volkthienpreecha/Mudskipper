# Design context

## Current direction

The November 15 user brief replaces the tilted-card hero and warm orbital ribbon with a blue, scroll-led field story. Reference Philyron only for passive-scroll pacing and sticky storytelling; use original Mudskipper copy, assets and composition. The physical scene is a judge watching the field story on a large screen, followed by an inspector reading evidence at a desk. A drenched navy/cobalt opening becomes a solid ice-toned field instrument and readable product surfaces.

Palette: night #091b45, cobalt #244fb6, mist #94baf0, ice #e9f2fc and ink #112348. Flooded observations use cobalt; drainage retains burnt red; uncertainty is slate hatching. The signature is an orbital radar swath crossing a blurred blue horizon. The atmosphere is original SVG, not a Philyron asset. Keep solid step controls, never translucent selection pills. Avoid emoji, highlighted evidence tags, generic card grids and defensive prose.

Typography: -apple-system, BlinkMacSystemFont, system-ui, Segoe UI, sans-serif throughout. San Francisco is supplied by Apple devices; other platforms use their native system font. Never redistribute Apple font files. Use large medium-weight thesis type, compact semibold instrument labels, normal tracking for controls and tabular measurement numerals. Touch controls have at least 44px targets and visible keyboard focus.

## Story and motion

The headline states the purpose in one sentence: “Use satellite radar to check whether rice fields were drained.” The hero uses original animated water contours, with damped pointer ripples, over the blue atmosphere. Canvas resolution is capped at DPR 1.5 and 96×60 samples with a 30 fps ceiling; rendering stops offscreen, hidden, paused or under reduced motion. Avoid a second full-screen turbulence filter.

The entire desktop scene pins inside a bounded scroll section. One normalized timeline sends an original satellite diagram out of frame, reveals the actual satellite map, zooms fifteenfold into the selected field, then contracts the map and brings its actual pass record into view. Reserve the measured record height when sizing the final camera; every measurement must fit inside the clipping boundary. The satellite drawing illustrates radar observation, not a technical reconstruction of the NISAR spacecraft. Scene buttons support direct and keyboard navigation, including while paused. Inactive chapters are inert. Passive scroll never takes over document scrolling. Phones, short viewports, enlarged text and reduced motion retain all chapters and the complete field record in normal flow. Preserve direct map access and all existing analysis tools.

The map renderer, country-to-district-to-field composition and explanatory components originated in IshaanLingichetty/mudskipper-redesign at 78e30453e48eca0c2c1dc6db2d172bd3fc9d4423. Stripe/Animata informed previous component composition; genuine Astryx controls remain in use. The earlier frontend is preserved in git history at f964c52. Historical palette instructions are superseded by the current direction above.

## Data boundaries

The published API run is the default: r01v1, 5,000 grid-derived field segments, nine used passes out of twelve candidates, and 45,000 HH/HV observations. Expose actual hhhv_v1 probabilities, confidence, available polarimetry, coverage, flags and AWD/DSR assessments without inventing absent measurements. The 375-field snapshot remains an explicit archive. Keep each dataset’s geometry, states, pass IDs, observations, summaries and audit results together. Never attach published-run measurements to archive or FTW field IDs. Archive confidence is not flooded probability or accuracy. Analysis follows the selected run and shared core math. Source attribution and factual run metadata remain ordinary text.
