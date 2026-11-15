#!/usr/bin/env python3
"""H+0:45 hand-off: aoi.json for both real tiles and a labeled grid fields.geojson (source "grid").

    uv run --project geo python geo/grid.py [--run-dir artifacts/r01] [--data-dir data] [--copy-to FILE]

Each tile from geo/tiles.json is cut into 100 m x 100 m cells (1.0 ha) in EPSG:32643. Tile origins are multiples
of 20 m, so every cell is exactly 5 x 5 NISAR pixels at 20 m (10 x 10 at 10 m). A cell is kept when its
GlobalRice20 2024 rice share (area-weighted on the 20 m mask) is at least 0.5. If more than 5,000 cells qualify,
each tile gets an equal quota (any shortfall goes to the other tile) and the cells with the smallest
sha256("20261114|grid|<tile>|<row>|<col>") are kept: a seeded, platform-independent random sample. Kept cells are
numbered `<tile>-00001…` row by row from the north-west corner (row = north to south, col = west to east).

Writes <run>/aoi.json, <run>/fields.geojson and <run>/fields.pmtiles. `--copy-to` also saves the grid
fields.geojson elsewhere (the run directory may hold only contract files; keep the grid version in data/geo/).
"""
from __future__ import annotations

import argparse
import pathlib
import shutil

import numpy as np
import shapely

import common as c
import output
from rice import RiceMask, globalrice20_is_rice, rice_fractions


def grid_cells(tile: c.Tile, cell: float = c.CELL_M):
    """Cells as (rows, cols, lon/lat polygons rounded to 7 decimals), row-major from the north-west corner."""
    n = int(round(tile.size / cell))
    rows, cols = np.divmod(np.arange(n * n), n)
    x0 = tile.x0 + cols * cell
    y1 = tile.y0 + tile.size - rows * cell
    xs = np.stack([x0, x0 + cell, x0 + cell, x0, x0], axis=1)
    ys = np.stack([y1 - cell, y1 - cell, y1, y1, y1 - cell], axis=1)
    lon, lat = c.TO_LL.transform(xs.ravel(), ys.ravel())
    coords = np.stack([np.asarray(lon), np.asarray(lat)], axis=1).reshape(n * n, 5, 2)
    polys = shapely.polygons(coords)
    polys = np.array([c.round_geom(p) for p in polys], dtype=object)
    return rows, cols, polys


def build(tiles: list[c.Tile], gr_path: pathlib.Path, max_fields: int = c.MAX_FIELDS, seed: int = c.SEED):
    per_tile, stats = {}, {}
    for tile in tiles:
        rows, cols, polys = grid_cells(tile)
        mask = RiceMask(gr_path, tuple(shapely.total_bounds(polys)), globalrice20_is_rice)
        frac = np.round(rice_fractions(polys, mask), 4)
        keep = frac >= c.MIN_RICE_FRAC
        per_tile[tile.id] = [(int(r), int(k), p, float(f)) for r, k, p, f, ok
                             in zip(rows, cols, polys, frac, keep) if ok]
        stats[tile.id] = {"cells": int(len(polys)), "rice_ge_0.5": int(keep.sum()),
                          "tile_rice_share_mean_of_cells": round(float(frac.mean()), 4)}
    quota = c.quotas({t.id: len(per_tile[t.id]) for t in tiles}, max_fields)
    features = []
    for tile in tiles:
        cand = per_tile[tile.id]
        ranked = sorted(cand, key=lambda x: c.hash_rank(seed, f"grid|{tile.id}|{x[0]:03d}|{x[1]:03d}"))
        chosen = sorted(ranked[:quota[tile.id]], key=lambda x: (x[0], x[1]))
        stats[tile.id]["kept_after_cap"] = len(chosen)
        for i, (r, k, poly, f) in enumerate(chosen, start=1):
            feat = output.feature(f"{tile.id}-{i:05d}", tile, poly, f, "grid")
            if feat["properties"]["area_ha"] < c.MIN_AREA_HA:
                raise AssertionError("a 100 m cell must be 1 ha")
            features.append(feat)
    return features, stats


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--run-id", default=c.RUN_ID_DEFAULT)
    ap.add_argument("--run-dir", help="default $MUDSKIPPER_RUN_DIR or <repo>/artifacts/<run_id>")
    ap.add_argument("--data-dir", help="default $MUDSKIPPER_DATA_DIR or <repo>/data")
    ap.add_argument("--tiles", default=str(c.GEO_DIR / "tiles.json"))
    ap.add_argument("--copy-to", help="also copy the grid fields.geojson here (e.g. data/geo/r01/fields.grid.geojson)")
    ap.add_argument("--no-pmtiles", action="store_true")
    args = ap.parse_args(argv)

    tiles = c.load_tiles(pathlib.Path(args.tiles))
    ddir = c.data_dir(args.data_dir)
    run = c.run_dir(args.run_dir, args.run_id)
    features, stats = build(tiles, c.fetch(c.GLOBALRICE20, ddir))
    info = output.write_run(run, args.run_id, tiles, features, pmtiles=not args.no_pmtiles)
    for tid, s in stats.items():
        print(f"{tid}: {s}")
    print(f"wrote {run}/aoi.json and {run}/fields.geojson ({info})")
    if args.copy_to:
        dst = pathlib.Path(args.copy_to)
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(run / "fields.geojson", dst)
        print(f"copied the grid fields to {dst}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
