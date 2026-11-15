"""Field identity and pixel-centre grids shared by the radar pipeline.

GeoJSON is authoritative when present. Never attach a segment measurement to a
geo field by array position: the two sources have unrelated identities.
"""
import hashlib
import json
from pathlib import Path
import re

import numpy as np
from affine import Affine
from pyproj import CRS, Transformer
from rasterio.enums import MergeAlg
from rasterio.features import rasterize
from shapely import transform
from shapely.geometry import box, shape


def cache_matches(path, bbox, granule_id):
    """A tile name is insufficient: geo handoffs can move its AOI boundary."""
    path = Path(path)
    try:
        side = json.loads(Path(str(path) + ".json").read_text(encoding="utf-8"))
        if (side["granule_id"] != granule_id or len(side["bbox"]) != 4
                or not np.allclose(side["bbox"], bbox, rtol=0, atol=1e-9)):
            return False
        with path.open("rb") as stream:
            return hashlib.file_digest(stream, "sha256").hexdigest() == side["subset_sha256"]
    except (OSError, ValueError, KeyError, TypeError):
        return False


def grid_transform(x, y, epsg):
    """Validate a north-up cached raster and return its centre-derived affine."""
    x, y = np.asarray(x), np.asarray(y)
    if (x.ndim != 1 or y.ndim != 1 or len(x) < 2 or len(y) < 2
            or not np.isfinite(x).all() or not np.isfinite(y).all()):
        raise ValueError("raster x/y must be finite one-dimensional centre arrays with >=2 cells")
    dx, dy = float(x[1] - x[0]), float(y[1] - y[0])
    if dx <= 0 or dy >= 0 or not np.allclose(np.diff(x), dx) or not np.allclose(np.diff(y), dy):
        raise ValueError("raster grid must be regular, x increasing and y decreasing")
    try:
        crs = CRS.from_user_input(int(epsg))
    except (TypeError, ValueError) as exc:
        raise ValueError("cached radar raster requires a valid epsg CRS") from exc
    if not crs.is_projected:
        raise ValueError("cached radar raster must have a projected CRS")
    return Affine(dx, 0, float(x[0]) - dx / 2, 0, dy, float(y[0]) - dy / 2)


def sample_grid(src, tf, x, y, fill=0):
    """Nearest cell at each target centre; outside the source grid gets fill."""
    col = np.floor((np.asarray(x) - tf.c) / tf.a).astype(int)
    row = np.floor((np.asarray(y) - tf.f) / tf.e).astype(int)
    inside = ((row >= 0) & (row < src.shape[0]))[:, None] & ((col >= 0) & (col < src.shape[1]))[None, :]
    out = src[np.clip(row, 0, src.shape[0] - 1)][:, np.clip(col, 0, src.shape[1] - 1)]
    return np.where(inside, out, fill)


