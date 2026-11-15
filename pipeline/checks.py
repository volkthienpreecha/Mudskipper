"""Season-shape and consistency checks on observations.jsonl (reports only, never changes labels).

Expected Punjab kharif paddy shape: flooding rises after transplanting (late Jun–Jul), stays high
through the canopy season, then fields are drained before the late-Sep–Oct harvest.
Checks (PASS / WARN):
  1. schema      : p_flooded in [0,1]; state follows the B3.4 rule; one row per field per pass
  2. harvest     : flooded share on the last pass is below the season peak (drain before harvest)
  3. early_low   : first-pass flooded share is below the peak (season starts drier)
  4. flip_rate   : share of fields that switch flooded<->drained on more than half their pass pairs
                   (paddies do not flip every 12 days; > 10% suggests noise)
  5. never_drained_late: share of rice-like fields still flooded on every Oct pass (no harvest drain; > 25% warns)
Output: artifacts/<run>/checks.json
"""
import collections, json, os
from classify import ART, state_of


def main():
    rows = [json.loads(l) for l in open(os.path.join(ART, "observations.jsonl"))]
    res = {}
    bad = sum(1 for r in rows if r["inferred"]["p_flooded"] is not None and (
        not 0 <= r["inferred"]["p_flooded"] <= 1 or
        state_of(r["inferred"]["p_flooded"], r["valid_frac"]) != r["inferred"]["state"]))
    dup = len(rows) - len({(r["field_id"], r["pass_id"]) for r in rows})
    res["schema"] = {"status": "PASS" if bad == 0 and dup == 0 else "WARN", "rule_violations": bad, "duplicates": dup}
    per = collections.defaultdict(collections.Counter)
    for r in rows:
        per[r["pass_id"]][r["inferred"]["state"]] += 1
    share = {p: round(100 * c["flooded"] / sum(c.values()), 1) for p, c in sorted(per.items())}
    passes = list(share); peak = max(share.values())
    res["season_flooded_pct"] = share
    res["harvest"] = {"status": "PASS" if share[passes[-1]] < peak else "WARN", "last": share[passes[-1]], "peak": peak}
    res["early_low"] = {"status": "PASS" if share[passes[0]] < peak else "WARN", "first": share[passes[0]], "peak": peak}
    byf = collections.defaultdict(list)
    for r in sorted(rows, key=lambda r: r["pass_id"]):
        byf[(r["field_id"], r["track"])].append(r)
    flips = 0; nf = 0; stuck = 0; nrice = 0
    for fr in byf.values():
        s = [r["inferred"]["state"] for r in fr if r["inferred"]["state"] != "uncertain"]
        if len(s) >= 4:
            nf += 1
            ch = sum(a != b for a, b in zip(s, s[1:]))
            flips += ch > (len(s) - 1) / 2
        octs = [r for r in fr if r["pass_id"] >= "p20261001"]
        if octs and not any(f in ("not_rice_like", "not_rice_2024") for r in fr for f in r["flags"]):
            nrice += 1
            stuck += all(r["inferred"]["state"] == "flooded" for r in octs)
    fr_pct = round(100 * flips / max(nf, 1), 1); st_pct = round(100 * stuck / max(nrice, 1), 1)
    res["flip_rate"] = {"status": "PASS" if fr_pct <= 10 else "WARN", "pct_fields": fr_pct, "n_fields": nf}
    res["never_drained_late"] = {"status": "PASS" if st_pct <= 25 else "WARN", "pct_fields": st_pct, "n_fields": nrice}
    json.dump(res, open(os.path.join(ART, "checks.json"), "w"), indent=1)
    for k, v in res.items():
        print(k, v)


if __name__ == "__main__":
    main()
