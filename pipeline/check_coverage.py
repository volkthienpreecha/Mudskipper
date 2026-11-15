"""A6 coverage check: which NISAR GCOV passes cover Fazilka-Muktsar, Kharif 2026."""
import collections, os, asf_search as asf

AOI = "POLYGON((73.9 30.1, 74.7 30.1, 74.7 30.6, 73.9 30.6, 73.9 30.1))"
res = asf.search(dataset="NISAR", intersectsWith=AOI, start="2026-06-17", end="2026-10-31")
print("raw results:", len(res))
g = collections.defaultdict(list)
for r in res:
    p = r.properties
    n = p.get("fileID") or p.get("fileName") or p.get("sceneName") or os.path.basename(p.get("url", ""))
    if "_GCOV_" not in n:
        continue
    t = n.split("_")  # ..._GCOV_CYL_TRACK_DIR_FRAME_MODE_POL_S_START_END_CRID...
    g[(t[5], t[6], t[7], t[9], t[13] if len(t) > 13 else "?")].append(t[11][:8])
for k, d in sorted(g.items(), key=lambda x: -len(x[1])):
    print("track %s dir %s frame %s pol %s crid %s:" % k, len(d), sorted(set(d)))
print("QUAD-POL FOUND" if any(k[3].startswith("QP") for k in g) else "NO QUAD-POL")
