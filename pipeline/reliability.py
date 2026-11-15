"""Are confident calls more often right? Agreement with Sentinel-2 optical labels by confidence band.

Optical label per field (Xiao rule, wet share >= 0.5 wet / <= 0.2 dry, ambiguous dropped) vs our label on the
NISAR pass <= 2 days away, pre-canopy passes only (optical cannot see water under the canopy).
Confidence = |2 p_flooded - 1| (B3.4). Bands chosen before looking: 0.3-0.6, 0.6-0.9, 0.9-1.0.
Reports per band: n, agreement %, Cohen's kappa. Output: artifacts/<run>/reliability.json
"""
import collections, json, os
import numpy as np
from sklearn.metrics import cohen_kappa_score

RUN = os.environ.get("RUN_ID", "r01")
ART = os.path.join("artifacts", RUN)
BANDS = [(0.3, 0.6), (0.6, 0.9), (0.9, 1.01)]


def main():
    opt = collections.defaultdict(list)
    for l in open(os.path.join(ART, "optical_fields.jsonl")):
        r = json.loads(l); opt[(r["field_id"], r["nisar_pass"])].append(r["wet_share"])
    rows = []
    for l in open(os.path.join(ART, "observations.jsonl")):
        r = json.loads(l); k = (r["field_id"], r["pass_id"])
        if k in opt and r["inferred"]["state"] in ("flooded", "drained"):
            m = float(np.mean(opt[k]))
            if 0.2 < m < 0.5:
                continue
            rows.append((r["field_id"].rsplit("_s", 1)[0], r["pass_id"], r["inferred"]["confidence"], m >= 0.5,
                         r["inferred"]["state"] == "flooded"))
    res = {}
    for scope in ("all", "fazilka", "muktsar"):
        sel = [x for x in rows if scope == "all" or x[0] == scope]
        out = {}
        for lo, hi in BANDS:
            b = [x for x in sel if lo <= x[2] < hi]
            if len(b) < 50:
                continue
            y = [x[3] for x in b]; p = [x[4] for x in b]
            out[f"{lo:.1f}-{min(hi, 1):.1f}"] = {"n": len(b), "agreement_pct": round(100 * np.mean(np.equal(y, p)), 1),
                                                 "kappa": round(float(cohen_kappa_score(y, p)), 3) if len(set(y)) == 2 and len(set(p)) == 2 else None}
        res[scope] = out
    json.dump(res, open(os.path.join(ART, "reliability.json"), "w"), indent=1)
    print(json.dumps(res, indent=1))


if __name__ == "__main__":
    main()
