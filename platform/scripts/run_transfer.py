#!/usr/bin/env python3
"""Move a run directory between teammates through GitHub Release assets (data never enters git history).

    python platform/scripts/run_transfer.py share r01v1          # zip artifacts/r01v1 -> release "data-r01v1"
    python platform/scripts/run_transfer.py fetch r01v1          # download + unzip into artifacts/r01v1
    python platform/scripts/run_transfer.py share r01 --dir data/geo/r01-pipeline-tiles --name geo-pipeline-tiles
    python platform/scripts/run_transfer.py list                 # what is shared

Works on macOS, Linux and Windows: Python 3.10+ standard library plus the GitHub CLI (`gh auth login` once).
`share` validates the folder first (stage chosen automatically) when the repo venv or jsonschema is available,
writes a SHA-256 manifest into the zip, and replaces an existing asset of the same name. `fetch` verifies every
file against that manifest and refuses to overwrite a non-empty folder unless --force.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile
import zipfile

REPO = "volkthienpreecha/Mudskipper"
ROOT = pathlib.Path(__file__).resolve().parents[2]
NAME_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,47}$")
MANIFEST = "MANIFEST.sha256.json"


def gh(*args: str, capture: bool = True) -> str:
    exe = shutil.which("gh")
    if not exe:
        sys.exit("run_transfer: the GitHub CLI `gh` is not installed (https://cli.github.com), then run `gh auth login`.")
    res = subprocess.run([exe, *args], capture_output=capture, text=True)
    if res.returncode != 0:
        raise RuntimeError((res.stderr or res.stdout or "").strip())
    return res.stdout if capture else ""


def sha256(path: pathlib.Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def validate(folder: pathlib.Path) -> None:
    """Run contracts/validate.py on the folder with whatever Python has jsonschema (repo venv first)."""
    candidates = [ROOT / ".venv" / "bin" / "python", ROOT / ".venv" / "Scripts" / "python.exe", pathlib.Path(sys.executable)]
    for py in candidates:
        if py.exists():
            probe = subprocess.run([str(py), "-c", "import jsonschema"], capture_output=True)
            if probe.returncode == 0:
                res = subprocess.run([str(py), str(ROOT / "contracts" / "validate.py"), str(folder), "--quiet"])
                if res.returncode != 0:
                    sys.exit("run_transfer: validation failed; fix the run (or pass --no-validate to share it anyway).")
                return
    print("run_transfer: jsonschema not found (run `make setup`); sharing without validation", file=sys.stderr)


def share(run: str, folder: pathlib.Path, name: str, do_validate: bool) -> None:
    if not folder.is_dir() or not any(folder.iterdir()):
        sys.exit(f"run_transfer: {folder} is missing or empty")
    if do_validate:
        validate(folder)
    files = sorted(p for p in folder.rglob("*") if p.is_file())
    manifest = {"run": run, "name": name, "files": {p.relative_to(folder).as_posix(): sha256(p) for p in files}}
    tag = f"data-{name}"
    with tempfile.TemporaryDirectory() as tmp:
        zpath = pathlib.Path(tmp) / f"{name}.zip"
        with zipfile.ZipFile(zpath, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as z:
            for p in files:
                z.write(p, p.relative_to(folder).as_posix())
            z.writestr(MANIFEST, json.dumps(manifest, indent=2) + "\n")
        size_mb = zpath.stat().st_size / 1e6
        notes = (f"Run folder `{run}` shared from `{folder.relative_to(ROOT) if folder.is_relative_to(ROOT) else folder}` "
                 f"({len(files)} files, {size_mb:.1f} MB zipped). Fetch with "
                 f"`python platform/scripts/run_transfer.py fetch {name}`. Data only; never merged into git.")
        try:
            gh("release", "view", tag, "--repo", REPO)
            gh("release", "upload", tag, str(zpath), "--clobber", "--repo", REPO)
            gh("release", "edit", tag, "--notes", notes, "--repo", REPO)
        except RuntimeError as exc:
            if "release not found" not in str(exc).lower() and "not found" not in str(exc).lower():
                raise
            gh("release", "create", tag, str(zpath), "--prerelease", "--title", f"Run data: {name}", "--notes", notes,
               "--repo", REPO)
    print(f"shared {len(files)} files ({size_mb:.1f} MB) as release {tag}")


def fetch(name: str, dest: pathlib.Path, force: bool) -> None:
    if dest.exists() and any(dest.iterdir()) and not force:
        sys.exit(f"run_transfer: {dest} is not empty (use --force to replace it)")
    tag = f"data-{name}"
    with tempfile.TemporaryDirectory() as tmp:
        gh("release", "download", tag, "--pattern", f"{name}.zip", "--dir", tmp, "--repo", REPO)
        zpath = pathlib.Path(tmp) / f"{name}.zip"
        staging = pathlib.Path(tmp) / "unzipped"
        with zipfile.ZipFile(zpath) as z:
            for member in z.namelist():  # refuse absolute paths and parent traversal
                if member.startswith(("/", "\\")) or ".." in pathlib.PurePosixPath(member).parts:
                    sys.exit(f"run_transfer: unsafe path in zip: {member}")
            z.extractall(staging)
        manifest = json.loads((staging / MANIFEST).read_text(encoding="utf-8"))
        (staging / MANIFEST).unlink()
        got = {p.relative_to(staging).as_posix(): sha256(p) for p in staging.rglob("*") if p.is_file()}
        if got != manifest["files"]:
            missing = sorted(set(manifest["files"]) - set(got))
            bad = sorted(k for k in got if manifest["files"].get(k) != got[k])
            sys.exit(f"run_transfer: checksum mismatch (missing {missing[:5]}, changed {bad[:5]})")
        if dest.exists():
            shutil.rmtree(dest)
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(staging), str(dest))
    print(f"fetched {len(manifest['files'])} files into {dest} (checksums verified)")


def list_shared() -> None:
    out = gh("release", "list", "--repo", REPO, "--limit", "100", "--json", "tagName,name,publishedAt")
    rows = [r for r in json.loads(out) if r["tagName"].startswith("data-")]
    for r in rows:
        print(f"{r['tagName'][5:]:<28} {r['publishedAt'][:16]}  {r['name']}")
    if not rows:
        print("(nothing shared yet)")


def main(argv=None) -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("share", help="zip a run folder and upload it as a release asset")
    s.add_argument("run")
    s.add_argument("--dir", help="folder to share (default artifacts/<run>)")
    s.add_argument("--name", help="share name (default: the run id)")
    s.add_argument("--no-validate", action="store_true")
    f = sub.add_parser("fetch", help="download a shared run into artifacts/<run>")
    f.add_argument("name")
    f.add_argument("--dir", help="destination (default artifacts/<name>)")
    f.add_argument("--force", action="store_true")
    sub.add_parser("list", help="list shared runs")
    a = ap.parse_args(argv)
    if a.cmd == "list":
        return list_shared()
    if a.cmd == "share":
        name = a.name or a.run
        if not NAME_RE.match(a.run) or not NAME_RE.match(name):
            sys.exit("run_transfer: run and name must match ^[a-z0-9][a-z0-9_-]*$")
        folder = pathlib.Path(a.dir).resolve() if a.dir else ROOT / "artifacts" / a.run
        return share(a.run, folder, name, not a.no_validate)
    if not NAME_RE.match(a.name):
        sys.exit("run_transfer: name must match ^[a-z0-9][a-z0-9_-]*$")
    dest = pathlib.Path(a.dir).resolve() if a.dir else ROOT / "artifacts" / a.name
    return fetch(a.name, dest, a.force)


if __name__ == "__main__":
    main()
