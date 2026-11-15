"""Write a run's geo outputs: aoi.json, fields.geojson and fields.pmtiles (CONTRACTS.md B3.1, B3.3)."""
from __future__ import annotations

import pathlib
import shutil
import tempfile

import geopandas as gpd
import pyogrio
import shapely

import common as c

PMTILES_MAGIC = b"PMTiles\x03"
PMTILES_MINZOOM, PMTILES_MAXZOOM = 8, 16
PMTILES_PROPS = ["field_id", "tile", "district", "area_ha", "source", "rice_mask_frac"]


def aoi_doc(run_id: str, tiles: list[c.Tile]) -> dict:
    return {"v": 1, "run_id": run_id,
            "tiles": [{"id": t.id, "district": t.district, "bbox": t.bbox} for t in tiles],
            "utm_epsg": c.UTM_EPSG,
            "season": dict(c.SEASON),
            "stages": dict(c.STAGES),
            "gaps": [dict(c.NISAR_GAP)]}


def feature(field_id: str, tile: c.Tile, geom_ll, rice_frac: float, source: str) -> dict:
    """One fields.geojson feature; `geom_ll` must already be rounded (common.round_geom)."""
    gj = c.geometry_json(geom_ll)
    lon, lat = c.label_point(gj, geom_ll)
    return {"type": "Feature", "geometry": gj,
            "properties": {"field_id": field_id, "tile": tile.id, "district": tile.district,
                           "area_ha": round(c.area_ha_utm(geom_ll), 4), "source": source,
                           "rice_mask_frac": round(float(rice_frac), 4), "lon": lon, "lat": lat}}


def fields_text(run_id: str, features: list[dict]) -> str:
    return c.dump_collection({"v": 1, "run_id": run_id, "type": "FeatureCollection"}, features)


def write_pmtiles(features: list[dict], out: pathlib.Path) -> None:
    """GDAL's PMTiles writer (bundled with pyogrio): one layer `fields`, zoom 8-16."""
    gdf = gpd.GeoDataFrame([f["properties"] for f in features],
                           geometry=[shapely.geometry.shape(f["geometry"]) for f in features], crs="EPSG:4326")
    gdf = gdf[PMTILES_PROPS + ["geometry"]]
    out.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="mudskipper-pmtiles-") as tmp:
        tmp_out = pathlib.Path(tmp) / "fields.pmtiles"
        pyogrio.write_dataframe(gdf, tmp_out, layer="fields", driver="PMTiles",
                                dataset_options={"MINZOOM": str(PMTILES_MINZOOM), "MAXZOOM": str(PMTILES_MAXZOOM),
                                                 "NAME": "fields",
                                                 "DESCRIPTION": "Mudskipper rice fields (CONTRACTS.md B3.3)"},
                                layer_options={"MINZOOM": str(PMTILES_MINZOOM), "MAXZOOM": str(PMTILES_MAXZOOM)})
        shutil.move(str(tmp_out), out)


def verify_pmtiles(path: pathlib.Path, expected_ids: set[str]) -> dict:
    """Open the archive again and check the magic bytes, the layer and every field id at the max zoom."""
    with path.open("rb") as f:
        magic = f.read(8)
    if magic != PMTILES_MAGIC:
        raise SystemExit(f"{path}: not a PMTiles v3 archive (magic {magic!r})")
    layers = [str(n) for n, _ in pyogrio.list_layers(path)]
    if layers != ["fields"]:
        raise SystemExit(f"{path}: layers {layers}, expected ['fields']")
    found = {}
    for z in (PMTILES_MINZOOM, PMTILES_MAXZOOM):
        df = pyogrio.read_dataframe(path, layer="fields", columns=["field_id"], read_geometry=False,
                                    ZOOM_LEVEL=str(z))
        found[z] = set(df["field_id"])
    if found[PMTILES_MAXZOOM] != expected_ids:
        missing = sorted(expected_ids - found[PMTILES_MAXZOOM])[:5]
        raise SystemExit(f"{path}: z{PMTILES_MAXZOOM} has {len(found[PMTILES_MAXZOOM])} distinct fields, "
                         f"expected {len(expected_ids)} (missing e.g. {missing})")
    return {"bytes": path.stat().st_size, "layer": "fields",
            f"fields_z{PMTILES_MAXZOOM}": len(found[PMTILES_MAXZOOM]),
            f"fields_z{PMTILES_MINZOOM}": len(found[PMTILES_MINZOOM])}


def write_run(run: pathlib.Path, run_id: str, tiles: list[c.Tile], features: list[dict],
              pmtiles: bool = True, write_aoi: bool = True) -> dict:
    run.mkdir(parents=True, exist_ok=True)
    if write_aoi:
        c.write_text(run / "aoi.json", c.dump(aoi_doc(run_id, tiles)))
    c.write_text(run / "fields.geojson", fields_text(run_id, features))
    info = {"fields": len(features), "geojson_bytes": (run / "fields.geojson").stat().st_size}
    if pmtiles:
        write_pmtiles(features, run / "fields.pmtiles")
        info["pmtiles"] = verify_pmtiles(run / "fields.pmtiles", {f["properties"]["field_id"] for f in features})
    return info


def spatial_order_key(tile: c.Tile, lon: float, lat: float, key: str, band_m: float = 500.0):
    """Ids run north to south in 500 m bands, west to east inside a band (like reading a map), ties by key."""
    x, y = c.TO_UTM.transform(lon, lat)
    band = int((tile.y0 + tile.size - y) // band_m)
    return (band, round(x, 3), -round(y, 3), key)
