"""Step 6b: provenance.json (B3.9).

{git_sha, created_at, granules:[{granule_id, crid, subset_sha256}], artifacts:[{path, sha256}],
 decomposition_check:{reference, max_abs_diff_db}}
subset_sha256 comes from the data/<pass>_<tile>.npz.json sidecars written by fetch.py.
decomposition_check comes from fd_crosscheck.py (freeman_durden.py vs polsartools on real quad-pol pixels).
"""
import datetime as dt, glob, hashlib, json, os, subprocess

RUN = os.environ.get("RUN_ID", "r01")
ART = os.path.join("artifacts", RUN)


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()


def main():
    try:
        sha = subprocess.run(["git", "rev-parse", "HEAD"], capture_output=True, text=True, check=True).stdout.strip()
    except Exception:
        sha = None  # repo has no commits yet
    passes = json.load(open(os.path.join(ART, "passes.json")))["passes"]
    used = {p["pass_id"]: p for p in passes if p["used"]}
    granules = []
    for pid, p in sorted(used.items()):
        subs = {}
        for side in sorted(glob.glob(f"data/{pid}_*.npz.json")):
            s = json.load(open(side))
            subs[s["tile"]] = s["subset_sha256"]
        granules.append({"granule_id": p["granule_id"], "pass_id": pid, "crid": p["crid"], "subset_sha256": subs})
    arts = [{"path": os.path.relpath(f, ART).replace("\\", "/"), "sha256": sha256(f)}
            for f in sorted(glob.glob(os.path.join(ART, "**", "*"), recursive=True))
            if os.path.isfile(f) and not f.endswith("provenance.json")]
    out = {"v": 1, "run_id": RUN, "git_sha": sha, "created_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
           "granules": granules, "excluded": [{"granule_id": p["granule_id"], "reason": p["excluded_reason"]}
                                              for p in passes if not p["used"]],
           "artifacts": arts, "decomposition_check": None}
    fdc = os.path.join(ART, "fd_crosscheck.json")
    if os.path.exists(fdc):  # written by fd_crosscheck.py
        c = json.load(open(fdc))
        out["decomposition_check"] = {"reference": c["reference"], "max_abs_diff_db": c["max_abs_diff_db"],
                                      "n_pixels": c["n_pixels"]}
    s1 = os.path.join(ART, "s1_fields.jsonl")
    if os.path.exists(s1):  # second radar used in early-season fusion (classify.py v6)
        ids = sorted({json.loads(l)["s1_id"] for l in open(s1)})
        out["ancillary"] = {"sentinel1_rtc": {"source": "Microsoft Planetary Computer, collection sentinel-1-rtc",
                                              "scenes": ids},
                            "sentinel2_l2a_validation": {"source": "Element84 Earth Search, sentinel-2-l2a",
                                                         "use": "validation only (optical_check.py), never training"},
                            "landcover": "ESA WorldCover 2021 v200, class 40 cropland"}
    json.dump(out, open(os.path.join(ART, "provenance.json"), "w"), indent=1)
    print(f"{len(granules)} granules, {len(arts)} artifacts -> {ART}/provenance.json")


if __name__ == "__main__":
    main()
