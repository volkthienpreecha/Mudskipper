#!/usr/bin/env python3
"""Choose the two real 15 x 15 km study tiles (SPEC A2) and write geo/tiles.json.

    uv run --project geo python geo/tiles.py [--data-dir DIR] [--out geo/tiles.json]

Rules, in order:

1. One tile per district: Fazilka and Sri Muktsar Sahib (geoBoundaries ADM2 names `Fazilka` and `Muktsar`).
   The tile is a 15 x 15 km square in EPSG:32643 whose south-west corner is a multiple of 20 m, and it lies at
   least DISTRICT_MARGIN_M inside its district.
2. Both tiles lie inside one NISAR frame and one orbit direction, for either series: descending track 135
   frame 73 (D-003) and ascending track 84 frame 17 (the pipeline's main series, pipeline/STATE.md). A tile must
   be at least FRAME_MARGIN_M inside the intersection of the footprints of every GCOV granule ASF lists for both
   frames in the season, so it is covered on every pass, quad-pol (narrower) or dual-pol.
3. Among the windows that pass 1-2 (origins on a STEP_M lattice), score by the GlobalRice20 2024 rice share
   (20 m) and cross-check with Zhao et al. 2024 (30 m): a window counts only if the independent Zhao mask also
   calls it rice-majority (share >= MIN_ZHAO_SHARE). The highest GlobalRice20 share wins (ties: north, then
   west). Zhao reads 0.1-0.25 higher than GlobalRice20 over the same rice belt, so an absolute agreement band
   would reject the densest windows for a systematic offset, not a contradiction.
4. The winner's rice shares are then recomputed exactly (area-weighted on each mask's native grid) and written.

Search scores use the masks reprojected (nearest) onto a 20 m UTM grid and summed with an integral image; the
published shares are the exact ones. Network: the ASF Search API (footprints) and the three downloads in
common.py, all cached under data/geo/.
"""
from __future__ import annotations

import argparse
import json
import pathlib
import urllib.parse
import urllib.request

import geopandas as gpd
import numpy as np
import rasterio
import shapely
from rasterio.transform import from_origin
from rasterio.warp import Resampling, reproject

import common as c
from rice import RiceMask, globalrice20_is_rice, rice_fractions, zhao_is_rice

DISTRICTS = [  # (tile id, district name used everywhere, geoBoundaries shapeName)
    ("fazilka", "Fazilka", "Fazilka"),
    ("muktsar", "Sri Muktsar Sahib", "Muktsar"),
]
FRAMES = [  # (track, direction, frame, role)
    (135, "descending", 73, "descending series (D-003)"),
    (84, "ascending", 17, "ascending series (pipeline main series)"),
]
STEP_M = 500
DISTRICT_MARGIN_M = 250
FRAME_MARGIN_M = 2_000
MIN_ZHAO_SHARE = 0.5
SEARCH_START, SEARCH_END = "2026-06-17T00:00:00Z", "2026-10-24T00:00:00Z"
FIXTURE_TILES = {"fazilka": [74.042, 30.2623, 74.198, 30.3977], "muktsar": [74.372, 30.3323, 74.528, 30.4677]}


# ------------------------------------------------------------------------------------------------ inputs
def asf_footprints(ddir: pathlib.Path, track: int, frame: int) -> dict:
    path = ddir / "geo" / "nisar" / f"asf_gcov_t{track:03d}_f{frame:03d}.geojson"
    if not path.exists():
        q = urllib.parse.urlencode({"dataset": "NISAR", "processingLevel": "GCOV", "relativeOrbit": track,
                                    "frame": frame, "start": SEARCH_START, "end": SEARCH_END, "output": "geojson"})
        url = f"{c.ASF_SEARCH}?{q}"
        c.log(f"ASF search: {url}")
        req = urllib.request.Request(url, headers={"User-Agent": "mudskipper-geo/0.1"})
        with urllib.request.urlopen(req, timeout=120) as r:
            body = r.read()
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(body)
    doc = json.loads(path.read_text(encoding="utf-8"))
    doc["_url"] = (f"{c.ASF_SEARCH}?dataset=NISAR&processingLevel=GCOV&relativeOrbit={track}&frame={frame}"
                   f"&start={SEARCH_START}&end={SEARCH_END}&output=geojson")
    return doc


def frame_core(doc: dict, track: int, frame: int):
    """Intersection of every granule footprint of this track/frame (lon/lat polygon) and the granule ids."""
    feats = [f for f in doc["features"]
             if f["properties"].get("pathNumber") == track and f["properties"].get("frameNumber") == frame]
    if not feats:
        raise SystemExit(f"ASF returned no GCOV granules for track {track} frame {frame}")
    polys = [shapely.geometry.shape(f["geometry"]) for f in feats]
    core = shapely.intersection_all(polys)
    ids = sorted(f["properties"]["sceneName"] for f in feats)
    return core, ids


