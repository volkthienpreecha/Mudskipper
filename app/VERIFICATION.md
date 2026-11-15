# Frontend verification

Target: Ishaan's imported redesign (source78e3045) with Asimovian and explicit, coherent snapshot/API dataset selection. Earlier MapLibre dashboard evidence is archived in legacy/solid-dashboard/previous-VERIFICATION.md.

Verified locally under Node24.12:

-10 adapter tests covering the authentic375-field snapshot, pass-array alignment, API geometry and identity, lazy observations, optional overlays and HTTP failures.
-Production build and TypeScript; shared core115 tests.
-Country view survives reload; district/field selection, real SVG map click, pass-keyboard navigation, search while playback, browser Back and legacy /lab route work.
-Snapshot r01v1 geometry/states/confidence/HH remain together. Published API details show actual98% flooded probability, fd_gmm_v1, HH/HV/decomposition and matching summary reasons.
-Radar image loads for an indexed pass; changing to an unindexed date removes it.
-Inspection returns exact API ranks. A delayed old20-row response cannot overwrite a newer5-row result after tab navigation.
-API503 stays explicit and preserves the selected snapshot as snapshot; it is never presented as API data.
-Desktop1440, tablet1024 and phone390/375 checks: no horizontal overflow, Asimovian loaded,0tag/kicker/Limits nodes, noemoji. Healthy flows have no page errors; injected error cases are intentional.

Whole-branch review found three navigation defects, all repaired and independently rechecked: stale cross-district selections, country URL restoration and the /lab tool alias. Production URL/browser verification is performed after CI and deployment.
