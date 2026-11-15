"""Sentinel-1 C-band (second radar) per-field backscatter, early season.

Why: L-band NISAR HH confuses smooth wet soil with open water in July. C-band VV is the
standard open-water channel (water is very dark, ~ -20 dB) and Sentinel-1 passes every few days.
Data: Microsoft Planetary Computer, collection sentinel-1-rtc (radiometrically terrain corrected,
gamma0, linear power), signed anonymously. Pixels are warped onto the NISAR field grid (UTM 43N, 10 m)
and averaged per field in linear power, then converted to dB.
Output: artifacts/<run>/s1_fields.jsonl  {field_id, tile, s1_id, date, orbit, vv_db, vh_db, n_px}
"""
import json, os, sys
import numpy as np
import rasterio
from rasterio.vrt import WarpedVRT
from rasterio.enums import Resampling
from pystac_client import Client
import planetary_computer as pc
from zonal import on_grid, REF_PASS, field_id
from field_units import FieldUnits, grid_transform

RUN = os.environ.get("RUN_ID", "r01")
ART = os.path.join("artifacts", RUN)
DATES = os.environ.get("S1_DATES", "2026-06-15/2026-08-01")


def main():
    fields = FieldUnits(ART)
    tiles = sys.argv[1:] or fields.tiles()
    cat = Client.open("https://planetarycomputer.microsoft.com/api/stac/v1", modifier=pc.sign_inplace)
    out = open(os.path.join(ART, "s1_fields.jsonl"), "w")
    for tile in tiles:
        ref = np.load(f"data/{REF_PASS}_{tile}.npz"); x, y = ref["x"], ref["y"]
        if fields.geo:
            lab, _, _, meta = fields.raster(tile, x, y, ref["epsg"])
            nl = len(meta) + 1
        else:
            seg = np.load(f"data/segments_{tile}.npz")
            nl = int(seg["labels"].max()) + 1
        H, W = len(y), len(x)
        tf = grid_transform(x, y, ref["epsg"])
        if not fields.geo:
            lab = on_grid(seg["labels"], 10 * int(seg["ml"]), x[0] - 5, y[0] + 5, x, y)
        from pyproj import Transformer
        lo, la = Transformer.from_crs(int(ref["epsg"]), 4326, always_xy=True).transform([x[0], x[-1]], [y[-1], y[0]])
        items = sorted(cat.search(collections=["sentinel-1-rtc"], bbox=[lo[0], la[0], lo[1], la[1]], datetime=DATES).items(),
                       key=lambda i: i.datetime)
        for it in items:
            pol = {}
            for p in ("vv", "vh"):
                with rasterio.open(it.assets[p].href) as s, WarpedVRT(s, crs=f"EPSG:{int(ref['epsg'])}", transform=tf,
                                                                       width=W, height=H, resampling=Resampling.average) as v:
                    a = v.read(1).astype("f8")
                    a[(a <= 0) | ~np.isfinite(a)] = np.nan
                pol[p] = a
            ok = (lab > 0) & np.isfinite(pol["vv"]) & np.isfinite(pol["vh"])
            n = np.bincount(lab[ok], minlength=nl)
            sv = np.bincount(lab[ok], weights=pol["vv"][ok], minlength=nl)
            sh = np.bincount(lab[ok], weights=pol["vh"][ok], minlength=nl)
            orbit = f"{it.properties.get('sat:orbit_state','?')[0]}{it.properties.get('sat:relative_orbit','?')}"
            k = 0
            for i in np.nonzero(n >= 20)[0]:
                identity = meta[i-1]["field_id"] if fields.geo else field_id(tile, int(i))
                out.write(json.dumps({"field_id": identity, "tile": tile, "s1_id": it.id,
                                      **({"field_geometry_sha256": fields.fingerprints[identity]} if fields.geo else {}),
                                      "date": str(it.datetime.date()), "orbit": orbit, "n_px": int(n[i]),
                                      "vv_db": round(10 * np.log10(sv[i] / n[i]), 3),
                                      "vh_db": round(10 * np.log10(sh[i] / n[i]), 3)}) + chr(10)); k += 1
            print(tile, it.datetime.date(), orbit, k, "fields", flush=True)
    out.close()


if __name__ == "__main__":
    main()
