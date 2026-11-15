#!/usr/bin/env python3
"""Protomaps basemap extract for both tiles: data/basemap/punjab.pmtiles (optional R2 object, SPEC B5).

    uv run --project geo python geo/basemap.py [--data-dir data] [--build 20261114] [--margin 0.05]

Uses the go-pmtiles CLI (`pmtiles extract`): from PATH, else data/bin/pmtiles, else it downloads the pinned
release (GO_PMTILES_VERSION) for this OS and CPU into data/bin. The source is a daily Protomaps planet build
(https://build.protomaps.com/<YYYYMMDD>.pmtiles; builds are kept about a week, so the newest one listed in
builds.json is used unless --build is given). Only the tiles inside the bbox (both tiles + margin) up to zoom 15
are read with HTTP range requests. Basemap data: © OpenStreetMap contributors, ODbL; schema and build by
Protomaps. The app must show ATTRIBUTION wherever the basemap is drawn.
"""
from __future__ import annotations

import argparse
import io
import json
import pathlib
import platform
import shutil
import stat
import subprocess
import tarfile
import urllib.request
import zipfile

import common as c

GO_PMTILES_VERSION = "1.31.2"
BUILDS_JSON = "https://build-metadata.protomaps.dev/builds.json"
BUILD_URL = "https://build.protomaps.com/{key}"
MAXZOOM = 15
ATTRIBUTION = ('<a href="https://protomaps.com">Protomaps</a> © '
               '<a href="https://openstreetmap.org/copyright">OpenStreetMap</a>')


def _get(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": "mudskipper-geo/0.1"})
    with urllib.request.urlopen(req, timeout=300) as r:
        return r.read()


def pmtiles_bin(ddir: pathlib.Path) -> str:
    found = shutil.which("pmtiles")
    if found:
        return found
    local = ddir / "bin" / "pmtiles"
    if local.exists():
        return str(local)
    system = {"Darwin": "Darwin", "Linux": "Linux"}.get(platform.system())
    arch = {"arm64": "arm64", "aarch64": "arm64", "x86_64": "x86_64", "AMD64": "x86_64"}.get(platform.machine())
    if not (system and arch):
        raise SystemExit(f"no go-pmtiles build for {platform.system()} {platform.machine()}; install pmtiles yourself")
    v = GO_PMTILES_VERSION
    name = f"go-pmtiles-{v}_{system}_{arch}.zip" if system == "Darwin" else f"go-pmtiles_{v}_{system}_{arch}.tar.gz"
    url = f"https://github.com/protomaps/go-pmtiles/releases/download/v{v}/{name}"
    c.log(f"downloading {url}")
    blob = _get(url)
    local.parent.mkdir(parents=True, exist_ok=True)
    if name.endswith(".zip"):
        with zipfile.ZipFile(io.BytesIO(blob)) as z:
            local.write_bytes(z.read("pmtiles"))
    else:
        with tarfile.open(fileobj=io.BytesIO(blob), mode="r:gz") as t:
            local.write_bytes(t.extractfile("pmtiles").read())
    local.chmod(local.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    return str(local)


def latest_build() -> str:
    builds = json.loads(_get(BUILDS_JSON))
    return sorted(b["key"] for b in builds if b["key"].endswith(".pmtiles"))[-1]


def extract_bbox(tiles: list[c.Tile], margin: float) -> list[float]:
    b = [min(t.bbox[0] for t in tiles), min(t.bbox[1] for t in tiles),
         max(t.bbox[2] for t in tiles), max(t.bbox[3] for t in tiles)]
    return [round(b[0] - margin, 3), round(b[1] - margin, 3), round(b[2] + margin, 3), round(b[3] + margin, 3)]


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--data-dir", help="default $MUDSKIPPER_DATA_DIR or <repo>/data")
    ap.add_argument("--tiles", default=str(c.GEO_DIR / "tiles.json"))
    ap.add_argument("--build", help="Protomaps build date YYYYMMDD (default: newest in builds.json)")
    ap.add_argument("--margin", type=float, default=0.05, help="degrees added on every side (default 0.05)")
    ap.add_argument("--out", help="default <data>/basemap/punjab.pmtiles")
    args = ap.parse_args(argv)

    ddir = c.data_dir(args.data_dir)
    exe = pmtiles_bin(ddir)
    key = f"{args.build}.pmtiles" if args.build else latest_build()
    bbox = extract_bbox(c.load_tiles(pathlib.Path(args.tiles)), args.margin)
    out = pathlib.Path(args.out) if args.out else ddir / "basemap" / "punjab.pmtiles"
    out.parent.mkdir(parents=True, exist_ok=True)
    src = BUILD_URL.format(key=key)
    cmd = [exe, "extract", src, str(out), f"--bbox={','.join(str(v) for v in bbox)}", f"--maxzoom={MAXZOOM}"]
    c.log("running: " + " ".join(cmd))
    subprocess.run(cmd, check=True)
    subprocess.run([exe, "verify", str(out)], check=True)
    meta = {"source": src, "bbox": bbox, "maxzoom": MAXZOOM, "bytes": out.stat().st_size,
            "license": "ODbL-1.0 (OpenStreetMap data)", "attribution": ATTRIBUTION}
    c.write_text(out.with_suffix(".json"), c.dump(meta))
    print(f"wrote {out}: {out.stat().st_size / 1e6:.2f} MB from {src}, bbox {bbox}, z0-{MAXZOOM}")
    print(f"attribution (ODbL): {ATTRIBUTION}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
