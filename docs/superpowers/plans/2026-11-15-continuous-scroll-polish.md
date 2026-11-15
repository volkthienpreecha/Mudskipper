# Continuous scroll polish

Additional direction: apply the supplied ROMANS WOFF to the entire page, including controls, charts and legal pages. Verify font loading, responsive wrapping and pin fit.

User direction: blend section transitions, shorten dead scrolling, preserve the blue/rice animation, introduce the brand as a rounded rectangle with the fish logo, remove manual pause controls and repair season dividers.

Implementation: shared read-before-write frame scheduler; cached scene geometry; unchanged offscreen stages skipped; shorter pin distances; overlapping visual stage fades; rectangle-to-full-frame brand mask and ice handoff. Metric labels remain fixed. Actual field, pass, model and API operations are preserved. System reduced motion and normal-flow fit fallbacks remain available.

Validation: build and adapter suite; complete accessibility/journey browser suite; live backend/tool smoke checks; desktop and phone visual inspection. Controlled 1440x900 browser trace under 4x CPU throttling: final ROMANS build p95 frame gaps 116.6ms to 66.7ms, long-task total 5959ms to 4244ms. Median 66.7ms to 50ms; this does not establish 60fps. Offscreen scene updates: zero mutations over 30 frames in the analysis section. Independent review before merge; verify production after auto-deploy.

Review repairs are covered by regressions: the journey host must be focusable before a chapter becomes inert; all Astryx body/heading/code tokens must use the supplied font; reduced-motion assertions wait for scene layout to finish. All 10 journey and 11 adapter checks passed. Accessibility/keyboard states passed; one live API dataset timeout passed its focused rerun. Production verification follows deployment. No global memory or policy changes were made.
