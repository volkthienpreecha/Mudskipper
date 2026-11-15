"""Shared constants, data sources, geometry helpers and writers for the geo lane.

Everything here is deterministic: no wall clock, no unseeded randomness, no dict-order surprises. Writers follow
contracts/CONTRACTS.md C0 (UTF-8, LF, keys in schema order, finite numbers only, byte-identical reruns).
"""
from __future__ import annotations

import hashlib
import json
import math
import os
import pathlib
import sys
import urllib.request
from dataclasses import dataclass

import numpy as np
import shapely
from pyproj import Transformer

GEO_DIR = pathlib.Path(__file__).resolve().parent
REPO = GEO_DIR.parent
sys.path.insert(0, str(REPO / "contracts"))
import rules  # noqa: E402  (contracts/rules.py: the reference containment test the validator uses)

UTM_EPSG = 32643
SNAP_M = 20  # tile origins are multiples of 20 m in EPSG:32643 (NISAR GCOV 20 m / 10 m posting)
TILE_SIZE_M = 15_000
CELL_M = 100  # grid cell: 1.0 ha, 5 x 5 pixels at 20 m, 10 x 10 at 10 m
MIN_AREA_HA = 0.5
MIN_RICE_FRAC = 0.5
MAX_FIELDS = 5_000
COORD_DECIMALS = 7
SEED = 20261114

RUN_ID_DEFAULT = "r01"
SEASON = {"start": "2026-06-17", "end": "2026-10-23"}
STAGES = {"mid_start": "2026-07-15", "late_start": "2026-09-10"}
NISAR_GAP = {"start": "2026-07-27T22:03:25Z", "end": "2026-08-10T00:55:27Z",
             "source": "https://nisar-docs.asf.alaska.edu/availability-overview/"}

TO_UTM = Transformer.from_crs(4326, UTM_EPSG, always_xy=True)
TO_LL = Transformer.from_crs(UTM_EPSG, 4326, always_xy=True)


# ------------------------------------------------------------------------------------------------ paths
def data_dir(override: str | os.PathLike | None = None) -> pathlib.Path:
    """Raw downloads and caches. `--data-dir` > $MUDSKIPPER_DATA_DIR > <repo>/data (gitignored)."""
    p = pathlib.Path(override or os.environ.get("MUDSKIPPER_DATA_DIR") or REPO / "data")
    return p.resolve()


def run_dir(override: str | os.PathLike | None = None, run_id: str = RUN_ID_DEFAULT) -> pathlib.Path:
    """The run directory. `--run-dir` > $MUDSKIPPER_RUN_DIR > <repo>/artifacts/<run_id> (gitignored)."""
    p = pathlib.Path(override or os.environ.get("MUDSKIPPER_RUN_DIR") or REPO / "artifacts" / run_id)
    return p.resolve()


# ------------------------------------------------------------------------------------------------ sources
@dataclass(frozen=True)
class Source:
    key: str
    name: str
    url: str
    relpath: str  # under data_dir()/geo
    md5: str | None
    license: str
    citation: str


GLOBALRICE20 = Source(
    "globalrice20", "GlobalRice20 2024 paddy rice map, 20 m (tile Lat0_Lon45)",
    "https://zenodo.org/api/records/18168302/files/2024_Lat0_Lon45.tif/content",
    "rice/globalrice20_2024_Lat0_Lon45.tif", "9c64faa3757d92f7fd07b0eb9e3dc132", "CC-BY-4.0",
    "Zhang, Song, Ding, Xie, Guo and Xu (2026), GlobalRice20, Zenodo, https://doi.org/10.5281/zenodo.18168302")
ZHAO2024 = Source(
    "zhao2024", "Zhao et al. paddy rice and cropping intensity 2024, 30 m (India North)",
    "https://zenodo.org/api/records/21349862/files/India%20North%202024.tif/content",
    "rice/zhao2024_india_north.tif", "adef9c515b54c082190848281f607cf1", "CC-BY-4.0",
    "Zhao, Dong, Zhang, Yang and Xiao (2026), paddy rice in South and Southeast Asia 1995-2024 at 30 m, Zenodo, "
    "https://doi.org/10.5281/zenodo.21349862")
