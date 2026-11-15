# geo/ — where the radar looks

**Owner:** Karthik · **Language:** Python 3.12 via [uv](https://docs.astral.sh/uv/) · **Prompt:** [SPEC Lane Karthik](../docs/SPEC.md#lane-karthik-backend--connectivity-platform-core-geo) steps 1, 3, 6

`#fields-of-the-world` `#globalrice20` `#nisar` `#pmtiles` `#duckdb` `#shapely`

The radar pipeline needs to know *which* patches of Punjab to measure. This lane picks two 15 × 15 km tiles
that are as rice-dense as their districts allow, cuts them into rice fields, and hands the pipeline a
`fields.geojson` it can run zonal statistics on. It also writes the district table and the synthetic claims the
Scarecrow screen ranks. Nothing here is a guess: every tile, field and share comes from an open, cited dataset,
and every rerun is byte-identical.

```
 ASF footprints ─┐                     GlobalRice20 (20 m) ─┐
 geoBoundaries ──┼─ tiles.py ─ tiles.json ─┬─ grid.py ───────┼─▶ aoi.json + fields.geojson + fields.pmtiles
 rice masks ─────┘                         └─ fields.py ─────┘      (artifacts/<run>/, source "grid" → "ftw")
                                              ▲ FTW global 2024 (DuckDB) or ftw-tools (local)
 fields.geojson + field_summary.jsonl ─ district_check.py ─▶ district_check.json
 fields.geojson ─ claims_sample.py ─▶ claims.sample.geojson (60 SYNTHETIC)
 tiles.json ─ basemap.py ─▶ data/basemap/punjab.pmtiles (Protomaps / OSM)
```

## Scripts

| Script | Writes (contract) | What it does |
|---|---|---|
| `tiles.py` | `geo/tiles.json` (committed) | Slides a 15 km window (500 m steps, origins on 20 m) over each district; keeps windows ≥ 250 m inside the district and ≥ 2 km inside every GCOV footprint of D135 F73 **and** A84 F17; picks the highest GlobalRice20 share among windows Zhao also calls rice-majority. |
| `grid.py` | `aoi.json` (B3.1), `fields.geojson` + `fields.pmtiles` (B3.3, `source: grid`) | The H+0:45 hand-off: 100 m cells (1 ha, 5 × 5 NISAR pixels at 20 m) with rice share ≥ 0.5, capped at 5,000. |
| `fields.py` | `fields.geojson` + `fields.pmtiles` (B3.3, `source: ftw`) | The H+3 hand-off: FTW polygons → clip to the tile → snap to 1e-7° → ≥ 0.5 ha (UTM) → rice share ≥ 0.5 → seeded cap → ids in reading order → label point inside the polygon. Prints how many polygons each step removes. |
| `district_check.py` | `district_check.json` (B3.7) | Sums the run's field areas and DSR-signal areas per district next to the 2026 government DSR figures. Reproduces the fixture file byte for byte. |
| `claims_sample.py` | `claims.sample.geojson` (B3.12) | 60 SYNTHETIC claims: 53 on distinct fields (points and polygons, half with a `field_id` hint), 1 duplicate-field claim, 6 unmatched points (3 with `area_ha`). No person data. |
| `basemap.py` | `data/basemap/punjab.pmtiles` | `pmtiles extract` of the newest Protomaps build for both tiles + 0.05°, z0–15; downloads go-pmtiles 1.31.2 if it is not installed. |
| `common.py`, `rice.py`, `output.py` | | Shared constants and writers, the exact area-weighted rice fraction, and the GeoJSON / PMTiles writer with its read-back check. |

## Commands

From the repository root (`make help` lists everything):

```sh
make geo-setup                 # uv sync --frozen (geo/.venv)
make geo-test                  # 50 offline tests on synthetic rasters and polygons
make tiles                     # re-choose the tiles (network) -> geo/tiles.json
make grid                      # aoi.json + grid fields into artifacts/$(RUN_ID)
make fields                    # FTW global -> fields.geojson + fields.pmtiles (replaces the grid)
make geo-ftw-setup && make fields FTW_METHOD=ftw-local   # run the FTW model yourself (~5 min/tile, CPU)
make district                  # after publish: needs field_summary.jsonl
make claims CLAIMS_OUT=data/geo/r01/claims.sample.geojson
make basemap
python3 contracts/validate.py artifacts/r01 --stage geo   # check the hand-off before the pipeline runs
```

Variables: `RUN_ID` (default `r01`), `RUN_DIR` (default `artifacts/$(RUN_ID)`), `DATA_DIR` (default `data/`; the
scripts also read `$MUDSKIPPER_DATA_DIR` and `$MUDSKIPPER_RUN_DIR`). Downloads are cached once under
`data/geo/` and checked against their published md5 where the source publishes one.

## Data sources

| Dataset | Used for | License |
|---|---|---|
| [GlobalRice20](https://doi.org/10.5281/zenodo.18168302) 2024, 20 m (Zhang et al. 2026), tile `2024_Lat0_Lon45` | tile score, `rice_mask_frac` | CC-BY-4.0 |
| [Zhao et al.](https://doi.org/10.5281/zenodo.21349862) paddy rice 2024, 30 m, India North | cross-check | CC-BY-4.0 |
| [Fields of The World](https://source.coop/ftw/global-data-2e) global data, 2nd edition, 2024 | field polygons | CC-BY-4.0 |
| [ftw-tools](https://github.com/fieldsoftheworld/ftw-baselines) 2.0.0b5 + `FTW_PRUE_EFNET_B5_CCBY` | optional local polygons | MIT / CC-BY-4.0 |
| [geoBoundaries](https://www.geoboundaries.org) gbOpen IND ADM2 (2021) | keep each tile inside its district | ODbL-1.0 |
| [ASF Search API](https://api.daac.asf.alaska.edu/services/search/param) NISAR GCOV footprints | keep both tiles inside one frame | NASA open data |
| [DT Next / PTI](https://www.dtnext.in/news/business/punjab-dsr-area-rises-36-to-over-4-lakh-acres-in-kharif-2026-minister), 19 Jul 2026 | government DSR acres and farmers | cited (ASSUMED) |
| [Protomaps](https://protomaps.com) build of [OpenStreetMap](https://openstreetmap.org/copyright) | optional basemap | ODbL-1.0 |

## The real run (r01)

| | Fazilka | Sri Muktsar Sahib |
|---|---|---|
| UTM origin (EPSG:32643) | 432500, 3389500 | 445500, 3345500 |
| bbox (lon/lat) | 74.294626, 30.636233, 74.452135, 30.772336 | 74.432785, 30.23986, 74.589461, 30.375802 |
| rice share, GlobalRice20 / Zhao | 0.564 / 0.806 | 0.618 / 0.710 |
| fixture tile, same masks | 0.184 / 0.296 | 0.466 / 0.673 |
| grid cells with rice ≥ 0.5 (of 22,500) | 13,160 | 14,557 |
| FTW polygons in the bbox | 5,178 | 10,618 |
| − outside the 15 km square | 77 | 106 |
| − smaller than 0.5 ha | 3,626 | 6,336 |
| − rice share below 0.5 | 379 | 673 |
| − cap | 0 | 0 |
| **fields kept** | **1,096** (1,513.8 ha) | **3,503** (4,137.3 ha) |

Outputs: `fields.geojson` 3.8 MB and `fields.pmtiles` 3.2 MB (4,599 fields, layer `fields`, z8–16; read back at
both zooms with every field id), `aoi.json` 0.7 kB. Grid version: 5,000 cells, 1.8 MB / 1.5 MB. Basemap: 3.6 MB.

Read these numbers with two caveats. A typical Punjab field is about 0.3–0.4 ha, so the contract's 0.5 ha minimum
removes 60–70% of the polygons and the kept fields are the larger ones. And FTW's polygons are model predictions,
not surveyed parcels: the kept fields cover about 12% (Fazilka) and 30% (Muktsar) of each tile's mapped rice.
Running the FTW model locally on the Fazilka tile found 20,578 polygons and 1,832 kept fields, so the local path
is the lever if we need more fields. Details and reasoning: [DECISIONS.md](../DECISIONS.md) K-101 to K-113.

## Determinism

No wall clock, no unseeded randomness: the cap and the claims use seed 20261114 through sha256 ranks and
mulberry32 (the contract's PRNG). Coordinates are snapped to 1e-7° with GEOS `set_precision`, rings follow RFC
7946 (exterior counter-clockwise), and features are written one per line in schema key order. Rerunning
`make grid` or `make fields` on the same inputs gives byte-identical GeoJSON and PMTiles.
