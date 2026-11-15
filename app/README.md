# Mudskipper app

Install dependencies from the repository root. Run `npm run dev -w @mudskipper/app`. The default client uses `https://mudskipper-nisar.pages.dev`; set `VITE_API_BASE_URL` to another API origin. Set `VITE_DATA_SOURCE=fixtures` explicitly for the bundled sample fixtures. `VITE_BASEMAP_URL` may replace the contextual raster tile URL. API failures are surfaced; there is no automatic fixture fallback.

Run `npm run build -w @mudskipper/app` and `npm run typecheck -w @mudskipper/app`. Font licenses are in `public/fonts`.
