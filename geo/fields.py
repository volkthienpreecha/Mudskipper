#!/usr/bin/env python3
"""H+3 hand-off: real field polygons (source "ftw") replace the grid in <run>/fields.geojson + fields.pmtiles.

    uv run --project geo python geo/fields.py                       # FTW global 2nd edition, 2024 (default)
    uv run --project geo --extra ftw python geo/fields.py --method ftw-local --tile fazilka --run-dir DIR

Two ways to get polygons, then one filter chain:

* `ftw-global` (primary): the Fields of The World global 2nd-edition 2024 predictions (CC-BY-4.0), read with
  one DuckDB bbox query per tile straight from the zone-43 GeoParquet on source.coop (HTTP range reads; only
  the row groups that overlap the tile are fetched). Cached in data/geo/ftw/.
* `ftw-local` (secondary, reproducible from imagery): ftw-tools 2.0.0b5 `ftw inference all` on Sentinel-2 2024
  for the tile bbox with the CC-BY-4.0 model FTW_PRUE_EFNET_B5_CCBY (DECISIONS F-006), then
  `ftw inference polygonize` again with the global product's settings (5 m simplification, 900 m² minimum,
  enclosed holes closed) so both paths enter the filter chain on equal terms. About 5 minutes per tile on CPU.

Filter chain, in order, each step counted (DECISIONS.md K-104):

1. clip to the tile's 15 km UTM square (geometry repaired with make_valid first; polygons that only touch
   the tile's lon/lat bbox drop out here),
2. coordinates snapped to 1e-7° (GEOS set_precision keeps them valid),
3. area ≥ 0.5 ha, computed in EPSG:32643 on the published geometry (CONTRACTS.md B3.3),
4. rice_mask_frac ≥ 0.5: area-weighted GlobalRice20 2024 share on its native 20 m grid (geo/rice.py),
5. cap: at most 5,000 fields; each tile gets an equal quota (any shortfall goes to the other tile) and keeps
   the polygons with the smallest sha256("20261114|ftw|<tile>|<source id>"), a seeded random sample that does
   not favour big or small fields and is the same on every machine.

Survivors get ids `<tile>-00001…` in reading order (500 m bands north to south, west to east inside a band)
and a label point inside the polygon (shapely point_on_surface, checked with the contract's even-odd test).
"""
from __future__ import annotations

import argparse
import hashlib
import json
import pathlib
import shutil
import subprocess
import sys

import geopandas as gpd
import numpy as np
import shapely

import common as c
import output
from rice import RiceMask, globalrice20_is_rice, rice_fractions, zhao_is_rice

FTW_MODEL = "FTW_PRUE_EFNET_B5_CCBY"
FTW_YEAR = 2024
POLYGONIZE_ARGS = ["--simplify", "5", "--min_size", "900", "--close_interiors"]


# ------------------------------------------------------------------------------------------------ sources
def bbox_key(bbox) -> str:
    return hashlib.sha256(",".join(f"{v:.6f}" for v in bbox).encode()).hexdigest()[:10]


def ftw_global(tile: c.Tile, ddir: pathlib.Path) -> gpd.GeoDataFrame:
    """Every FTW 2024 polygon whose bbox overlaps the tile's lon/lat bbox (cached as GeoParquet)."""
    url, _ = c.FTW_GLOBAL_2024
    x0, y0, x1, y1 = tile.bbox
    cache = ddir / "geo" / "ftw" / f"global2e_{FTW_YEAR}_{tile.id}_{bbox_key(tile.bbox)}.parquet"
    if not cache.exists():
        import duckdb  # imported lazily: the tests never touch the network

        con = duckdb.connect()
        for ext in ("httpfs", "spatial"):
            con.install_extension(ext)
            con.load_extension(ext)
        c.log(f"{tile.id}: DuckDB bbox query on {url}")
        rows = con.execute(
            f"""SELECT id, score, "metrics:area" AS area_m2, ST_AsWKB(geometry) AS wkb
                FROM read_parquet('{url}')
                WHERE bbox.xmin < ? AND bbox.xmax > ? AND bbox.ymin < ? AND bbox.ymax > ?
                ORDER BY id""", [x1, x0, y1, y0]).fetchall()
        gdf = gpd.GeoDataFrame({"id": [r[0] for r in rows], "score": [int(r[1]) for r in rows],
                                "area_m2": [float(r[2]) for r in rows]},
                               geometry=shapely.from_wkb([bytes(r[3]) for r in rows]), crs="EPSG:4326")
        cache.parent.mkdir(parents=True, exist_ok=True)
        gdf.to_parquet(cache)
    gdf = gpd.read_parquet(cache)
    return gdf.sort_values("id", kind="stable").reset_index(drop=True)