GEOBOUNDARIES = Source(
    "geoboundaries", "geoBoundaries gbOpen India ADM2 (districts, 2021; source Pathways Data / lgdirectory.gov.in)",
    "https://github.com/wmgeolab/geoBoundaries/raw/9469f09/releaseData/gbOpen/IND/ADM2/geoBoundaries-IND-ADM2.geojson",
    "boundaries/geoBoundaries-IND-ADM2.geojson", None, "ODbL-1.0",
    "Runfola et al. (2020) geoBoundaries, PLoS ONE 15(4): e0231866; IND ADM2 build 9469f09")
FTW_GLOBAL_2024 = ("https://data.source.coop/ftw/global-data-2e/vector/2024/zone=43/utm43.parquet",
                   "Fields of The World global data, 2nd edition, 2024 predictions (CC-BY-4.0)")
ASF_SEARCH = "https://api.daac.asf.alaska.edu/services/search/param"


def md5_file(path: pathlib.Path) -> str:
    h = hashlib.md5()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 22), b""):
            h.update(chunk)
    return h.hexdigest()


def sha256_file(path: pathlib.Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 22), b""):
            h.update(chunk)
    return h.hexdigest()


def fetch(src: Source, ddir: pathlib.Path, verify: bool = True) -> pathlib.Path:
    """Download a source once into data/geo/ and verify its published md5 (when the source publishes one)."""
    path = ddir / "geo" / src.relpath
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(path.suffix + ".part")
        log(f"downloading {src.name}\n  {src.url}")
        req = urllib.request.Request(src.url, headers={"User-Agent": "mudskipper-geo/0.1"})
        with urllib.request.urlopen(req, timeout=600) as r, tmp.open("wb") as f:
            while chunk := r.read(1 << 22):
                f.write(chunk)
        tmp.replace(path)
    if verify and src.md5:
        got = md5_file(path)
        if got != src.md5:
            raise SystemExit(f"{path}: md5 {got} != published {src.md5}; delete it and rerun")
    return path


def log(msg: str) -> None:
    sys.stderr.write(msg + "\n")
    sys.stderr.flush()


# ------------------------------------------------------------------------------------------------ tiles
@dataclass(frozen=True)
class Tile:
    id: str
    district: str
    x0: float  # UTM origin (south-west corner), multiple of SNAP_M
    y0: float
    size: float = TILE_SIZE_M

    @property
    def utm_bounds(self) -> tuple[float, float, float, float]:
        return (self.x0, self.y0, self.x0 + self.size, self.y0 + self.size)

    @property
    def utm_box(self) -> shapely.Polygon:
        return shapely.box(*self.utm_bounds)

    @property
    def bbox(self) -> list[float]:
        return lonlat_bbox(self.utm_bounds)


def snap(v: float, step: float = SNAP_M) -> float:
    return float(math.floor(v / step) * step)


def lonlat_bbox(utm_bounds, decimals: int = 6) -> list[float]:
    """Lon/lat envelope of a UTM rectangle (edges densified every 100 m), rounded outward."""
    x0, y0, x1, y1 = utm_bounds
    n = max(2, int(round(max(x1 - x0, y1 - y0) / 100)) + 1)
    xs = np.linspace(x0, x1, n)
    ys = np.linspace(y0, y1, n)
    ex = np.concatenate([xs, np.full(n, x1), xs[::-1], np.full(n, x0)])
    ey = np.concatenate([np.full(n, y0), ys, np.full(n, y1), ys[::-1]])
    lon, lat = TO_LL.transform(ex, ey)
    f = 10 ** decimals
    return [math.floor(lon.min() * f) / f, math.floor(lat.min() * f) / f,
            math.ceil(lon.max() * f) / f, math.ceil(lat.max() * f) / f]


def load_tiles(path: pathlib.Path | None = None) -> list[Tile]:
    doc = json.loads((path or GEO_DIR / "tiles.json").read_text(encoding="utf-8"))
    return [Tile(t["id"], t["district"], float(t["utm_origin"][0]), float(t["utm_origin"][1]),
                 float(t.get("size_m", TILE_SIZE_M))) for t in doc["tiles"]]


# ------------------------------------------------------------------------------------------------ geometry
def to_lonlat(geoms):
    return shapely.transform(geoms, lambda xy: np.column_stack(TO_LL.transform(xy[:, 0], xy[:, 1])))


def to_utm(geoms):
    return shapely.transform(geoms, lambda xy: np.column_stack(TO_UTM.transform(xy[:, 0], xy[:, 1])))


