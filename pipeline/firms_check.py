"""Real-world check with NASA VIIRS active fires (FIRMS data): stubble burning follows paddy harvest.

Punjab farmers burn rice stubble days after harvest, and paddies are drained ~1–2 weeks before harvest.
A field under a VIIRS 375 m fire pixel is therefore (a) almost surely paddy and (b) harvested soon after.
Fire pixel -> fields whose centroid lies within 190 m of the fire centre (half a 375 m pixel).
Tests (fire data never used in the model):
  1. drained_before_burn : share drained on the last NISAR pass before the first fire, burned vs unburned fields
                           (same pass). Expect burned > unburned.
  2. timing              : first-fire date of fields drained vs flooded on the last October pass.
                           Expect drained fields to burn earlier.
Output: artifacts/<run>/firms_check.json
"""
import collections, datetime as dt, json, os, sys
import numpy as np
from pyproj import Transformer
from zonal import REF_PASS, field_id

RUN = os.environ.get("RUN_ID", "r01")
ART = os.path.join("artifacts", RUN)
R_M = 190.0


def centroids(tile):
    ref = np.load(f"data/{REF_PASS}_{tile}.npz"); seg = np.load(f"data/segments_{tile}.npz")
    lab = seg["labels"]; res = 10 * int(seg["ml"])
    rr, cc = np.indices(lab.shape); m = lab > 0
    n = np.bincount(lab[m]); sx = np.bincount(lab[m], weights=cc[m]); sy = np.bincount(lab[m], weights=rr[m])
    ok = n > 0
    x = ref["x"][0] - 5 + (sx[ok] / n[ok] + 0.5) * res
    y = ref["y"][0] + 5 - (sy[ok] / n[ok] + 0.5) * res
    return np.nonzero(ok)[0], x, y, int(ref["epsg"])


def main():
    obs = collections.defaultdict(dict); tiles = set()
    for l in open(os.path.join(ART, "observations.jsonl")):
        r = json.loads(l); obs[r["field_id"]][r["pass_id"]] = r["inferred"]["state"]; tiles.add(r["tile"])
    dates = {p["pass_id"]: dt.date.fromisoformat(p["datetime"][:10])
             for p in json.load(open(os.path.join(ART, "passes.json")))["passes"] if p["used"]}
    fires = [json.loads(l) for l in open("artifacts/firms_fires.jsonl") if '"lat"' in l]
    first = {}
    for tile in sorted(tiles):
        ids, x, y, epsg = centroids(tile)
        tr = Transformer.from_crs(4326, epsg, always_xy=True)
        for f in fires:
            fx, fy = tr.transform(f["lon"], f["lat"])
            near = np.nonzero((x - fx) ** 2 + (y - fy) ** 2 <= R_M ** 2)[0]
            d = dt.date.fromisoformat(f["date"])
            for i in near:
                fid = field_id(tile, int(ids[i]))
                if fid in obs and (fid not in first or d < first[fid]):
                    first[fid] = d
    res = {"n_fire_detections": len(fires), "n_burned_fields": len(first), "n_fields": len(obs)}
    # 1. drained share on the last pass before the first fire, burned vs all unburned on that same pass
    per_pass = collections.defaultdict(lambda: [collections.Counter(), collections.Counter()])
    for fid, d in first.items():
        prior = [p for p in dates if dates[p] < d and p in obs[fid]]
        if prior:
            p = max(prior, key=lambda k: dates[k])
            per_pass[p][0][obs[fid][p]] += 1
    for p, (b, u) in per_pass.items():
        for fid, st in obs.items():
            if fid not in first and p in st:
                u[st[p]] += 1
    t1 = {}
    for p, (b, u) in sorted(per_pass.items()):
        nb, nu = b["flooded"] + b["drained"], u["flooded"] + u["drained"]
        if nb >= 20:
            t1[p] = {"burned_n": nb, "burned_drained_pct": round(100 * b["drained"] / nb, 1),
                     "unburned_drained_pct": round(100 * u["drained"] / max(nu, 1), 1)}
    res["drained_before_burn"] = t1
    # 2. timing on the last October pass of each track
    t2 = {}
    lastp = sorted((p for p in dates if p >= "p20261001"), key=lambda k: dates[k])
    for p in lastp:
        g = collections.defaultdict(list)
        for fid, d in first.items():
            s = obs[fid].get(p)
            if s in ("flooded", "drained") and d > dates[p]:
                g[s].append((d - dates[p]).days)
        if len(g["flooded"]) >= 10 and len(g["drained"]) >= 10:
            t2[p] = {s: {"n": len(v), "median_days_to_first_fire": float(np.median(v))} for s, v in g.items()}
    res["timing"] = t2
    json.dump(res, open(os.path.join(ART, "firms_check.json"), "w"), indent=1)
    print(json.dumps(res, indent=1))


if __name__ == "__main__":
    main()