def ftw_local(tile: c.Tile, ddir: pathlib.Path, ftw_bin: str = "ftw") -> gpd.GeoDataFrame:
    """Run ftw-tools on the tile and re-polygonize with the global product's settings (cached)."""
    work = ddir / "geo" / "ftw" / f"local_{FTW_YEAR}_{tile.id}_{bbox_key(tile.bbox)}"
    polys = work / "fields_repolygonized.parquet"
    if not polys.exists():
        work.mkdir(parents=True, exist_ok=True)
        bbox = ",".join(f"{v:.6f}" for v in tile.bbox)
        raster = work / "inference_output.tif"
        if not raster.exists():
            cmd = [ftw_bin, "inference", "all", f"--bbox={bbox}", f"--year={FTW_YEAR}", f"--out={work}",
                   f"--model={FTW_MODEL}", "-f"]
            c.log("running: " + " ".join(cmd))
            subprocess.run(cmd, check=True)
        cmd = [ftw_bin, "inference", "polygonize", str(raster), "-o", str(polys), *POLYGONIZE_ARGS, "-f"]
        c.log("running: " + " ".join(cmd))
        subprocess.run(cmd, check=True)
    gdf = gpd.read_parquet(polys).to_crs(4326).reset_index(drop=True)
    gdf["id"] = [f"local-{i:06d}" for i in range(len(gdf))]
    return gdf


# ------------------------------------------------------------------------------------------------ filters
def candidates(tile: c.Tile, gdf: gpd.GeoDataFrame, gr_path, zh_path=None) -> tuple[list[dict], dict]:
    """Steps 1-4 for one tile. Returns the surviving polygons and the count removed at each step."""
    counts = {"in_bbox": int(len(gdf))}
    geoms = np.asarray(gdf.geometry.values, dtype=object)
    ids = list(gdf["id"])
    invalid = ~shapely.is_valid(geoms)
    counts["repaired_invalid"] = int(invalid.sum())
    geoms = shapely.make_valid(geoms)
    utm = c.to_utm(geoms)
    clipped = shapely.intersection(utm, tile.utm_box)
    raw_area_ha = shapely.area(utm) / 1e4
    kept, outside, unrepairable = [], 0, 0
    for fid, g in zip(ids, clipped):
        g = c.polygonal(g)
        if g is None or g.area < 1.0:  # m²: only touches the tile, or a clipping sliver along its edge
            outside += 1
            continue
        g = c.round_geom(c.to_lonlat(g))
        if g is None or g.is_empty:
            unrepairable += 1
            continue
        kept.append((fid, g))
    counts["removed_outside_tile"] = outside
    counts["removed_unrepairable"] = unrepairable
    counts["median_area_ha_before_filters"] = round(float(np.median(raw_area_ha)), 3) if len(raw_area_ha) else None
    areas = np.round(np.array([c.area_ha_utm(g) for _, g in kept]), 4)
    counts["clipped_median_area_ha"] = round(float(np.median(areas)), 3) if len(areas) else None
    big = areas >= c.MIN_AREA_HA
    counts["removed_lt_0.5ha"] = int((~big).sum())
    kept = [k for k, ok in zip(kept, big) if ok]
    geoms_ll = np.array([g for _, g in kept], dtype=object)
    if len(geoms_ll):
        mask = RiceMask(gr_path, tuple(shapely.total_bounds(geoms_ll)), globalrice20_is_rice)
        frac = np.round(rice_fractions(geoms_ll, mask), 4)
    else:
        frac = np.zeros(0)
    rice = frac >= c.MIN_RICE_FRAC
    counts["removed_rice_lt_0.5"] = int((~rice).sum())
    if zh_path is not None and len(geoms_ll):
        zmask = RiceMask(zh_path, tuple(shapely.total_bounds(geoms_ll)), zhao_is_rice)
        zfrac = rice_fractions(geoms_ll, zmask)
        counts["zhao_cross_check"] = {
            "after_area_filter_share_with_zhao_ge_0.5": round(float((zfrac >= 0.5).mean()), 4),
            "kept_share_with_zhao_ge_0.5": round(float((zfrac[rice] >= 0.5).mean()), 4) if rice.any() else None,
        }
    out = [{"id": fid, "geom": g, "rice": float(f)} for (fid, g), f, ok in zip(kept, frac, rice) if ok]
    counts["eligible"] = len(out)
    return out, counts


