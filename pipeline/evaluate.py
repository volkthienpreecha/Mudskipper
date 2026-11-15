"""Label-free validation of the classifier (no 2026 ground truth exists).

Per model (regime x track), on the same features classify.py uses:
  1. bic_gain       : BIC(1 component) - BIC(2 components). > 0 means two groups really exist.
  2. silhouette     : how cleanly the two groups separate (-1..1; > 0.25 is a usable split). 20k sample.
  3. seed_agreement : % of non-uncertain labels unchanged when refitting with 5 other random seeds.
  4. half_agreement : fit on a random half, predict everything; % agreement with the full fit (5 repeats).
  5. transfer       : fit on one tile only, label the OTHER tile; % agreement with that tile's own fit.
                      This is the over-fitting check: a rule that only works where it was tuned fails here.
Output: artifacts/<run>/evaluation.json (+ printed table). Agreement counts only labels that are
flooded/drained in both fits.
"""
import json, os
import numpy as np
from sklearn.metrics import silhouette_score
from sklearn.mixture import GaussianMixture
from classify import ART, load, featurize, fit_gmm, predict, state_of

RNG = np.random.default_rng(0)


def agree(p1, p2):
    a = np.array([state_of(float(x)) for x in p1])
    b = np.array([state_of(float(x)) for x in p2])
    m = (a != "uncertain") & (b != "uncertain")
    return round(100 * float((a[m] == b[m]).mean()), 1) if m.any() else None


def main():
    rows, dates = load()
    sets = featurize(rows, dates)
    res = {}
    for (regime, track), rs in sorted(sets.items()):
        if regime == "change":
            continue  # fixed rule, nothing fitted to test
        X = np.array([r["_x"] for r in rs])
        tiles = np.array([r["tile"] for r in rs])
        m = fit_gmm(X, regime)
        p = predict(m, X)
        Z = (X - m["mu"]) / m["sd"]
        g1 = GaussianMixture(1, covariance_type="full", random_state=0).fit(Z)
        bic_gain = float(g1.bic(Z) - m["g"].bic(Z))
        idx = RNG.choice(len(X), min(20000, len(X)), replace=False)
        lab = (p[idx] >= 0.5).astype(int)
        sil = float(silhouette_score(Z[idx], lab)) if len(set(lab)) == 2 else None
        seeds = [agree(p, predict(fit_gmm(X, regime, seed=s), X)) for s in (1, 2, 3, 4, 5)]
        halves = []
        for _ in range(5):
            h = RNG.choice(len(X), len(X) // 2, replace=False)
            mh = fit_gmm(X[h], regime)
            halves.append(agree(p, predict(mh, X)))
        transfer = {}
        for t in sorted(set(tiles)):
            others = [o for o in sorted(set(tiles)) if o != t]
            if not others:
                continue
            mt = fit_gmm(X[tiles == t], regime)
            for o in others:
                mo = fit_gmm(X[tiles == o], regime)
                sel = tiles == o
                transfer[f"{t}->{o}"] = agree(predict(mo, X[sel]), predict(mt, X[sel]))
        res[f"{regime}_t{track}"] = {
            "n": len(X), "bic_gain": round(bic_gain, 1), "silhouette": None if sil is None else round(sil, 3),
            "seed_agreement_min": min(seeds), "half_agreement_min": min(halves), "transfer": transfer}
    json.dump(res, open(os.path.join(ART, "evaluation.json"), "w"), indent=1)
    print(f"{'model':<12}{'n':>8}{'BIC gain':>11}{'silh.':>7}{'seeds%':>8}{'halves%':>9}  transfer%")
    for k, v in res.items():
        print(f"{k:<12}{v['n']:>8}{v['bic_gain']:>11.0f}{v['silhouette'] or 0:>7.2f}{v['seed_agreement_min']:>8}"
              f"{v['half_agreement_min']:>9}  {v['transfer']}")


if __name__ == "__main__":
    main()
