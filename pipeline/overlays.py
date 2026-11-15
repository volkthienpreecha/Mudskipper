"""Step 6a: map overlays (B3.10) + quicklook sheets for eyeballing results.

overlays/<pass_id>_<tile>.png : RGBA at 20 m, coloured by each field's inferred state
    Water #3FA7D6 = flooded, Mud #C98B4E = drained, Haze #8A8F98 = uncertain, clear = not a field
overlays/index.json           : [{pass_id, tile, url, coordinates}] (lon/lat corners TL,TR,BR,BL)
quicklook_<tile>.png          : whole tile, radar HH (top) vs inferred state (bottom), per pass
zoom_<tile>.png               : same for a 3x3 km window so individual fields are visible
"""
import json, os
import numpy as np
from pyproj import Transformer
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import Patch
from field_units import FieldUnits, grid_transform

RUN = os.environ.get("RUN_ID", "r01")
ART = os.path.join("artifacts", RUN)
COL = {"flooded": (0x3F, 0xA7, 0xD6), "drained": (0xC9, 0x8B, 0x4E), "uncertain": (0x8A, 0x8F, 0x98)}
CODE = {"drained": 1, "flooded": 2, "uncertain": 3}
LUT = np.array([(0, 0, 0, 0), (*COL["drained"], 255), (*COL["flooded"], 255), (*COL["uncertain"], 255)], dtype=np.uint8)
ZOOM = np.s_[500:650, 100:250]  # 3x3 km at 20 m


def sheet(tile, pids, dates, states, hhs, win, path, title):
    fig, axs = plt.subplots(2, len(pids), figsize=(2.3 * len(pids), 5.3), squeeze=False)
    for k, pid in enumerate(pids):
        st = states[pid][win]
        with np.errstate(divide="ignore", invalid="ignore"):
            axs[0, k].imshow(10 * np.log10(hhs[pid][win]), cmap="gray", vmin=-22, vmax=2)
        axs[0, k].set_title(dates[pid][5:], fontsize=10)
        bg = np.full((*st.shape, 4), 255, dtype=np.uint8); bg[..., :3] = 20
        img = np.where(st[..., None] > 0, LUT[st], bg)
        axs[1, k].imshow(img, interpolation="nearest")
        f = st[st > 0]
        axs[1, k].set_xlabel("%d%% flooded\n%d%% drained" % (round(100 * (f == 2).mean()), round(100 * (f == 1).mean())), fontsize=9)
        for a in axs[:, k]:
            a.set_xticks([]); a.set_yticks([])
    axs[0, 0].set_ylabel("radar HH (dB)")
    axs[1, 0].set_ylabel("inferred state")
    fig.legend(handles=[Patch(color=np.array(COL[s]) / 255, label=s) for s in COL] + [Patch(color="#141414", label="not a field")],
               loc="lower center", ncol=4, frameon=False)
    fig.suptitle(title, fontsize=11)
    fig.tight_layout(rect=(0, 0.05, 1, 0.97))
    fig.savefig(path, dpi=110); plt.close(fig)