def select(tiles: list[c.Tile], per_tile: dict[str, list[dict]], method: str, max_fields: int = c.MAX_FIELDS,
           seed: int = c.SEED) -> tuple[list[dict], dict]:
    """Step 5 (cap) and id assignment."""
    quota = c.quotas({t.id: len(per_tile[t.id]) for t in tiles}, max_fields)
    features, removed = [], {}
    for tile in tiles:
        cand = sorted(per_tile[tile.id], key=lambda x: c.hash_rank(seed, f"ftw|{tile.id}|{x['id']}"))
        chosen, removed[tile.id] = cand[:quota[tile.id]], max(0, len(cand) - quota[tile.id])
        feats = []
        for x in chosen:
            f = output.feature("", tile, x["geom"], x["rice"], "ftw")
            p = f["properties"]
            feats.append((output.spatial_order_key(tile, p["lon"], p["lat"], x["id"]), x["id"], f))
        feats.sort(key=lambda t: t[0])
        for i, (_, src_id, f) in enumerate(feats, start=1):
            f["properties"]["field_id"] = f"{tile.id}-{i:05d}"
            features.append(f)
    return features, removed


def run(tiles: list[c.Tile], method: str, ddir: pathlib.Path, ftw_bin: str = "ftw"):
    gr_path, zh_path = c.fetch(c.GLOBALRICE20, ddir), c.fetch(c.ZHAO2024, ddir)
    per_tile, report = {}, {"method": method, "tiles": {}}
    for tile in tiles:
        gdf = ftw_global(tile, ddir) if method == "ftw-global" else ftw_local(tile, ddir, ftw_bin)
        per_tile[tile.id], report["tiles"][tile.id] = candidates(tile, gdf, gr_path, zh_path)
    features, removed = select(tiles, per_tile, method)
    for tile in tiles:
        r = report["tiles"][tile.id]
        r["removed_by_cap"] = removed[tile.id]
        r["kept"] = sum(1 for f in features if f["properties"]["tile"] == tile.id)
        kept = [f["properties"] for f in features if f["properties"]["tile"] == tile.id]
        if kept:
            r["kept_area_ha"] = round(sum(p["area_ha"] for p in kept), 2)
            r["kept_median_area_ha"] = round(float(np.median([p["area_ha"] for p in kept])), 3)
            r["kept_mean_rice_mask_frac"] = round(float(np.mean([p["rice_mask_frac"] for p in kept])), 4)
    report["total_kept"] = len(features)
    return features, report


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--method", choices=["ftw-global", "ftw-local"], default="ftw-global")
    ap.add_argument("--run-id", default=c.RUN_ID_DEFAULT)
    ap.add_argument("--run-dir", help="default $MUDSKIPPER_RUN_DIR or <repo>/artifacts/<run_id>")
    ap.add_argument("--data-dir", help="default $MUDSKIPPER_DATA_DIR or <repo>/data")
    ap.add_argument("--tiles", default=str(c.GEO_DIR / "tiles.json"))
    ap.add_argument("--tile", action="append", help="only these tile ids (default: all)")
    ap.add_argument("--ftw-bin", default=None, help="ftw executable (default: next to this Python, else on PATH)")
    ap.add_argument("--report", help="write the filter counts as JSON here")
    ap.add_argument("--no-pmtiles", action="store_true")
    args = ap.parse_args(argv)

    tiles = c.load_tiles(pathlib.Path(args.tiles))
    if args.tile:
        tiles = [t for t in tiles if t.id in args.tile]
    ftw_bin = args.ftw_bin or str(pathlib.Path(sys.executable).with_name("ftw"))
    if args.method == "ftw-local" and not pathlib.Path(ftw_bin).exists():
        ftw_bin = shutil.which("ftw") or ftw_bin
    ddir = c.data_dir(args.data_dir)
    out = c.run_dir(args.run_dir, args.run_id)
    features, report = run(tiles, args.method, ddir, ftw_bin)
    info = output.write_run(out, args.run_id, tiles, features, pmtiles=not args.no_pmtiles)
    report["outputs"] = info
    text = json.dumps(report, indent=2)
    print(text)
    if args.report:
        c.write_text(pathlib.Path(args.report), text + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
