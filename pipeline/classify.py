"""Step 5 (dual-pol): 2-component GMM per regime and track -> flooded/drained/uncertain (hhhv_v1).

v4: field-scale units, per-field temporal features, one model per track.

Regime "open" (passes before Aug 1, canopy sparse): features = absolute hh_db, hv_db.
    flooded = component with LOWER HH (specular open water is dark).
Regime "canopy" (passes after the data gap): L-band reaches the water under the
    plants; flooded fields return strong water-stem double bounce.
    Features = each field's drop below its own canopy-season level (per track):
        a[f,t]  = hh_db[f,t] - scene_q75[t]       (removes canopy growth + calibration drift)
        d_hh    = a[f,t] - q75_t(a[f,.])          (0 = at the field's own bright level)
        d_ratio = same for hh_hv_db
    flooded = component with HIGHER d_hh; drained = dropped below own level.
    Fields that never get within NOT_RICE_DB of the scene's bright level in the
    canopy season behave like a non-rice crop -> "uncertain" + flag not_rice_like
    (stop-gap until geo/ supplies the rice mask).
Each track gets its own models (different incidence angle), per the A6 rule.
B3.4 rule: uncertain if valid_frac < 0.6 or 0.35 < p_flooded < 0.65.
B3.4 "stage" keeps the spec dates (early < Jul 15 <= mid < Sep 10 <= late).
Output: artifacts/<run>/observations.jsonl, hist/<regime>_t<track>.png, classify_summary.json
"""
import json, os, collections
import numpy as np
from sklearn.mixture import GaussianMixture
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

RUN = os.environ.get("RUN_ID", "r01")
ART = os.path.join("artifacts", RUN)
RAW = ("hh_db", "hv_db", "hh_hv_db")
CANOPY_FROM = "2026-08-01"
NOT_RICE_DB = -3.0
MIN_PX = 20
MIN_CANOPY_LOOKS = 4  # a field's own canopy level (q75) needs >= 4 looks; 3 gave labels contradicting fire data (track 135)
SEED = 0
# v5 change rule for later open-season passes (standard SAR flood change detection):
# flooded if HH dropped >= 3 dB below the field's own first pass on that track, drained if < 2 dB, else uncertain.
# Self-referenced, so the 3 dB district offset that broke absolute cutoffs cancels out. Not fit to optical.
DROP_FLOOD, DROP_MID = 3.0, 2.5
DROP_K = 1.24  # logistic slope: drop 3.0 -> p 0.65, 2.0 -> p 0.35
S1_DAYS = 2  # Sentinel-1 scenes within this many days of an open-season NISAR pass are fused


def s1_probs(dates):
    """{(field_id, pass_id): p_flooded from Sentinel-1} using the same untuned 3 dB change rule on C-band VV,
    each orbit vs its own earliest scene. Averaged over the scenes within S1_DAYS of the NISAR pass."""
    path = os.path.join(ART, "s1_fields.jsonl")
    if not os.path.exists(path):
        return {}
    import datetime as dt
    orb = collections.defaultdict(lambda: collections.defaultdict(dict))
    for l in open(path):
        r = json.loads(l)
        orb[r["orbit"]][r["date"]][r["field_id"]] = r["vv_db"]
    acc = collections.defaultdict(list)
    for pid, d in dates.items():
        if d >= CANOPY_FROM:
            continue
        D = dt.date.fromisoformat(d)
        for byd in orb.values():
            b0 = min(byd)
            for d1, vals in byd.items():
                if d1 == b0 or abs((dt.date.fromisoformat(d1) - D).days) > S1_DAYS:
                    continue
                for f, vv in vals.items():
                    if f in byd[b0]:
                        acc[(f, pid)].append(1 / (1 + np.exp(-DROP_K * ((byd[b0][f] - vv) - DROP_MID))))
    return {k: float(np.mean(v)) for k, v in acc.items()}


RULE = {"open": (0, True), "canopy": (0, False)}  # (feature column, flooded = low?)
FEATS = {"change": ["hh drop vs Jul 2 (dB)"], "open": ["hh_db", "hv_db"], "canopy": ["d_hh (dB vs own level)", "d_hh_hv (dB vs own level)"]}


def load():
    dates = {p["pass_id"]: p["datetime"][:10]
             for p in json.load(open(os.path.join(ART, "passes.json")))["passes"] if p["used"]}
    rows = [json.loads(l) for l in open(os.path.join(ART, "zonal.jsonl"))]
    return [r for r in rows if r["pass_id"] in dates], dates


