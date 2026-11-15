"""Step 2: bounded remote reads of each tile window from every used pass.

Reads only the tile window from /science/LSAR/GCOV/grids/frequencyA (no full
download) and caches it under data/<pass_id>_<tile>.npz with a sha256 sidecar.
Tiles come from artifacts/<run>/aoi.json (Karthik's geo/) when present,
otherwise the provisional TILES below.

Usage: python pipeline/fetch.py [--only p20260620] [--force]
"""
import argparse, hashlib, json, os, time
import numpy as np, h5py, earthaccess
from pyproj import Transformer
from field_units import cache_matches

RUN = os.environ.get("RUN_ID", "r01")
ART = os.path.join("artifacts", RUN)
DATA = "data"
GRID = "/science/LSAR/GCOV/grids/frequencyA"
# Provisional ~15x15 km tiles (lon/lat bbox), one per district. Replaced by aoi.json.
TILES = {
    "fazilka": (73.95, 30.33, 74.11, 30.47),
    "muktsar": (74.44, 30.40, 74.60, 30.54),
}


def load_tiles():
    p = os.path.join(ART, "aoi.json")
    if os.path.exists(p):
        return {t["id"]: tuple(t["bbox"]) for t in json.load(open(p))["tiles"]}, "aoi.json"
    return TILES, "provisional"


def window(xc, yc, bbox, epsg):
    tr = Transformer.from_crs(4326, epsg, always_xy=True)
    lo, la, hi_lo, hi_la = bbox
    xs, ys = tr.transform([lo, hi_lo, lo, hi_lo], [la, la, hi_la, hi_la])
    # y decreases down the rows; x increases along columns
    c0, c1 = np.searchsorted(xc, min(xs)), np.searchsorted(xc, max(xs))
    r0, r1 = np.searchsorted(-yc, -max(ys)), np.searchsorted(-yc, -min(ys))
    return r0, r1, c0, c1


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()


def fetch_pass(fs, p, tiles, force, prefix=""):
    out = {}
    pending = {t: b for t, b in tiles.items()
               if force or not cache_matches(os.path.join(DATA, f"{prefix}{p['pass_id']}_{t}.npz"), b, p["granule_id"])}
    if not pending:
        return {t: "cached" for t in tiles}
    with h5py.File(fs.open(p["url"], block_size=4 << 20), "r") as f:
        g = f[GRID]
        epsg = int(g["projection"][()])
        xc, yc = g["xCoordinates"][:], g["yCoordinates"][:]
        terms = [t.decode() for t in g["listOfCovarianceTerms"][:]]
        for t, bbox in pending.items():
            r0, r1, c0, c1 = window(xc, yc, bbox, epsg)
            if r1 <= r0 or c1 <= c0:
                out[t] = "outside frame"
                continue
            arrs = {k: g[k][r0:r1, c0:c1] for k in terms + ["mask"] if k in g}
            path = os.path.join(DATA, f"{prefix}{p['pass_id']}_{t}.npz")
            np.savez_compressed(path, x=xc[c0:c1], y=yc[r0:r1], epsg=epsg,
                                terms=np.array(terms), granule_id=p["granule_id"], **arrs)
            digest = sha256(path)
            json.dump({"granule_id": p["granule_id"], "tile": t, "bbox": bbox,
                       "rows": [int(r0), int(r1)], "cols": [int(c0), int(c1)],
                       "terms": terms, "subset_sha256": digest},
                      open(path + ".json", "w"), indent=1)
            out[t] = f"{r1 - r0}x{c1 - c0} px, terms {terms}"
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", help="pass_id to fetch (default: all used)")
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--passes", default="passes.json", help="file in artifacts/<run>/")
    ap.add_argument("--prefix", default="", help="cache filename prefix, e.g. qp_")
    ap.add_argument("--tile", help="trial tile override: name:minLon,minLat,maxLon,maxLat")
    a = ap.parse_args()
    os.makedirs(DATA, exist_ok=True)
    tiles, src = load_tiles()
    if a.tile:
        name, bb = a.tile.split(":")
        tiles, src = {name: tuple(float(v) for v in bb.split(","))}, "--tile"
    print(f"tiles from {src}: {list(tiles)}")
    passes = [p for p in json.load(open(os.path.join(ART, a.passes)))["passes"] if p["used"]]
    if a.only:
        passes = [p for p in passes if p["pass_id"] == a.only]
    earthaccess.login(strategy="netrc")
    fs = earthaccess.get_fsspec_https_session()
    for p in passes:
        t0 = time.time()
        for attempt in (1, 2):
            try:
                res = fetch_pass(fs, p, tiles, a.force, a.prefix)
                break
            except Exception as e:  # network hiccup: retry once, then report
                if attempt == 2:
                    res = {"error": repr(e)}
        print(p["pass_id"], f"{time.time() - t0:.0f}s", res)


if __name__ == "__main__":
    main()
