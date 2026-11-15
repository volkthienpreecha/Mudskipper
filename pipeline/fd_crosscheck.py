"""Cross-check pipeline/freeman_durden.py against polsartools (independent open-source PolSAR library).

polsartools' package import needs GDAL, so only its pure-numpy kernel process_chunk_free3c is loaded
(source extracted from polsartools/polsar/fp/freeman_3c.py, run as-is with window 1).
Input: real NISAR quad-pol pixels from the cached qp_ tiles. polsartools uses the lexicographic C3 with
C22 = 2|HV|^2 and C13 = <HH VV*>. Compares Ps, Pd, Pv in dB on pixels where both give > 0.
Output: artifacts/<run>/fd_crosscheck.json; max_abs_diff_db goes to provenance decomposition_check.
"""
import ast, glob, json, os, importlib.util
import numpy as np
from freeman_durden import freeman_durden

RUN = os.environ.get("RUN_ID", "r01")
ART = os.path.join("artifacts", RUN)


def polsartools_kernel():
    spec = importlib.util.find_spec("polsartools")
    src_path = os.path.join(os.path.dirname(spec.origin), "polsar", "fp", "freeman_3c.py")
    tree = ast.parse(open(src_path).read())
    fn = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == "process_chunk_free3c")
    ns = {"np": np}
    exec(compile(ast.Module([fn], []), src_path, "exec"), ns)
    from importlib.metadata import version
    return ns["process_chunk_free3c"], version("polsartools")


def main():
    kern, ver = polsartools_kernel()
    diffs = {"Ps": [], "Pd": [], "Pv": []}; n = 0; files = sorted(glob.glob("data/qp_*.npz"))
    for f in files:
        z = np.load(f)
        if "HHVV" not in z.files:
            continue
        ok = (z["mask"] >= 1) & (z["mask"] <= 254)
        hh, hv, vv, c = (z[k][ok].astype("f8") for k in ("HHHH", "HVHV", "VVVV")) + (z["HHVV"][ok],) if False else \
            (z["HHHH"][ok].astype("f8"), z["HVHV"][ok].astype("f8"), z["VVVV"][ok].astype("f8"), z["HHVV"][ok].astype("c16"))
        sel = np.isfinite(hh) & np.isfinite(hv) & np.isfinite(vv) & np.isfinite(c) & (hh > 0) & (hv > 0) & (vv > 0)
        hh, hv, vv, c = hh[sel][::20], hv[sel][::20], vv[sel][::20], c[sel][::20]
        zero = np.zeros_like(hh)
        chunks = [hh[None], zero[None], zero[None], c.real[None], c.imag[None], 2 * hv[None], zero[None], zero[None], vv[None]]
        names = ["C11", "C12_real", "C12_imag", "C13_real", "C13_imag", "C22", "C23_real", "C23_imag", "C33"]
        odd, dbl, vol = (a[0].astype("f8") for a in kern(chunks, 1, names))
        ps, pd, pv = freeman_durden(hh, hv, vv, c)
        for k, a, b in (("Ps", ps, odd), ("Pd", pd, dbl), ("Pv", pv, vol)):
            m = (a > 1e-6 * (hh + vv)) & (b > 1e-6 * (hh + vv)) & np.isfinite(b)
            diffs[k].append(np.abs(10 * np.log10(a[m]) - 10 * np.log10(b[m])))
        n += len(hh)
    res = {"reference": f"polsartools {ver}, polsar/fp/freeman_3c.py process_chunk_free3c (window 1)",
           "n_pixels": int(n), "files": [os.path.basename(f) for f in files]}
    for k, v in diffs.items():
        v = np.concatenate(v)
        res[k] = {"median_abs_diff_db": round(float(np.median(v)), 6), "p99_abs_diff_db": round(float(np.percentile(v, 99)), 6),
                  "max_abs_diff_db": round(float(v.max()), 6), "pct_within_0p1db": round(100 * float((v <= 0.1).mean()), 2)}
    res["max_abs_diff_db"] = max(res[k]["max_abs_diff_db"] for k in diffs)
    json.dump(res, open(os.path.join(ART, "fd_crosscheck.json"), "w"), indent=1)
    print(json.dumps(res, indent=1))


if __name__ == "__main__":
    main()
