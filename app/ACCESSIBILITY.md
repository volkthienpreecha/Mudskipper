# Accessibility (WCAG 2.2 AA)

Target: WCAG 2.2 level AA for the production app (`index.html`, `src/`, the legal pages) and the platform placeholder page. The imported design stays as it is: photography, dark ink palette, teal and coral states, section order and behaviour. The changes add what conformance needs. Decisions are logged as K-330 to K-339 in `DECISIONS.md`.

## How it is checked

| Check | How | Where |
| --- | --- | --- |
| axe-core 4.14 at `wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa`, `wcag22aa` | Headless Chromium (Playwright 1.64), built app. States: home, study area with the field list, field selected, search error, phone menu at 390 px, 320 px, API failure, each analysis tab (Detectability, Inspection with a budget error and a ranked list, Evidence with every disclosure open), a published-run field, and the legal pages. Zero violations allowed. | `test/a11y.test.ts`, CI (`.github/workflows/app.yml`) |
| Keyboard only | Tab through the whole page: every stop must show a focus indicator, sit inside the viewport and not under the fixed navigation; Shift+Tab walks back. Then operate the skip link, a district marker, field arrows, Enter to select, pass chips, slider, play and pause, zoom and pan buttons, Back, the field list, search errors, the season chart, Pause animations, the analysis tabs (arrows, Home, End, Tab into the panel) and an inspection row. | `test/a11y.test.ts` |
| Reflow | No horizontal overflow at 390 px, 320 px and at 200% zoom (1440 × 900 at device scale 2). | `test/a11y.test.ts` |
| Contrast over photography | axe cannot judge text over images, so it is measured: for each scroll position (every third of a viewport) at 1440 × 900 and 390 × 844, record every text box and colour, hide the text, screenshot, and compare the text colour with the brightest 2% of the background pixels in its box. | Measurement results below |
| Screenshots | 1440 × 900, 390 × 844, 320 × 640 and 200% zoom, every section, the map with a focused and a selected field, the phone menu. | Reviewed by eye |

Run locally from the repository root:

```sh
npm run build -w @mudskipper/app
npx playwright install chromium        # once
npm run test:a11y -w @mudskipper/app   # A11Y_OFFLINE=1 skips the published-run states
```

## What changed, by criterion

- **1.1.1 Non-text content.** Satellite map imagery and outlines are hidden from assistive technology; markers and fields carry names. The hero map names its field and location. The season chart has a data table (in a disclosure) and an accessible summary, the HH sparkline's name lists every value, histograms keep their value lists, the pass swatches have spoken states. Decorative icons are hidden.
- **1.3.1 Info and relationships.** One `main`, named navigation landmarks, a single h1 and ordered headings (the field report is an h3), the API table has rows, cells and column headers, the inspection results are an ordered list with spoken column labels, table headers have scopes, and the preview and report are named regions instead of nested complementary landmarks.
- **1.3.3 / 1.4.1 Sensory characteristics and colour.** Flooded and drained swatches carry a drop or crack shape as well as colour; each field's name includes its state; chart data is in a table; instructions say "select" rather than "click".
- **1.4.3 / 1.4.11 Contrast.** A scrim over the photography (off on the desktop hero, where copy sits on the dark edge), an opaque season panel, halos on map labels, a chip behind the hero coordinates, lighter hatching for the uncertain state, an outline on empty swatches, and dark separators between the stacked chart areas.
- **1.4.10 / 1.4.4 Reflow and resize.** Tighter gutters under 400 px, wrapping map controls; no horizontal scroll at 320 px or at 200%.
- **1.4.13 Content on hover or focus.** Escape hides the Legal submenu and the season chart tooltip without moving the pointer or focus.
- **2.1.1 Keyboard.** Field selection by arrow keys over the polygons (Home and End too), by a field list in the report, and by search with suggestions. The season chart reads each pass with the arrow keys. Map panning has buttons.
- **2.2.2 Pause, stop, hide.** "Pause animations" in the navigation stops every looping animation and long transition, is on by default with the reduced-motion setting, and is remembered. The typing caret stops after five seconds. The tour's button becomes "Stop tour" while it runs.
- **2.4.1 Bypass blocks.** "Skip to main content" and "Skip to the map".
- **2.4.3 Focus order.** Focus returns after every re-render (field report, analysis tabs, the dataset menu), moves on when a control disappears (district marker to first field, Back to the first marker), and follows actions that lead elsewhere ("Explore the map" to the first field, an inspection row to the field report). Hidden district markers leave the tab order.
- **2.4.7 / 2.4.11 Focus visible and not obscured.** SVG markers and fields have their own focus styles (a dashed white outline for fields, distinct from the solid selected outline). Scroll padding follows the fixed navigation's measured height, and the phone menu closes when focus leaves it.
- **2.5.3 Label in name.** Inspection rows are named by their visible text; symbol-only buttons have hidden symbols and spoken names.
- **2.5.7 Dragging movements.** Pan left, up, down and right buttons beside zoom and reset.
- **3.3.1 / 3.3.3 Error identification and suggestion.** Field search and the inspection budget mark the field invalid, say what is wrong and what is accepted. The budget limit is the API's 500, not 5,000.
- **4.1.2 Name, role, value.** Tabs follow the ARIA tabs pattern (the panel is focusable), the play button changes its name rather than also being a pressed toggle, the current pass chip is `aria-current`, sliders have spoken values with units.
- **4.1.3 Status messages.** Persistent polite live regions for the map (study area, field opened, playback, dataset loaded), the analysis tools (loading and loaded) and the season chart. Errors use `role="alert"` or the existing status regions.

## What axe cannot judge, and how it was judged

- **Text over photography and satellite imagery** (axe reports 40 to 70 of these as "incomplete" per state): measured as described above. Before: 52 of 362 measured text runs were below their threshold, the worst at 2.1:1 (map labels) and 2.8:1 (analysis text over the analysis photo). After: 0 of 426 (more runs because of the new table, list and controls); the lowest body text is 5.0:1 (the chart table headers at 390 px). One flagged run is the visually hidden label of the phone pause button, which is not shown.
- **Label in name, symbol buttons** (axe "incomplete" on two buttons in the field view): the play button reads "Play season" for visible "Play", which contains the visible text, so it passes 2.5.3.
- **Focus visibility, order and obscuring**: checked at every Tab stop by the keyboard test.
- **Meaningful sequence, sensory instructions, consistent navigation and identification**: reviewed by reading the DOM order and copy.
- **Motion**: the Pause animations control and the reduced-motion setting were checked in the browser.

## Known limits

- **Field polygons smaller than 24 × 24 px** at the study-area zoom. They meet 2.5.8 through its "equivalent" exception: the field list and search select the same fields with full-size targets.
- **Map polygons by colour**: the map itself shows state by colour (teal flooded, coral drained, hatched uncertain). Each polygon's spoken name, the selected field's report and the chart table carry the same information in text.
- **Third-party imagery** (Esri World Imagery in the published run) cannot be described field by field; it is background for the polygons and hidden from assistive technology.
- **Input purpose (1.3.5)** does not apply: the app collects no personal data.
- Screen reader behaviour was reasoned from the accessibility tree and checked through Playwright; it has not been tested with VoiceOver or NVDA by a person.
