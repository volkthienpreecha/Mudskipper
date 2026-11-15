"""Calibrate the open-water (July) classifier on Sentinel-2 optical flooding labels.

Why: the unsupervised July GMM over-called flooding (~72% vs 8–34% optically), because dark
L-band HH also comes from smooth bare/wet soil and sparse young crops.
Labels: optical_fields.jsonl (Xiao et al. 2005 rule, from optical_check.py). Per field and
date the wet share is averaged over Sentinel-2 granules; >= 0.5 -> flooded, <= 0.2 -> not
flooded, in between -> dropped (ambiguous). Features: NISAR hh_db, hv_db, hh_hv_db from the
radar pass <= 2 days from the optical image.
Model: logistic regression (3 features, 4 numbers) so it cannot memorise fields.
Honest tests (labels never seen in training):
  - tile transfer: train on fazilka, test on muktsar, and the reverse
  - date transfer: train on Jul 14, test on Jul 2 (optical Jun 30)
  - baseline: the old unsupervised GMM labels on the same test fields
Metrics follow B3.4: p >= 0.65 flooded, p <= 0.35 not flooded, in between uncertain
(coverage = share of test fields that get a label).
Output: artifacts/<run>/open_calibration.json (model + test report), used by classify.py.
"""
import collections, json, os
import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import cohen_kappa_score, precision_recall_fscore_support

RUN = os.environ.get("RUN_ID", "r01")
ART = os.path.join("artifacts", RUN)
FEATS = ("hh_db", "hv_db", "hh_hv_db")
TRAIN_PASS = "p20260714"


def dataset():
    shares = collections.defaultdict(list)
    for l in open(os.path.join(ART, "optical_fields.jsonl")):
        r = json.loads(l)
        shares[(r["field_id"], r["nisar_pass"])].append(r["wet_share"])
    zon, gmm = {}, {}
    for l in open(os.path.join(ART, "zonal.jsonl")):
        r = json.loads(l)
        if r["n_px"] >= 20 and all(r["observed"][f] is not None for f in FEATS):
            zon[(r["field_id"], r["pass_id"])] = [r["observed"][f] for f in FEATS]
    for l in open(os.path.join(ART, "observations.jsonl")):
        r = json.loads(l)
        gmm[(r["field_id"], r["pass_id"])] = r["inferred"]["state"]
    rows = []
    for key, v in shares.items():
        s = float(np.mean(v))
        if 0.2 < s < 0.5 or key not in zon:
            continue
        rows.append({"field_id": key[0], "tile": key[0].rsplit("_s", 1)[0], "pass": key[1],
                     "x": zon[key], "y": int(s >= 0.5), "gmm": gmm.get(key)})
    return rows


def fit(rows):
    X = np.array([r["x"] for r in rows]); y = np.array([r["y"] for r in rows])
    mu, sd = X.mean(0), X.std(0)
    m = LogisticRegression(C=1.0, max_iter=1000).fit((X - mu) / sd, y)
    return {"mu": mu.tolist(), "sd": sd.tolist(), "coef": m.coef_[0].tolist(), "intercept": float(m.intercept_[0])}


def prob(model, X):
    z = (np.asarray(X) - model["mu"]) / model["sd"]
    return 1 / (1 + np.exp(-(z @ np.array(model["coef"]) + model["intercept"])))


def score(y, pred):
    """pred: 1 flooded, 0 not flooded, -1 uncertain."""
    y, pred = np.asarray(y), np.asarray(pred)
    m = pred >= 0
    if m.sum() == 0 or len(set(y[m])) < 2:
        return {"n": int(len(y)), "coverage_pct": round(100 * m.mean(), 1)}
    pr, rc, f1, _ = precision_recall_fscore_support(y[m], pred[m], average="binary", zero_division=0)
    return {"n": int(len(y)), "coverage_pct": round(100 * m.mean(), 1), "optical_flooded_pct": round(100 * y.mean(), 1),
            "predicted_flooded_pct": round(100 * (pred[m] == 1).mean(), 1),
            "agreement_pct": round(100 * (y[m] == pred[m]).mean(), 1), "kappa": round(float(cohen_kappa_score(y[m], pred[m])), 3),
            "precision": round(float(pr), 3), "recall": round(float(rc), 3), "f1": round(float(f1), 3)}


def to_pred(p):
    return np.where(p >= 0.65, 1, np.where(p <= 0.35, 0, -1))


def gmm_pred(rows):
    return np.array([{"flooded": 1, "drained": 0}.get(r["gmm"], -1) for r in rows])


def main():
    rows = dataset()
    report = {"labels": dict(collections.Counter(f"{r['tile']}/{r['pass']}/{'wet' if r['y'] else 'dry'}" for r in rows)),
              "tests": {}}
    jul = [r for r in rows if r["pass"] == TRAIN_PASS]
    for a, b in (("fazilka", "muktsar"), ("muktsar", "fazilka")):
        tr = [r for r in jul if r["tile"] == a]; te = [r for r in jul if r["tile"] == b]
        m = fit(tr)
        y = [r["y"] for r in te]
        report["tests"][f"train {a} -> test {b} (Jul 14)"] = {
            "calibrated": score(y, to_pred(prob(m, [r["x"] for r in te]))), "old_unsupervised": score(y, gmm_pred(te))}
    other = [r for r in rows if r["pass"] != TRAIN_PASS]
    if other:
        m = fit(jul)
        y = [r["y"] for r in other]
        report["tests"][f"train Jul 14 (both tiles) -> test {sorted({r['pass'] for r in other})}"] = {
            "calibrated": score(y, to_pred(prob(m, [r["x"] for r in other]))), "old_unsupervised": score(y, gmm_pred(other))}
    final = fit(jul)
    final.update({"features": list(FEATS), "trained_on": f"{TRAIN_PASS}, fazilka+muktsar, n={len(jul)}",
                  "label_source": "Sentinel-2 L2A, Xiao et al. 2005 LSWI+0.05>=NDVI, wet share >=0.5 / <=0.2"})
    report["model"] = final
    json.dump(report, open(os.path.join(ART, "open_calibration.json"), "w"), indent=1)
    print("labels:", report["labels"])
    for k, v in report["tests"].items():
        print("\n" + k)
        for name, s in v.items():
            print(f"  {name:<17} {s}")
    print("\nfinal model coef (standardised hh, hv, hh/hv):", np.round(final["coef"], 2), "intercept", round(final["intercept"], 2))


if __name__ == "__main__":
    main()
