"""Canopy-regime direction check with quad-pol Freeman-Durden (independent track).

Per quad-pol pass (track 135 D, 20 m) and per field: average covariance terms in
linear units, decompose into Ps/Pd/Pv, and compare the double-bounce share with
the dual-pol label from the nearest dual-pol pass (track 084 A, 3 days earlier).
Physics: water under a canopy raises double bounce. If "flooded" fields show the
higher Pd share, the canopy label direction is supported.
Caveat: 3 days apart and fields can drain within a day, so this is a coarse check.
Output: artifacts/<run>/qp_fields.jsonl, artifacts/<run>/qp_check.json
"""
import glob, json, os, collections, datetime as dt
import numpy as np
from sklearn.metrics import roc_auc_score
from freeman_durden import freeman_durden
from zonal import field_id

RUN = os.environ.get("RUN_ID", "r01")
ART = os.path.join("artifacts", RUN)


def main():
    dh = {p["pass_id"]: p["datetime"][:10] for p in json.load(open(os.path.join(ART, "passes.json")))["passes"] if p["used"]}
    obs = {}
    for l in open(os.path.join(ART, "observations.jsonl")):
        r = json.loads(l)
        obs[(r["field_id"], r["pass_id"])] = r
    out = open(os.path.join(ART, "qp_fields.jsonl"), "w")
    y, s, per = [], [], collections.defaultdict(lambda: collections.defaultdict(list))
    for path in sorted(glob.glob("data/qp_p*_*.npz")):
        pass_id, tile = os.path.basename(path)[3:-4].split("_", 1)
        date = dt.date.fromisoformat(f"{pass_id[1:5]}-{pass_id[5:7]}-{pass_id[7:9]}")
        near = min(dh, key=lambda k: abs(dt.date.fromisoformat(dh[k]) - date))
        d = np.load(path)
        seg = np.load(f"data/segments_{tile}.npz")
        ref = np.load(sorted(glob.glob(f"data/p2026*_{tile}.npz"))[0])
        res = 10 * int(seg["ml"])
        col = np.floor((d["x"] - (ref["x"][0] - 5)) / res).astype(int)
        row = np.floor(((ref["y"][0] + 5) - d["y"]) / res).astype(int)
        L = seg["labels"]
        inside = (row[:, None] >= 0) & (row[:, None] < L.shape[0]) & (col[None, :] >= 0) & (col[None, :] < L.shape[1])
        lab = np.where(inside, L[np.clip(row, 0, L.shape[0] - 1)][:, np.clip(col, 0, L.shape[1] - 1)], 0)
        m = d["mask"]
        use = (m > 0) & (m < 255) & np.isfinite(d["HHHH"]) & (d["HHHH"] > 0) & (lab > 0)
        nl = int(L.max()) + 1
        cnt = np.bincount(lab[use], minlength=nl)
        mean = lambda a: np.bincount(lab[use], weights=a[use].astype("f8"), minlength=nl) / np.maximum(cnt, 1)
        hv = d["HVHV"].astype("f8")
        if "VHVH" in d.files:
            hv = 0.5 * (hv + d["VHVH"].astype("f8"))  # spec: average HV and VH
        hh, hvm, vv = mean(d["HHHH"]), mean(hv), mean(d["VVVV"])
        hhvv = mean(d["HHVV"].real) + 1j * mean(d["HHVV"].imag)
        ps, pd, pv = freeman_durden(hh, hvm, vv, hhvv)
        tot = ps + pd + pv
        for i in np.nonzero((cnt >= 8) & (tot > 0))[0]:
            fid = field_id(tile, int(i))
            frac = float(pd[i] / tot[i])
            lg = lambda v: round(float(10 * np.log10(max(v, 1e-9))), 2)
            out.write(json.dumps({"field_id": fid, "pass_id": pass_id, "n_px": int(cnt[i]), "pd_frac": round(frac, 4),
                                  "ps_db": lg(ps[i]), "pd_db": lg(pd[i]), "pv_db": lg(pv[i]), "dh_pass": near}) + "\n")
            o = obs.get((fid, near))
            if o and o["inferred"]["state"] != "uncertain":
                y.append(o["inferred"]["state"] == "flooded"); s.append(frac)
                per[pass_id][o["inferred"]["state"]].append(frac)
    out.close()
    res = {"auc_pd_frac_vs_label": round(float(roc_auc_score(y, s)), 3), "n": len(y),
           "by_pass": {p: {k: {"median_pd_frac": round(float(np.median(v)), 3), "n": len(v)} for k, v in d.items()}
                       for p, d in per.items()},
           "note": "quad-pol track 135 D vs dual-pol label 3 days earlier (track 084 A); coarse, states can change within a day"}
    json.dump(res, open(os.path.join(ART, "qp_check.json"), "w"), indent=1)
    print(json.dumps(res, indent=1))


if __name__ == "__main__":
    main()
