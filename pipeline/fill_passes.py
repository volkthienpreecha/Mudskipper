"""Fill the passes.json fields only known after fetch (B3.2): covariance_terms, pixel_m, valid_fraction_by_tile.

Read from the cached tile subsets data/<prefix><pass_id>_<tile>.npz written by fetch.py.
valid fraction = share of pixels with mask in 1..254 (valid subswath; 0 invalid, 255 fill).
Run after fetch.py:  python pipeline/fill_passes.py [passes.json path] [prefix]
"""
import glob, json, os, sys
import numpy as np

RUN = os.environ.get("RUN_ID", "r01")
TILES = os.environ.get("TILES", "fazilka,muktsar").split(",")  # tiles that belong to this run


def main():
    path = sys.argv[1] if len(sys.argv) > 1 else os.path.join("artifacts", RUN, "passes.json")
    prefix = sys.argv[2] if len(sys.argv) > 2 else ""
    d = json.load(open(path))
    for p in d["passes"]:
        for f in sorted(glob.glob(f"data/{prefix}{p['pass_id']}_*.npz")):
            tile = os.path.basename(f)[len(prefix) + len(p["pass_id"]) + 1:-4]
            if tile not in TILES:
                continue
            z = np.load(f)
            if str(z["granule_id"]) != p["granule_id"]:
                continue  # cache from a superseded granule
            m = z["mask"]
            p["covariance_terms"] = [str(t) for t in z["terms"]]
            p["pixel_m"] = round(float(abs(z["x"][1] - z["x"][0])), 3)
            p["valid_fraction_by_tile"][tile] = round(float(((m >= 1) & (m <= 254)).mean()), 4)
    json.dump(d, open(path, "w"), indent=1)
    for p in d["passes"]:
        print(p["pass_id"], p["used"], p["pixel_m"], p["covariance_terms"], p["valid_fraction_by_tile"])


if __name__ == "__main__":
    main()
