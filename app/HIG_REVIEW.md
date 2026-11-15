# Apple Human Interface Guidelines review

Reviewed the active Ishaan redesign against Apple's [Typography](https://developer.apple.com/design/human-interface-guidelines/typography), [Accessibility](https://developer.apple.com/design/human-interface-guidelines/accessibility) and [Buttons](https://developer.apple.com/design/human-interface-guidelines/buttons) guidance. The original photographic scenes, section order, map composition and teal/coral radar states remain the design reference.

| Guidance | Changes |
| --- | --- |
| Legible system typography and a clear hierarchy | Apple-first system sans serif throughout the app and legal pages; regular body text, semibold headings, normal label tracking and tabular measurements. Body text is 17px at the default browser size. |
| Readable small text over imagery | Larger secondary text, brighter muted colors and opaque field-report, date and menu surfaces. |
| Clear action hierarchy and press feedback | Prominent primary action, outlined secondary controls, visible hover/press states and 44px minimum targets for map controls and acquisition buttons. |
| Keyboard access and meaningful control states | Visible focus, a skip-to-map link, named study-area button group with selected state, and inactive country-view controls excluded from focus navigation. |
| Text enlargement and responsive layout | Rem-based interface type, wrapping pass grids, wrapping navigation, stacked phone dataset controls and flexible map overlay bars. |
| Accessibility preferences | Reduced-motion transforms disabled; increased-contrast text and reading surfaces. Existing textual state labels, uncertainty hatching and accessible acquisition names remain. |

San Francisco is supplied by the operating system on Apple devices. Other platforms use their native system sans serif. The [Apple Fonts licence](https://developer.apple.com/fonts/) restricts embedding/distributing Apple font files; no Apple font files are bundled or requested.

Verification includes the production build, ten dataset-adapter tests, rendered desktop/tablet/phone checks, keyboard field/pass navigation, 200% text enlargement, reduced motion and increased contrast. The existing snapshot/API split, field measurements, exact-pass radar overlay, detectability, inspection ranking and evidence views are exercised independently of the type change. The published r01v1 API run is now the default; the older snapshot remains an explicit archive. The pipeline integration and physical-input reproducibility boundary are recorded in pipeline/INTEGRATION.md.
