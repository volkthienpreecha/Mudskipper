"""basemap.py runs a downloaded go-pmtiles binary only when its archive matches the pinned SHA-256 (K-346)."""
import hashlib

import pytest

import basemap


def test_every_pinned_name_matches_the_pinned_version():
    assert basemap.GO_PMTILES_SHA256, "pins are required"
    for name, digest in basemap.GO_PMTILES_SHA256.items():
        assert basemap.GO_PMTILES_VERSION in name
        assert len(digest) == 64 and int(digest, 16) >= 0


def test_a_tampered_archive_is_refused(monkeypatch):
    name = "go-pmtiles_1.31.2_Linux_x86_64.tar.gz"
    with pytest.raises(SystemExit, match="does not match the pinned"):
        basemap.verified_release(name, b"not the release")


def test_an_unpinned_archive_is_refused():
    with pytest.raises(SystemExit, match="no pinned sha256"):
        basemap.verified_release("go-pmtiles_9.9.9_Plan9_mips.tar.gz", b"x")


def test_the_pinned_bytes_pass(monkeypatch):
    blob = b"pretend release"
    monkeypatch.setitem(basemap.GO_PMTILES_SHA256, "fake.zip", hashlib.sha256(blob).hexdigest())
    assert basemap.verified_release("fake.zip", blob) == blob


def test_pmtiles_bin_checks_the_download_before_unpacking(tmp_path, monkeypatch):
    monkeypatch.setattr(basemap.shutil, "which", lambda _: None)
    monkeypatch.setattr(basemap.platform, "system", lambda: "Linux")
    monkeypatch.setattr(basemap.platform, "machine", lambda: "x86_64")
    monkeypatch.setattr(basemap, "_get", lambda url: b"tampered")
    with pytest.raises(SystemExit, match="does not match the pinned"):
        basemap.pmtiles_bin(tmp_path)
    assert not (tmp_path / "bin" / "pmtiles").exists()
