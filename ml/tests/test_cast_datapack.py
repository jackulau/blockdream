"""Offline WM -> Minecraft datapack cast (scripts/cast_wm_to_datapack.py).

Two layers, mirroring the JS suite's `hasFfmpeg` describe.skip pattern
(packages/cli/test/e2e.test.ts):

1. fast, always-on unit tests of the preflight logic (shutil.which monkeypatched);
2. an environment-gated end-to-end smoke that only runs when ffmpeg, npx, AND the
   trained checkpoint are all present - it rolls a tiny 2-step dream and asserts a
   droppable .zip lands. Checkpoint load + rollout can take ~1-2 min on CPU.
"""

import shutil
import sys
from pathlib import Path

import pytest

ML = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ML / "scripts"))

import cast_wm_to_datapack  # noqa: E402

CHECKPOINT = ML / "runs" / "skills_real" / "latest.pt"

_has_ffmpeg = shutil.which("ffmpeg") is not None
_has_npx = shutil.which("npx") is not None
_has_ckpt = CHECKPOINT.is_file()


# ---------------------------------------------------------------- preflight (always runs)

def test_preflight_clean_when_everything_present(monkeypatch, tmp_path):
    monkeypatch.setattr(shutil, "which", lambda name: f"/fake/bin/{name}")
    ckpt = tmp_path / "latest.pt"
    ckpt.write_bytes(b"x")
    assert cast_wm_to_datapack.preflight_errors(ckpt) == []


def test_preflight_missing_ffmpeg_is_actionable(monkeypatch, tmp_path):
    monkeypatch.setattr(shutil, "which", lambda name: None if name == "ffmpeg" else f"/fake/bin/{name}")
    ckpt = tmp_path / "latest.pt"
    ckpt.write_bytes(b"x")
    errors = cast_wm_to_datapack.preflight_errors(ckpt)
    assert len(errors) == 1
    assert "ffmpeg" in errors[0]
    assert "install" in errors[0].lower()  # tells the user how to get it


def test_preflight_missing_npx_is_actionable(monkeypatch, tmp_path):
    monkeypatch.setattr(shutil, "which", lambda name: None if name == "npx" else f"/fake/bin/{name}")
    ckpt = tmp_path / "latest.pt"
    ckpt.write_bytes(b"x")
    errors = cast_wm_to_datapack.preflight_errors(ckpt)
    assert len(errors) == 1
    assert "npx" in errors[0]
    assert "node" in errors[0].lower()


def test_preflight_missing_checkpoint_names_the_path(monkeypatch, tmp_path):
    monkeypatch.setattr(shutil, "which", lambda name: f"/fake/bin/{name}")
    missing = tmp_path / "nope.pt"
    errors = cast_wm_to_datapack.preflight_errors(missing)
    assert len(errors) == 1
    assert str(missing) in errors[0]
    assert "--checkpoint" in errors[0]


def test_main_fails_fast_on_preflight(monkeypatch, tmp_path, capsys):
    """main() must exit 1 with the actionable line BEFORE touching the model/pipeline."""
    monkeypatch.setattr(shutil, "which", lambda name: None)  # nothing on PATH
    rc = cast_wm_to_datapack.main(["--checkpoint", str(tmp_path / "nope.pt"), "--out", str(tmp_path)])
    assert rc == 1
    err = capsys.readouterr().err
    assert "[cast] preflight:" in err
    assert "ffmpeg" in err and "npx" in err and "checkpoint" in err
    assert not (tmp_path / "_frames").exists()  # pipeline never started


# ---------------------------------------------------------------- gated e2e smoke

@pytest.mark.skipif(not _has_ffmpeg, reason="ffmpeg not on PATH")
@pytest.mark.skipif(not _has_npx, reason="npx (Node.js) not on PATH")
@pytest.mark.skipif(not _has_ckpt, reason=f"trained checkpoint missing: {CHECKPOINT}")
def test_cast_smoke_emits_datapack_zip(tmp_path):
    """Tiny 2-step rollout through the REAL pipeline: WM -> frames -> mp4 -> datapack .zip."""
    rc = cast_wm_to_datapack.main(
        ["--checkpoint", str(CHECKPOINT), "--skill", "walk", "--steps", "2", "--out", str(tmp_path)]
    )
    assert rc == 0
    zips = list(tmp_path.glob("*.zip"))
    assert zips, f"no datapack .zip in {tmp_path} (contents: {[p.name for p in tmp_path.iterdir()]})"
    assert zips[0].stat().st_size > 0
