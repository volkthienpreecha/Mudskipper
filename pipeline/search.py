"""Step 1: build passes.json (B3.2). No credentials needed.

Series (decided from the A6 coverage check, logged for DECISIONS.md):
  main:  dual-pol, ascending, frame 017, track 084, CRID P05023.
         Track 156 was tested: its valid swath starts at ~74.77 E (at 30.4 N), east of
         both current tiles, so it adds no looks there. Tiles placed between ~74.77 and
         ~75.32 E would be seen by BOTH tracks (~6-day revisit); add ("156","A","017","DH")
         to MAIN if aoi.json moves there. Each track is classified separately.
  --qp:  quad-pol, descending, track 135 frame 073 (4 mid-season passes) -> passes_qp.json
Passes inside the permanent data gap, outside the season, with another CRID, or
listed in EXCLUDE are kept in the file with used=false and a reason. Never invented.
Usage: python pipeline/search.py [--qp]
"""
import argparse, json, os, datetime as dt
import asf_search as asf

AOI = "POLYGON((73.9 30.1, 74.7 30.1, 74.7 30.6, 73.9 30.6, 73.9 30.1))"
SEASON = ("2026-06-17", "2026-10-23")
GAP = (dt.datetime(2026, 7, 27, 22, 3, 25), dt.datetime(2026, 8, 10, 0, 55, 27))
CRID = "P05023"
MAIN = [("084", "A", "017", "DH")]
QP = [("135", "D", "073", "QP")]
# filled from the per-pass radiometry check (median cropland HH far outside the series range)
EXCLUDE = {"p20260620": "radiometric outlier: tile HH median ~+14 dB vs -4..-16 dB for all other passes"}
RUN = os.environ.get("RUN_ID", "r01")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--qp", action="store_true")
    ap.add_argument("--tracks", help="override main tracks, e.g. 084,156 (trial runs)")
    a = ap.parse_args()
    series = QP if a.qp else MAIN
    if a.tracks:
        series = [(t, "A", "017", "DH") for t in a.tracks.split(",")]
    out_path = os.path.join("artifacts", RUN, "passes_qp.json" if a.qp else "passes.json")
    res = asf.search(dataset="NISAR", intersectsWith=AOI, start=SEASON[0], end="2026-10-31")
    passes, seen = [], set()
    for r in res:
        p = r.properties
        n = p.get("fileID") or p.get("fileName") or p.get("sceneName") or ""
        if "_GCOV_" not in n or not str(p.get("url", "")).endswith(".h5") or n in seen:
            continue
        t = n.split("_")  # ..._GCOV_CYL_TRACK_DIR_FRAME_MODE_POL_S_START_END_CRID...
        track, d, frame, pol, start = t[5], t[6], t[7], t[9], t[11]
        crid = t[13] if len(t) > 13 else "?"
        if (track, d, frame, pol[:2]) not in series:
            continue
        seen.add(n)
        when = dt.datetime.strptime(start[:15], "%Y%m%dT%H%M%S")
        pid = when.strftime("p%Y%m%d")
        reason = None
        if crid != CRID:
            reason = f"crid {crid} != {CRID} (one CRID per series)"
        elif GAP[0] <= when <= GAP[1]:
            reason = "inside permanent data gap"
        elif not (SEASON[0] <= when.strftime("%Y-%m-%d") <= SEASON[1]):
            reason = "outside season"
        elif pid in EXCLUDE:
            reason = EXCLUDE[pid]
        passes.append({
            "pass_id": pid, "granule_id": n, "datetime": when.isoformat() + "Z",
            "direction": "ascending" if d == "A" else "descending", "track": int(track), "frame": int(frame),
            "pol_mode": pol[:2], "covariance_terms": [], "crid": crid,
            "maturity": "provisional" if crid == "P05023" else "validated", "pixel_m": None,
            "valid_fraction_by_tile": {}, "used": reason is None, "excluded_reason": reason, "url": p.get("url"),
        })
    passes.sort(key=lambda x: (x["datetime"], x["crid"]))
    best = {}
    for x in passes:  # same acquisition delivered twice: keep the newest product version
        if x["used"] and (x["pass_id"] not in best or x["granule_id"] > best[x["pass_id"]]["granule_id"]):
            best[x["pass_id"]] = x
    for x in passes:
        if x["used"] and best[x["pass_id"]] is not x:
            x["used"], x["excluded_reason"] = False, "superseded by newer product version of the same acquisition"
    ids = [x["pass_id"] for x in passes if x["used"]]
    assert len(ids) == len(set(ids)), "duplicate used pass_id"
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path, "w") as f:
        json.dump({"v": 1, "run_id": RUN, "passes": passes}, f, indent=1)
    for x in passes:
        print(x["pass_id"], "track", x["track"], x["crid"], x["pol_mode"], "USED" if x["used"] else f"excluded: {x['excluded_reason']}")
    print(f"{len(ids)} used / {len(passes)} -> {out_path}")


if __name__ == "__main__":
    main()
