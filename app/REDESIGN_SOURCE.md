# Frontend source

Design and original snapshot/map renderer imported from [IshaanLingichetty/mudskipper-redesign](https://github.com/IshaanLingichetty/mudskipper-redesign), revision `78e30453e48eca0c2c1dc6db2d172bd3fc9d4423`, at the project owner's request. The r01v1 snapshot and imagery metadata are preserved. The original frontend is in git history at commit f964c52 (`app/legacy/solid-dashboard`).

Integration adds the shared core API client, explicit coherent dataset selection, lazy field measurements, indexed radar imagery, detectability simulation, inspection ranking and source evidence. Snapshot confidence is kept as confidence; it is never reconstructed into flooded probability. Scientific thresholds and publication checks are unchanged.

Map imagery: Sentinel-2 cloudless 2016 by EOX IT Services GmbH, CC BY 4.0, containing modified Copernicus Sentinel data 2016. Country borders: Natural Earth, public domain. API-run contextual imagery uses Esri and contributors. Source photo and software credits remain on the credits page. Typography now uses the user-supplied ROMANS Regular WOFF in `public/fonts`, with native system fonts as fallback.

Polish follows Unslop by Damir Sokolovsky (@heydamir), CC BY 4.0, https://github.com/heydamir/unslop, and the installed Impeccable workflow.