def district_polygons(ddir: pathlib.Path) -> dict[str, shapely.Geometry]:
    path = c.fetch(c.GEOBOUNDARIES, ddir)
    g = gpd.read_file(path)
    out = {}
    for _, _, gb_name in DISTRICTS:
        rows = g[g["shapeName"] == gb_name]
        if len(rows) != 1:
            raise SystemExit(f"geoBoundaries: expected one district named {gb_name}, found {len(rows)}")
        out[gb_name] = shapely.make_valid(rows.geometry.iloc[0])
    return out


def utm_mask(path: pathlib.Path, classify, bounds_utm, res: float = c.SNAP_M) -> tuple[np.ndarray, float, float]:
    """A rice mask reprojected (nearest) onto a north-up 20 m UTM grid aligned to multiples of 20 m."""
    x0, y0, x1, y1 = (c.snap(bounds_utm[0]), c.snap(bounds_utm[1]),
                      c.snap(bounds_utm[2]) + res, c.snap(bounds_utm[3]) + res)
    w, h = int(round((x1 - x0) / res)), int(round((y1 - y0) / res))
    dst = np.zeros((h, w), dtype=np.uint8)
    with rasterio.open(path) as src:
        reproject(rasterio.band(src, 1), dst, dst_transform=from_origin(x0, y1, res, res),
                  dst_crs=f"EPSG:{c.UTM_EPSG}", resampling=Resampling.nearest, src_nodata=None, dst_nodata=None)
    return classify(dst).astype(np.uint8), x0, y1


def window_shares(mask: np.ndarray, gx0: float, gy1: float, x0s: np.ndarray, y0s: np.ndarray, size: float):
    """Rice share of each size x size window with south-west corners (x0s, y0s), via an integral image."""
    res = c.SNAP_M
    ii = np.zeros((mask.shape[0] + 1, mask.shape[1] + 1), dtype=np.int64)
    ii[1:, 1:] = mask.cumsum(0).cumsum(1)
    n = int(round(size / res))
    cols = np.round((x0s - gx0) / res).astype(np.int64)
    rows = np.round((gy1 - (y0s + size)) / res).astype(np.int64)
    s = ii[rows + n, cols + n] - ii[rows, cols + n] - ii[rows + n, cols] + ii[rows, cols]
    return s / float(n * n)


def tile_polygon_lonlat(utm_bounds):
    """The UTM square in lon/lat with edges densified every 100 m (they curve slightly in lon/lat)."""
    sq = shapely.segmentize(shapely.box(*utm_bounds), 100.0)
    return c.to_lonlat(sq)


def exact_shares(poly_ll, gr_path, zh_path) -> dict:
    b = shapely.bounds(poly_ll)
    gr = rice_fractions([poly_ll], RiceMask(gr_path, tuple(b), globalrice20_is_rice))[0]
    zh = rice_fractions([poly_ll], RiceMask(zh_path, tuple(b), zhao_is_rice))[0]
    return {"globalrice20_2024": round(float(gr), 4), "zhao_2024": round(float(zh), 4)}


