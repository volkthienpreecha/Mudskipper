# Component sources

The photographic environment and map composition originate in [Ishaan's redesign](https://github.com/IshaanLingichetty/mudskipper-redesign/tree/78e30453e48eca0c2c1dc6db2d172bd3fc9d4423). The component pass replaces its text-heavy explanatory sections at the user's request.

- [Astryx](https://github.com/meta/astryx), MIT. The reference repository was downloaded at `82246df6af1349b63dcfb0038419838e7b857725`. The app uses published `@astryxdesign/core` **0.7.16**, React/React DOM **19.3.1**, and StyleX **0.19.2**. `astryx-controls.ts` uses actual Button and TabList primitives, themed to Mudskipper's palette and system fonts. The licence is distributed in `public/licenses/astryx.txt`.
- [Animata](https://animata.design/components), MIT. Its fluid-tab, timeline and beam interaction patterns informed the original native SVG/CSS demonstrations. The field geometry, calendar-spaced observation plots, radar scenes and run-aware request controller are application components.

The map uses its existing renderer. Additional component code loads after the selected dataset is ready. The existing animation toggle and system reduced-motion preference apply to all new motion. API responses and model values come from the owning backend; conceptual radar artwork is identified separately from measurements.