def featurize(rows, dates):
    """Adds flags/_x to rows; returns {(regime, track): [rows with features]}."""
    for r in rows:
        r["flags"] = ["provisional_segment_fields"]
        r["_ok"] = r["n_px"] >= MIN_PX and all(r["observed"][f] is not None for f in RAW)
        r["_reg"] = "canopy" if dates[r["pass_id"]] >= CANOPY_FROM else "open"
        r["inferred"] = {"state": "uncertain", "p_flooded": None, "confidence": 0.0, "method": "hhhv_v1"}
        if not r["_ok"]:
            r["flags"].append("too_few_valid_px")
    sets = collections.defaultdict(list)
    # baseline = each track's first open-season pass (track 84: Jul 2; track 135: Jun 23)
    first = {}
    for r in rows:
        if r["_reg"] == "open":
            t = r["track"]; first[t] = min(first.get(t, r["pass_id"]), r["pass_id"], key=lambda k: dates[k])
    base = {(r["field_id"], r["track"]): r["observed"]["hh_db"] for r in rows
            if r["_ok"] and r["pass_id"] == first[r["track"]]}
    for r in rows:
        if (r["_ok"] and r["_reg"] == "open" and r["pass_id"] != first[r["track"]]
                and (r["field_id"], r["track"]) in base):
            r["_drop"] = [base[(r["field_id"], r["track"])] - r["observed"]["hh_db"]]  # drop in dB
            sets[("change", r["track"])].append(r)
        if r["_ok"] and r["_reg"] == "open":  # open GMM still fit on all July passes; labels only Jul 2
            r["_x"] = [r["observed"]["hh_db"], r["observed"]["hv_db"]]
            sets[("open", r["track"])].append(r)
    can = [r for r in rows if r["_ok"] and r["_reg"] == "canopy"]
    grp = collections.defaultdict(list)
    for r in can:
        grp[(r["pass_id"], r["tile"])].append(r)
    # v7: the scene reference follows growth up to the season peak (max scene q75 HH), then is
    # held at the peak value, so a scene-wide post-peak fall (pre-harvest drain) is no longer divided out.
    qs = {k: {f: float(np.percentile([r["observed"][f] for r in g], 75)) for f in ("hh_db", "hh_hv_db")}
          for k, g in grp.items()}
    med = {k: q["hh_db"] for k, q in qs.items()}  # peak by HH (provisional HV shows ~5 dB pass-to-pass jumps in Bathinda)
    for tile in {k[1] for k in grp}:
        for track in {g[0]["track"] for k, g in grp.items() if k[1] == tile}:
            ks = sorted((k for k, g in grp.items() if k[1] == tile and g[0]["track"] == track), key=lambda k: dates[k[0]])
            peak = max(range(len(ks)), key=lambda i: med[ks[i]])
            for i, k in enumerate(ks):
                ref = qs[ks[peak]] if i > peak else qs[k]
                for r in grp[k]:
                    for f in ("hh_db", "hh_hv_db"):
                        r["_a_" + f] = r["observed"][f] - ref[f]
    byf = collections.defaultdict(list)
    for r in can:
        byf[r["field_id"]].append(r)
    for fr in byf.values():
        if max(r["_a_hh_db"] for r in fr) < NOT_RICE_DB:
            for r in fr:
                r["flags"].append("not_rice_like")
            continue
        bytrack = collections.defaultdict(list)
        for r in fr:
            bytrack[r["track"]].append(r)
        for track, tr in bytrack.items():
            if len(tr) < MIN_CANOPY_LOOKS:
                for r in tr:
                    r["flags"].append("too_few_canopy_looks")
                continue
            base = {f: float(np.percentile([r["_a_" + f] for r in tr], 75)) for f in ("hh_db", "hh_hv_db")}
            for r in tr:
                r["_x"] = [r["_a_hh_db"] - base["hh_db"], r["_a_hh_hv_db"] - base["hh_hv_db"]]
                sets[("canopy", track)].append(r)
    return sets


def fit_gmm(X, regime, seed=SEED):
    if regime == "change":  # fixed physical rule, nothing fitted
        return {"g": None, "mu": 0, "sd": 1, "wet": 0, "flooded_mean": np.array([DROP_FLOOD]), "drained_mean": np.array([0.0])}
    mu, sd = X.mean(0), X.std(0)
    g = GaussianMixture(2, covariance_type="full", random_state=seed, n_init=5).fit((X - mu) / sd)
    col, low = RULE[regime]
    means = g.means_ * sd + mu
    wet = int(np.argmin(means[:, col]) if low else np.argmax(means[:, col]))
    return {"g": g, "mu": mu, "sd": sd, "wet": wet, "flooded_mean": means[wet], "drained_mean": means[1 - wet]}