def polygonal(geom):
    """Keep only the polygonal parts of a geometry (make_valid can return collections with lines/points)."""
    if geom is None or geom.is_empty:
        return None
    if geom.geom_type in ("Polygon", "MultiPolygon"):
        return geom
    if geom.geom_type == "GeometryCollection":
        parts = []
        for g in shapely.get_parts(geom):
            if g.geom_type == "Polygon":
                parts.append(g)
            elif g.geom_type == "MultiPolygon":
                parts.extend(shapely.get_parts(g))
        if not parts:
            return None
        return parts[0] if len(parts) == 1 else shapely.MultiPolygon(parts)
    return None


def round_geom(geom, decimals: int = COORD_DECIMALS):
    """Snap lon/lat to a 1e-7 grid without breaking validity (GEOS set_precision).

    Then normalize (deterministic vertex order) and orient rings as RFC 7946 asks: exteriors counter-clockwise,
    holes clockwise.
    """
    g = None
    # GEOS can refuse a pathological input ("unable to assign free hole to a shell"); retry on a repaired copy.
    for attempt in (lambda: geom, lambda: shapely.make_valid(geom), lambda: geom.buffer(0)):
        try:
            g = shapely.set_precision(attempt(), 10 ** -decimals)
            break
        except shapely.errors.GEOSException:
            continue
    g = polygonal(g)
    if g is None or not g.is_valid:
        return None
    return shapely.orient_polygons(shapely.normalize(g))


def geometry_json(geom) -> dict:
    """GeoJSON geometry with closed rings, exterior first, coordinates rounded to COORD_DECIMALS."""
    def ring(r):
        cs = [[round(x, COORD_DECIMALS), round(y, COORD_DECIMALS)] for x, y in shapely.get_coordinates(r)]
        return cs

    def poly(p):
        return [ring(p.exterior)] + [ring(i) for i in p.interiors]

    if geom.geom_type == "Polygon":
        return {"type": "Polygon", "coordinates": poly(geom)}
    return {"type": "MultiPolygon", "coordinates": [poly(p) for p in geom.geoms]}


def label_point(geom_json: dict, geom) -> tuple[float, float]:
    """A point strictly inside the published polygon, checked with the contract's own even-odd test.

    shapely.point_on_surface first; for slivers where rounding to 7 decimals could move it onto an edge, fall
    back to the point on surface of an inward buffer, then to the largest part's representative point.
    """
    candidates = [shapely.point_on_surface(geom)]
    for d in (1e-6, 3e-6, 1e-5):
        inner = geom.buffer(-d)
        if not inner.is_empty:
            candidates.append(shapely.point_on_surface(inner))
    parts = sorted(shapely.get_parts(geom), key=lambda p: -p.area)
    candidates.append(parts[0].representative_point())
    for p in candidates:
        lon, lat = round(p.x, COORD_DECIMALS), round(p.y, COORD_DECIMALS)
        if rules.contains(geom_json, lon, lat):
            return lon, lat
    raise ValueError("no interior label point found")


def area_ha_utm(geom_lonlat) -> float:
    return float(shapely.area(to_utm(geom_lonlat))) / 10_000


# ------------------------------------------------------------------------------------------------ hashing
def hash_rank(seed: int, key: str) -> str:
    """Deterministic, platform- and version-independent pseudo-random rank for capped selection."""
    return hashlib.sha256(f"{seed}|{key}".encode("utf-8")).hexdigest()


def quotas(available: dict[str, int], total: int) -> dict[str, int]:
    """Split `total` as evenly as possible across tiles (tile order), giving any shortfall to the others."""
    ids = list(available)
    quota = {t: 0 for t in ids}
    left = min(total, sum(available.values()))
    while left > 0:
        open_ids = [t for t in ids if quota[t] < available[t]]
        share, extra = divmod(left, len(open_ids))
        for i, t in enumerate(open_ids):
            add = min(share + (1 if i < extra else 0), available[t] - quota[t])
            quota[t] += add
            left -= add
    return quota


# ------------------------------------------------------------------------------------------------ writers
def dump(obj) -> str:
    return json.dumps(obj, ensure_ascii=False, indent=2, allow_nan=False) + "\n"


def dump_collection(head: dict, features: list[dict]) -> str:
    """GeoJSON FeatureCollection with one feature per line (same layout as contracts/fixtures)."""
    lines = ",\n".join(json.dumps(f, ensure_ascii=False, separators=(",", ":"), allow_nan=False) for f in features)
    head_s = json.dumps(head, ensure_ascii=False, separators=(",", ":"), allow_nan=False)[:-1]
    return head_s + ',"features":[\n' + lines + "\n]}\n"


def write_text(path: pathlib.Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="\n") as f:
        f.write(text)