# ------------------------------------------------------------------------------------------------ main
def choose(ddir: pathlib.Path) -> dict:
    gr_path, zh_path = c.fetch(c.GLOBALRICE20, ddir), c.fetch(c.ZHAO2024, ddir)
    districts = district_polygons(ddir)
    frames, cores_utm = [], []
    for track, direction, frame, role in FRAMES:
        doc = asf_footprints(ddir, track, frame)
        core, ids = frame_core(doc, track, frame)
        cores_utm.append(c.to_utm(core).buffer(-FRAME_MARGIN_M))
        frames.append({"track": track, "direction": direction, "frame": frame, "role": role,
                       "n_granules": len(ids), "source": doc["_url"], "granules": ids})
    frame_ok = shapely.intersection_all(cores_utm)
    shapely.prepare(frame_ok)

    tiles, report = [], []
    for tile_id, district, gb_name in DISTRICTS:
        d_utm = c.to_utm(districts[gb_name])
        allowed = shapely.intersection(d_utm.buffer(-DISTRICT_MARGIN_M), frame_ok)
        shapely.prepare(allowed)
        bx0, by0, bx1, by1 = shapely.bounds(d_utm)
        gx = np.arange(np.ceil(bx0 / STEP_M) * STEP_M, bx1 - c.TILE_SIZE_M + 1, STEP_M)
        gy = np.arange(np.ceil(by0 / STEP_M) * STEP_M, by1 - c.TILE_SIZE_M + 1, STEP_M)
        X, Y = np.meshgrid(gx, gy)
        x0s, y0s = X.ravel(), Y.ravel()
        boxes = shapely.box(x0s, y0s, x0s + c.TILE_SIZE_M, y0s + c.TILE_SIZE_M)
        ok = shapely.contains(allowed, boxes)
        x0s, y0s = x0s[ok], y0s[ok]
        if not len(x0s):
            raise SystemExit(f"{district}: no 15 km window fits inside the district and both NISAR frames")
        bounds = shapely.bounds(d_utm)
        gr_m, gx0, gy1 = utm_mask(gr_path, globalrice20_is_rice, bounds)
        zh_m, zx0, zy1 = utm_mask(zh_path, zhao_is_rice, bounds)
        gr_s = window_shares(gr_m, gx0, gy1, x0s, y0s, c.TILE_SIZE_M)
        zh_s = window_shares(zh_m, zx0, zy1, x0s, y0s, c.TILE_SIZE_M)
        agree = zh_s >= MIN_ZHAO_SHARE
        order = np.lexsort((x0s, -y0s, -gr_s))  # GR20 share desc, then north, then west
        order = [i for i in order if agree[i]]
        if not order:
            raise SystemExit(f"{district}: no candidate window is rice-majority under the Zhao mask")
        best = order[0]
        tile = c.Tile(tile_id, district, float(x0s[best]), float(y0s[best]))
        assert tile.x0 % c.SNAP_M == 0 and tile.y0 % c.SNAP_M == 0
        poly_ll = tile_polygon_lonlat(tile.utm_bounds)
        shares = exact_shares(poly_ll, gr_path, zh_path)
        district_ha = float(shapely.area(d_utm)) / 1e4
        top = [{"utm_origin": [int(x0s[i]), int(y0s[i])],
                "globalrice20_2024": round(float(gr_s[i]), 4), "zhao_2024": round(float(zh_s[i]), 4)}
               for i in order[:5]]
        fx = FIXTURE_TILES[tile_id]
        fixture_poly = shapely.box(*fx)
        tiles.append({"id": tile_id, "district": district, "geoboundaries_name": gb_name,
                      "utm_epsg": c.UTM_EPSG, "utm_origin": [int(tile.x0), int(tile.y0)], "size_m": c.TILE_SIZE_M,
                      "utm_bounds": [int(v) for v in tile.utm_bounds], "bbox": tile.bbox,
                      "center_lonlat": [round(float(v), 5) for v in shapely.centroid(poly_ll).coords[0]],
                      "rice_share": shares,
                      "search": {"candidates": int(len(x0s)), "zhao_majority_candidates": len(order),
                                 "district_area_ha": round(district_ha, 1),
                                 "top5_search_scores": top},
                      "fixture_tile": {"bbox": fx, "rice_share": exact_shares(fixture_poly, gr_path, zh_path)}})
        report.append(f"{district}: {len(x0s)} windows fit, {len(order)} rice-majority under Zhao; chosen origin "
                      f"{tile.x0:.0f},{tile.y0:.0f} bbox {tile.bbox} rice GR20 {shares['globalrice20_2024']:.3f} "
                      f"Zhao {shares['zhao_2024']:.3f} (fixture tile: {tiles[-1]['fixture_tile']['rice_share']})")
    for line in report:
        c.log(line)
    return {
        "description": "Real Mudskipper study tiles chosen by geo/tiles.py (see DECISIONS.md K-101, K-102).",
        "rule": {"step_m": STEP_M, "snap_m": c.SNAP_M, "size_m": c.TILE_SIZE_M,
                 "district_margin_m": DISTRICT_MARGIN_M, "frame_margin_m": FRAME_MARGIN_M,
                 "min_zhao_share": MIN_ZHAO_SHARE,
                 "score": "GlobalRice20 2024 rice share among windows with Zhao 2024 share >= min_zhao_share; "
                          "ties: north, then west"},
        "tiles": tiles,
        "frames": frames,
        "sources": {s.key: {"name": s.name, "url": s.url, "license": s.license, "citation": s.citation}
                    for s in (c.GLOBALRICE20, c.ZHAO2024, c.GEOBOUNDARIES)},
    }


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--data-dir", help="cache for downloads (default $MUDSKIPPER_DATA_DIR or <repo>/data)")
    ap.add_argument("--out", default=str(c.GEO_DIR / "tiles.rice-dense.json"))  # official tiles: tiles.json (K-117)
    args = ap.parse_args(argv)
    doc = choose(c.data_dir(args.data_dir))
    c.write_text(pathlib.Path(args.out), c.dump(doc))
    env = ";".join(f"{t['id']}:{','.join(repr(v) for v in t['bbox'])}" for t in doc["tiles"])
    print(f"wrote {args.out}\nAOI_TILES={env}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