class FieldUnits:
    def __init__(self, art, data="data", ref_pass="p20260702"):
        self.art, self.data, self.ref_pass = Path(art), Path(data), ref_pass
        path = self.art / "fields.geojson"
        self.geo = path.exists()
        self.collection = self.aoi = None
        self.by_tile = {}
        self.fingerprints = {}
        if not self.geo:
            return
        aoi_path = self.art / "aoi.json"
        if not aoi_path.exists():
            raise ValueError("fields.geojson requires its matching aoi.json handoff")
        self.collection = json.loads(path.read_text(encoding="utf-8"))
        self.aoi = json.loads(aoi_path.read_text(encoding="utf-8"))
        if self.collection.get("run_id") != self.aoi.get("run_id"):
            raise ValueError("fields.geojson and aoi.json run_id differ")
        crs = self.collection.get("crs")
        if crs and crs.get("properties", {}).get("name") not in ("EPSG:4326", "urn:ogc:def:crs:OGC:1.3:CRS84"):
            raise ValueError("contract fields.geojson must use WGS84 longitude/latitude")
        tiles = {t["id"]: t for t in self.aoi["tiles"]}
        seen = set()
        for feature in self.collection["features"]:
            p = feature["properties"]
            fid, tile = p["field_id"], p["tile"]
            if fid in seen or not re.fullmatch(re.escape(tile) + r"-\d{5}", fid):
                raise ValueError(f"duplicate or invalid geo field identity: {fid}")
            seen.add(fid)
            if tile not in tiles or p["district"] != tiles[tile]["district"]:
                raise ValueError(f"field {fid} has no matching AOI tile/district")
            g = shape(feature["geometry"])
            if g.geom_type not in ("Polygon", "MultiPolygon") or g.is_empty or not g.is_valid:
                raise ValueError(f"field {fid} requires a valid Polygon/MultiPolygon")
            if not (-180 <= g.bounds[0] <= g.bounds[2] <= 180 and -90 <= g.bounds[1] <= g.bounds[3] <= 90):
                raise ValueError(f"field {fid} is not WGS84 lon/lat")
            if not g.intersects(box(*tiles[tile]["bbox"])):
                raise ValueError(f"field {fid} does not intersect its AOI tile")
            if (p["source"] not in ("ftw", "manual", "grid") or not np.isfinite(p["area_ha"])
                    or p["area_ha"] < 0.5 or not 0.5 <= p["rice_mask_frac"] <= 1):
                raise ValueError(f"field {fid} has invalid source/area/rice metadata")
            self.by_tile.setdefault(tile, []).append(feature)
            self.fingerprints[fid] = hashlib.sha256(json.dumps(feature, sort_keys=True, separators=(",", ":"),
                                                              allow_nan=False).encode()).hexdigest()
        for features in self.by_tile.values():
            features.sort(key=lambda f: f["properties"]["field_id"])
        if not seen:
            raise ValueError("fields.geojson has no fields")

    def tiles(self):
        return sorted(self.by_tile) if self.geo else sorted(p.stem[9:] for p in self.data.glob("segments_*.npz"))

    def metadata(self, tile):
        if self.geo:
            if tile not in self.by_tile:
                raise ValueError(f"no geo fields assigned to tile {tile}")
            return [dict(f["properties"]) for f in self.by_tile[tile]]
        with np.load(self.data / f"segments_{tile}.npz") as seg:
            return [{"field_id": f"{tile}_s{i:05d}", "tile": tile, "area_ha": round(float(a), 2),
                     "source": "segments", "crop_frac": round(float(c), 3)}
                    for i, (a, c) in enumerate(zip(seg["area_ha"], seg["crop_frac"]), 1)]

    def raster(self, tile, x, y, epsg):
        """labels, eligible mask, full-field pixel counts, ordered metadata.

        Label i maps only to metadata[i-1]. Geo totals include field centres
        outside this cached window, so valid_frac reflects partial coverage.
        Segment fallback retains its historical crop-mask denominator.
        """
        tf = grid_transform(x, y, epsg)
        meta = self.metadata(tile)
        if not self.geo:
            with np.load(self.data / f"{self.ref_pass}_{tile}.npz") as ref:
                rt = grid_transform(ref["x"], ref["y"], ref["epsg"])
                if int(ref["epsg"]) != int(epsg):
                    raise ValueError(f"segment grid CRS differs from radar CRS for {tile}; reproject explicitly")
            with np.load(self.data / f"segments_{tile}.npz") as seg:
                labels = seg["labels"]
                st = rt @ Affine.scale(int(seg["ml"]))
                lab = sample_grid(labels, st, x, y)
            with np.load(self.data / f"landcover_{tile}.npz") as lc:
                crop = sample_grid(lc["crop"], rt, x, y, fill=False).astype(bool)
            if int(lab.max()) > len(meta):
                raise ValueError(f"segment labels and metadata disagree for {tile}")
            return lab, crop, np.bincount(lab[crop & (lab > 0)], minlength=len(meta) + 1), meta
        tr = Transformer.from_crs(4326, int(epsg), always_xy=True)
        projected = [transform(shape(f["geometry"]), tr.transform, interleaved=False) for f in self.by_tile[tile]]
        height, width = len(y), len(x)
        bounds = box(tf.c, tf.f + height * tf.e, tf.c + width * tf.a, tf.f)
        shapes = [(g, i) for i, g in enumerate(projected, 1) if g.intersects(bounds)]
        if not shapes:
            raise ValueError(f"no geo fields intersect cached raster for {tile}; check AOI, CRS and cache")
        lab = rasterize(shapes, out_shape=(height, width), transform=tf, dtype="int32", all_touched=False)
        hits = rasterize([(g, 1) for g, _ in shapes], out_shape=(height, width), transform=tf,
                         dtype="int32", merge_alg=MergeAlg.add, all_touched=False)
        if np.any(hits > 1):
            raise ValueError(f"geo fields overlap at raster pixel centres in {tile}; resolve field boundaries")
        if not np.any(lab):
            raise ValueError(f"geo fields contain no raster pixel centres for {tile}; check grid resolution")
        totals = np.zeros(len(meta) + 1, dtype=np.int64)
        for i, g in enumerate(projected, 1):
            left, bottom, right, top = g.bounds
            c0, c1 = int(np.floor((left - tf.c) / tf.a)), int(np.ceil((right - tf.c) / tf.a))
            r0, r1 = int(np.floor((top - tf.f) / tf.e)), int(np.ceil((bottom - tf.f) / tf.e))
            # Avoid allocating an unbounded grid for a corrupt/mismatched geometry.
            if (c1 - c0) * (r1 - r0) > 25_000_000:
                raise ValueError(f"field {meta[i-1]['field_id']} exceeds 25M pixels; check CRS/resolution")
            if c1 > c0 and r1 > r0:
                totals[i] = rasterize([(g, 1)], out_shape=(r1-r0, c1-c0),
                                      transform=tf @ Affine.translation(c0, r0), dtype="uint8").sum()
        return lab, np.ones(lab.shape, dtype=bool), totals, meta