def predict(m, X):
    if m["g"] is None:
        return 1 / (1 + np.exp(-DROP_K * (np.asarray(X)[:, 0] - DROP_MID)))
    return m["g"].predict_proba((X - m["mu"]) / m["sd"])[:, m["wet"]]


def state_of(pf, valid_frac=1.0):
    if valid_frac < 0.6 or 0.35 < pf < 0.65:
        return "uncertain"
    return "flooded" if pf >= 0.65 else "drained"


def main():
    rows, dates = load()
    sets = featurize(rows, dates)
    s1p = s1_probs(dates)
    os.makedirs(os.path.join(ART, "hist"), exist_ok=True)
    summary = {"models": {}}
    for (regime, track), rs in sorted(sets.items()):
        X = np.array([r["_drop"] if regime == "change" else r["_x"] for r in rs])
        m = fit_gmm(X, regime)
        for r, pf in zip(rs, predict(m, X)):
            if regime == "open" and "_drop" in r:
                continue  # labelled by the change rule
            if regime in ("open", "change") and (r["field_id"], r["pass_id"]) in s1p:
                pf = (float(pf) + s1p[(r["field_id"], r["pass_id"])]) / 2  # equal-weight two-radar fusion
                r["flags"].append("fused_sentinel1")
            elif regime == "open" and s1p:
                # a track's first pass with no Sentinel-1 scene nearby: the July mixture alone is not
                # trustworthy (kappa ~0 vs optical), so report it as uncertain instead of guessing
                r["flags"].append("no_change_baseline")
                r["inferred"].update(state="uncertain", p_flooded=None, confidence=None)
                continue
            pf = round(float(pf), 4)  # apply the B3.4 rule to the value that is written out
            if regime == "change":
                r["flags"].append("hh_change_vs_jul2")  # method name stays hhhv_v1 per B3.4
            r["inferred"].update(state=state_of(pf, r["valid_frac"]), p_flooded=round(pf, 4),
                                 confidence=round(abs(pf - 0.5) * 2, 4))
            if r["valid_frac"] < 0.6:
                r["flags"].append("low_valid_frac")
        lab = np.array([r["inferred"]["state"] for r in rs])
        summary["models"][f"{regime}_t{track}"] = {
            "n": len(rs), "features": FEATS[regime], "flooded_mean": np.round(m["flooded_mean"], 2).tolist(),
            "drained_mean": np.round(m["drained_mean"], 2).tolist(),
            "pct": {s: round(100 * float((lab == s).mean()), 1) for s in ("flooded", "drained", "uncertain")}}
        nf = X.shape[1]
        fig, axs = plt.subplots(1, nf, figsize=(4.5 * nf, 3.2), squeeze=False)
        axs = axs[0]
        for ax, i in zip(axs, range(nf)):
            lo, hi = np.percentile(X[:, i], [0.5, 99.5])
            for s, col in (("flooded", "#3FA7D6"), ("drained", "#C98B4E"), ("uncertain", "#8A8F98")):
                ax.hist(X[lab == s, i], bins=70, range=(lo, hi), alpha=0.6, color=col, label=s)
            ax.set_title(f"{regime}, track {track}: {FEATS[regime][i]}", fontsize=9)
        axs[0].legend(); fig.tight_layout()
        fig.savefig(os.path.join(ART, "hist", f"{regime}_t{track}.png"), dpi=90); plt.close(fig)
    per_pass = collections.defaultdict(collections.Counter)
    for r in rows:
        per_pass[r["pass_id"]][r["inferred"]["state"]] += 1
    summary["per_pass_pct"] = {pid: {s: round(100 * c[s] / sum(c.values()), 1) for s in ("flooded", "drained", "uncertain")}
                               for pid, c in sorted(per_pass.items())}
    flags = collections.Counter(f for r in rows for f in r["flags"])
    summary["flags"] = dict(flags)
    tot = collections.Counter(r["inferred"]["state"] for r in rows)
    summary["overall_pct"] = {s: round(100 * tot[s] / len(rows), 1) for s in tot}
    with open(os.path.join(ART, "observations.jsonl"), "w") as f:
        for r in rows:
            f.write(json.dumps({"v": 1, "run_id": RUN, **{k: v for k, v in r.items() if not k.startswith("_")}}) + "\n")
    json.dump(summary, open(os.path.join(ART, "classify_summary.json"), "w"), indent=1)
    for k, v in summary["per_pass_pct"].items():
        print(k, v)
    print("overall", summary["overall_pct"], "flags", summary["flags"])
    print(f"{len(rows)} observations -> {ART}/observations.jsonl")


if __name__ == "__main__":
    main()