def geo_overlays(fields, rows):
    """Rasterise the same geo identities used for statistics on each pass grid."""
    grouped = {}
    for r in rows:
        if r.get("field_geometry_sha256") != fields.fingerprints.get(r["field_id"], "missing"):
            raise ValueError(f"overlay field {r['field_id']} does not match geo handoff; rerun zonal/classify")
        grouped.setdefault((r["pass_id"], r["tile"]), {})[r["field_id"]] = CODE[r["inferred"]["state"]]
    os.makedirs(os.path.join(ART, "overlays"), exist_ok=True)
    index = []
    for (pid, tile), codes in sorted(grouped.items()):
        with np.load(f"data/{pid}_{tile}.npz") as d:
            lab, _, _, meta = fields.raster(tile, d["x"], d["y"], d["epsg"])
            lut = np.array([0] + [codes.get(p["field_id"], 0) for p in meta], dtype=np.uint8)
            st = lut[lab]
            rgba = LUT[st].copy()
            rgba[..., 3] = np.where(st > 0, 200, 0)
            url = f"overlays/{pid}_{tile}.png"
            plt.imsave(os.path.join(ART, url), rgba)
            tf = grid_transform(d["x"], d["y"], d["epsg"])
            height, width = lab.shape
            tr = Transformer.from_crs(int(d["epsg"]), 4326, always_xy=True)
            coords = [list(tr.transform(*(tf @ p))) for p in ((0, 0), (width, 0), (width, height), (0, height))]
            index.append({"pass_id": pid, "tile": tile, "url": url, "coordinates": coords,
                          "field_source": "geo", "field_ids": sorted(codes),
                          "field_geometry_sha256": {f: fields.fingerprints[f] for f in sorted(codes)},
                          "grid": {"epsg": int(d["epsg"]), "transform": list(tf)[:6],
                                   "width": width, "height": height}})
    json.dump(index, open(os.path.join(ART, "overlays", "index.json"), "w"), indent=1, allow_nan=False)
    print(f"{len(index)} geo field overlays -> {ART}")


def main():
    fields = FieldUnits(ART)
    if fields.geo:
        rows = [json.loads(l) for l in open(os.path.join(ART, "observations.jsonl"))]
        geo_overlays(fields, rows)
        return
    dates = {p["pass_id"]: p["datetime"][:10]
             for p in json.load(open(os.path.join(ART, "passes.json")))["passes"] if p["used"]}
    codes = {}
    for l in open(os.path.join(ART, "observations.jsonl")):
        r = json.loads(l)
        codes.setdefault((r["pass_id"], r["tile"]), {})[int(r["field_id"].rsplit("_s", 1)[1])] = CODE[r["inferred"]["state"]]
    os.makedirs(os.path.join(ART, "overlays"), exist_ok=True)
    index = []
    tiles = sorted({t for _, t in codes})
    for tile in tiles:
        seg = np.load(f"data/segments_{tile}.npz")
        lab, k = seg["labels"], int(seg["ml"])
        pids = sorted(p for p, t in codes if t == tile)
        states, hhs = {}, {}
        for pid in pids:
            lut = np.zeros(int(lab.max()) + 1, dtype=np.uint8)
            for i, c in codes[(pid, tile)].items():
                lut[i] = c
            st = lut[lab]
            states[pid] = st
            url = f"overlays/{pid}_{tile}.png"
            rgba = LUT[st].copy(); rgba[..., 3] = np.where(st > 0, 200, 0)
            plt.imsave(os.path.join(ART, url), rgba)
            d = np.load(f"data/{pid}_{tile}.npz")
            H, W = lab.shape
            hhs[pid] = d["HHHH"][:H * k, :W * k].astype("f8").reshape(H, k, W, k).mean((1, 3))
            x, y = d["x"], d["y"]
            x0, x1, y0, y1 = x[0] - 5, x[W * k - 1] + 5, y[0] + 5, y[H * k - 1] - 5
            tr = Transformer.from_crs(int(d["epsg"]), 4326, always_xy=True)
            index.append({"pass_id": pid, "tile": tile, "url": url,
                          "coordinates": [[round(v, 6) for v in tr.transform(a, b)]
                                          for a, b in ((x0, y0), (x1, y0), (x1, y1), (x0, y1))]})
        note = "NISAR track 084 dual-pol, 2026 (provisional segment fields; INFERRED, no ground truth)"
        sheet(tile, pids, dates, states, hhs, np.s_[:, :], os.path.join(ART, f"quicklook_{tile}.png"), f"{tile}: {note}")
        sheet(tile, pids, dates, states, hhs, ZOOM, os.path.join(ART, f"zoom_{tile}.png"), f"{tile} 3x3 km zoom: {note}")
    json.dump(index, open(os.path.join(ART, "overlays", "index.json"), "w"), indent=1)
    print(f"{len(index)} overlays + quicklook/zoom sheets -> {ART}")


if __name__ == "__main__":
    main()
