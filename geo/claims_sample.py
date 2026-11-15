#!/usr/bin/env python3
"""claims.sample.geojson (CONTRACTS.md B3.12): exactly 60 SYNTHETIC program claims on a run's real field ids.

    uv run --project geo python geo/claims_sample.py [--run-dir artifacts/r01] [--out FILE] [--seed N]

The sample is what the Scarecrow screen ranks before anyone uploads a file, so it exercises every path of the
ranking (CONTRACTS.md B6): 53 claims on distinct fields (about a third carry the field's polygon, the rest a
point at its label point; about half also carry a `field_id` hint), 1 second claim on an already-claimed field
(candidate merging), and 6 points that match no field (3 with a claimed `area_ha`, 3 without). Claimed practices
are AWD, DSR or both. Claims are shuffled and numbered `SYN-0001…`.

Nothing here describes a person: no names, no ids, no plot numbers. Every claim has `synthetic: true`.
Deterministic: mulberry32 seeded from (seed, "claims") as in contracts/rules.py, so a rerun on the same fields
gives byte-identical output.
"""
from __future__ import annotations

import argparse
import json
import pathlib

import common as c
from common import rules

N_FIELD_CLAIMS, N_UNMATCHED = 53, 6


def _field_boxes(features: list[dict]) -> list[tuple]:
    boxes = []
    for f in features:
        pts = [pt for poly in rules._rings_of(f["geometry"]) for ring in poly for pt in ring]
        xs, ys = [pt[0] for pt in pts], [pt[1] for pt in pts]
        boxes.append((min(xs), min(ys), max(xs), max(ys), f))
    return boxes


def _unmatched_point(rng, tiles: list[dict], boxes: list[tuple], i: int) -> list[float]:
    """A point inside tile i % n that lies in no field (rejection sampling, the contract's containment test)."""
    t = tiles[i % len(tiles)]
    minx, miny, maxx, maxy = t["bbox"]
    for _ in range(10_000):
        lon = round(minx + (0.05 + 0.9 * rng()) * (maxx - minx), 7)
        lat = round(miny + (0.05 + 0.9 * rng()) * (maxy - miny), 7)
        if not any(b[0] <= lon <= b[2] and b[1] <= lat <= b[3] and rules.contains(b[4]["geometry"], lon, lat)
                   for b in boxes):
            return [lon, lat]
    raise SystemExit("could not find a point outside every field")


def build(fields_doc: dict, aoi: dict, seed: int = c.SEED) -> dict:
    features = fields_doc["features"]
    if len(features) < N_FIELD_CLAIMS:
        raise SystemExit(f"need at least {N_FIELD_CLAIMS} fields, the run has {len(features)}")
    rng = rules.Mulberry32(rules.derive(seed, "claims"))
    pool = sorted(features, key=lambda f: f["properties"]["field_id"])
    for i in range(len(pool) - 1, 0, -1):  # seeded Fisher-Yates
        j = int(rng() * (i + 1))
        pool[i], pool[j] = pool[j], pool[i]
    chosen = pool[:N_FIELD_CLAIMS]

    def claimed():
        r = rng()
        return ["awd"] if r < 0.5 else (["dsr"] if r < 0.7 else ["awd", "dsr"])

    claims = []
    for f in chosen:
        p = f["properties"]
        geom = f["geometry"] if rng() < 1 / 3 else {"type": "Point", "coordinates": [p["lon"], p["lat"]]}
        props = {"claimed": claimed(), "synthetic": True}
        if rng() < 0.5:
            props["field_id"] = p["field_id"]
        claims.append({"type": "Feature", "geometry": geom, "properties": props})
    dup = chosen[0]["properties"]  # a second claim on the same field: exercises candidate merging
    claims.append({"type": "Feature", "geometry": {"type": "Point", "coordinates": [dup["lon"], dup["lat"]]},
                   "properties": {"claimed": ["dsr"] if "dsr" not in claims[0]["properties"]["claimed"] else ["awd"],
                                  "synthetic": True}})
    boxes = _field_boxes(features)
    for i in range(N_UNMATCHED):  # points outside every mapped field, half with a claimed area
        props = {"claimed": claimed(), "synthetic": True}
        if i % 2 == 0:
            props["area_ha"] = round(1 + rng() * 3, 2)
        claims.append({"type": "Feature", "geometry": {"type": "Point",
                                                       "coordinates": _unmatched_point(rng, aoi["tiles"], boxes, i)},
                       "properties": props})
    for i in range(len(claims) - 1, 0, -1):
        j = int(rng() * (i + 1))
        claims[i], claims[j] = claims[j], claims[i]
    for i, cl in enumerate(claims, start=1):
        cl["properties"] = {"claim_id": f"SYN-{i:04d}", **cl["properties"]}
    assert len(claims) == N_FIELD_CLAIMS + 1 + N_UNMATCHED == 60
    head = {"v": 1, "run_id": fields_doc["run_id"]}
    if fields_doc.get("fixture"):
        head["fixture"] = True
    return {**head, "type": "FeatureCollection", "features": claims}


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--run-id", default=c.RUN_ID_DEFAULT)
    ap.add_argument("--run-dir", help="default $MUDSKIPPER_RUN_DIR or <repo>/artifacts/<run_id>")
    ap.add_argument("--out", help="default <run>/claims.sample.geojson")
    ap.add_argument("--seed", type=int, default=c.SEED)
    args = ap.parse_args(argv)
    run = c.run_dir(args.run_dir, args.run_id)
    fields_doc = json.loads((run / "fields.geojson").read_text(encoding="utf-8"))
    aoi = json.loads((run / "aoi.json").read_text(encoding="utf-8"))
    doc = build(fields_doc, aoi, args.seed)
    out = pathlib.Path(args.out) if args.out else run / "claims.sample.geojson"
    head = {k: v for k, v in doc.items() if k != "features"}
    c.write_text(out, c.dump_collection(head, doc["features"]))
    kinds = {}
    for f in doc["features"]:
        k = f["geometry"]["type"] + ("+hint" if "field_id" in f["properties"] else "")
        kinds[k] = kinds.get(k, 0) + 1
    print(f"wrote {out}: {len(doc['features'])} SYNTHETIC claims {dict(sorted(kinds.items()))}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
