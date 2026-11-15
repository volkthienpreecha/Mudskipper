#!/usr/bin/env python3
"""district_check.json (CONTRACTS.md B3.7): government 2026 DSR figures next to the tiles' DSR signal.

    uv run --project geo python geo/district_check.py [--run-dir artifacts/r01] [--out FILE]

Reads <run>/fields.geojson and <run>/field_summary.jsonl (written by publish/core, so this runs after
publish). Per district: `tile_rice_ha` = Σ area_ha of the district's fields, `tile_dsr_signal_ha` = Σ area_ha of
those whose `dsr.signal` is `dsr_signal`, `tile_dsr_signal_frac` = their ratio (INFERRED). `gov_dsr_acres` and
`gov_farmers` are the Kharif 2026 figures reported by DT Next / PTI (ASSUMED, cited in `source_urls`). A district
with no tile (Ferozepur) has null tile values. Run on contracts/fixtures/run it reproduces the committed
fixture file exactly (geo/tests/test_district_check.py).
"""
from __future__ import annotations

import argparse
import json
import pathlib

import common as c

DTNEXT = "https://www.dtnext.in/news/business/punjab-dsr-area-rises-36-to-over-4-lakh-acres-in-kharif-2026-minister"
GOV_DSR = [  # DT Next / PTI, 19 Jul 2026: "final validated" Kharif 2026 DSR area and farmers by district
    {"district": "Fazilka", "gov_dsr_acres": 155422.77, "gov_farmers": 12063},
    {"district": "Sri Muktsar Sahib", "gov_dsr_acres": 106038.81, "gov_farmers": 7345},
    {"district": "Ferozepur", "gov_dsr_acres": 38088.59, "gov_farmers": 1929},
]
NOTE_TAIL = ("Government figures are the Kharif 2026 DSR totals reported by PTI/DT Next. A 15 x 15 km tile is not a "
             "district, so compare shares, not acres. DSR is a signal, not proof.")
NOTE_FIXTURE = "SAMPLE: tile values come from fixture fields, not from NISAR. " + NOTE_TAIL
NOTE_REAL = ("Tile values are inferred from NISAR radar looks at the mapped rice fields of one 15 x 15 km tile per "
             "district (at most 5,000 fields in all, so not every rice field in the tile). " + NOTE_TAIL)


def build(fields_doc: dict, summaries: dict[str, dict]) -> dict:
    props = [f["properties"] for f in fields_doc["features"]]
    missing = [p["field_id"] for p in props if p["field_id"] not in summaries]
    if missing:
        raise SystemExit(f"field_summary.jsonl has no line for {len(missing)} fields, e.g. {missing[:3]}")
    fixture = bool(fields_doc.get("fixture", False))
    rows = []
    for g in GOV_DSR:
        mine = [p for p in props if p["district"] == g["district"]]
        if mine:
            rice = sum(p["area_ha"] for p in mine)
            dsr = sum(p["area_ha"] for p in mine if summaries[p["field_id"]]["dsr"]["signal"] == "dsr_signal")
            rows.append({**g, "tile_rice_ha": round(rice, 2), "tile_dsr_signal_ha": round(dsr, 2),
                         "tile_dsr_signal_frac": round(dsr / rice, 4)})
        else:
            rows.append({**g, "tile_rice_ha": None, "tile_dsr_signal_ha": None, "tile_dsr_signal_frac": None})
    known = {g["district"] for g in GOV_DSR}
    extra = sorted({p["district"] for p in props} - known)
    if extra:
        raise SystemExit(f"no 2026 government figures for districts {extra}; add them with a source URL")
    head = {"v": 1, "run_id": fields_doc["run_id"]}
    if fixture:
        head["fixture"] = True
    return {**head, "year": 2026, "rows": rows, "note": NOTE_FIXTURE if fixture else NOTE_REAL,
            "source_urls": [DTNEXT]}


def load(run: pathlib.Path) -> tuple[dict, dict]:
    fields_doc = json.loads((run / "fields.geojson").read_text(encoding="utf-8"))
    path = run / "field_summary.jsonl"
    if not path.exists():
        raise SystemExit(f"{path} is missing: district_check needs the published field summaries (make publish)")
    summaries = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        s = json.loads(line)
        summaries[s["field_id"]] = s
    return fields_doc, summaries


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--run-id", default=c.RUN_ID_DEFAULT)
    ap.add_argument("--run-dir", help="default $MUDSKIPPER_RUN_DIR or <repo>/artifacts/<run_id>")
    ap.add_argument("--out", help="default <run>/district_check.json")
    args = ap.parse_args(argv)
    run = c.run_dir(args.run_dir, args.run_id)
    doc = build(*load(run))
    out = pathlib.Path(args.out) if args.out else run / "district_check.json"
    c.write_text(out, c.dump(doc))
    for r in doc["rows"]:
        print(f"{r['district']}: tile rice {r['tile_rice_ha']} ha, DSR signal {r['tile_dsr_signal_ha']} ha "
              f"({r['tile_dsr_signal_frac']}); gov {r['gov_dsr_acres']} acres, {r['gov_farmers']} farmers")
    print(f"wrote {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
