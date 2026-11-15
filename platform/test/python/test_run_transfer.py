"""run_transfer.py: share/fetch round trip with the GitHub CLI replaced by a local fake (no network)."""
import importlib.util
import json
import pathlib
import shutil
import sys
import tempfile
import unittest
import zipfile

HERE = pathlib.Path(__file__).resolve()
SPEC = importlib.util.spec_from_file_location("run_transfer", HERE.parents[2] / "scripts" / "run_transfer.py")
rt = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(rt)


class FakeGh:
    """Stores release assets in a temp dir, answering the few gh subcommands run_transfer uses."""

    def __init__(self, root):
        self.root = pathlib.Path(root)

    def __call__(self, *args, capture=True):
        cmd = args[:2]
        tag = args[2] if len(args) > 2 else None
        rel = self.root / (tag or "")
        if cmd == ("release", "view"):
            if not rel.is_dir():
                raise RuntimeError("release not found")
            return ""
        if cmd in (("release", "create"), ("release", "upload")):
            rel.mkdir(parents=True, exist_ok=True)
            shutil.copy(args[3], rel / pathlib.Path(args[3]).name)
            return ""
        if cmd == ("release", "edit"):
            return ""
        if cmd == ("release", "download"):
            pattern = args[args.index("--pattern") + 1]
            dest = pathlib.Path(args[args.index("--dir") + 1])
            shutil.copy(rel / pattern, dest / pattern)
            return ""
        if cmd == ("release", "list"):
            return json.dumps([{"tagName": p.name, "name": p.name, "publishedAt": "2026-11-15T00:00:00Z"}
                               for p in sorted(self.root.iterdir())])
        raise AssertionError(args)


class RunTransferTests(unittest.TestCase):
    def setUp(self):
        self.tmp = pathlib.Path(tempfile.mkdtemp())
        self.store = self.tmp / "releases"
        self.store.mkdir()
        self._gh = rt.gh
        rt.gh = FakeGh(self.store)
        self.src = self.tmp / "src"
        (self.src / "overlays").mkdir(parents=True)
        (self.src / "aoi.json").write_text('{"v":1}\n')
        (self.src / "overlays" / "a.png").write_bytes(b"\x89PNG fake")

    def tearDown(self):
        rt.gh = self._gh
        shutil.rmtree(self.tmp)

    def test_round_trip_and_replace(self):
        rt.share("r01", self.src, "r01", do_validate=False)
        dest = self.tmp / "dest"
        rt.fetch("r01", dest, force=False)
        self.assertEqual((dest / "overlays" / "a.png").read_bytes(), b"\x89PNG fake")
        self.assertFalse((dest / rt.MANIFEST).exists())
        with self.assertRaises(SystemExit):
            rt.fetch("r01", dest, force=False)  # refuses to overwrite
        (self.src / "aoi.json").write_text('{"v":1,"x":2}\n')
        rt.share("r01", self.src, "r01", do_validate=False)  # re-share replaces the asset
        rt.fetch("r01", dest, force=True)
        self.assertIn('"x":2', (dest / "aoi.json").read_text())

    def test_checksum_mismatch_and_unsafe_paths_rejected(self):
        rt.share("r01", self.src, "r01", do_validate=False)
        z = self.store / "data-r01" / "r01.zip"
        with zipfile.ZipFile(z, "a") as zf:
            zf.writestr("extra.txt", "not in manifest")
        with self.assertRaises(SystemExit):
            rt.fetch("r01", self.tmp / "d1", force=False)
        evil = self.store / "data-evil"
        evil.mkdir()
        with zipfile.ZipFile(evil / "evil.zip", "w") as zf:
            zf.writestr("../escape.txt", "x")
            zf.writestr(rt.MANIFEST, json.dumps({"files": {}}))
        with self.assertRaises(SystemExit):
            rt.fetch("evil", self.tmp / "d2", force=False)
        self.assertFalse((self.tmp / "escape.txt").exists())

    def test_names_are_checked(self):
        with self.assertRaises(SystemExit):
            rt.main(["share", "../r01"])
        with self.assertRaises(SystemExit):
            rt.main(["fetch", "R01"])


if __name__ == "__main__":
    unittest.main()
