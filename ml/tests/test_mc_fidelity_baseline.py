"""goal-037: the MC fidelity gate's baseline (the detail_ratio DENOMINATOR) must be CWD-independent
and must FAIL LOUD when the real-footage pools are absent - never silently fall back to a stale
constant that skews the ratio. Run-from-repo-root once reported FIDELITY 0.236 instead of the true
0.688 because a CWD-relative glob missed the pools and a hardcoded 0.0318 fallback (vs the real
~0.0109) became the denominator (0.688 * 0.0109 / 0.0318 = 0.236, exact)."""

from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest

# eval_mc_fidelity lives in scripts/, not the installed package - load it by path.
_SPEC = importlib.util.spec_from_file_location(
    "eval_mc_fidelity", Path(__file__).resolve().parent.parent / "scripts" / "eval_mc_fidelity.py"
)
mcfid = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(mcfid)

_HAS_POOLS = bool(sorted((mcfid.ML_ROOT / "data").glob("pool_real_*")))


def test_ml_root_resolves_to_ml_dir():
    # ML_ROOT must be the ml/ package root (where data/ lives), regardless of where pytest runs from.
    assert mcfid.ML_ROOT.name == "ml"
    assert (mcfid.ML_ROOT / "scripts" / "eval_mc_fidelity.py").exists()


@pytest.mark.skipif(not _HAS_POOLS, reason="real pools (ml/data/pool_real_*) not built in this tree")
def test_baseline_is_cwd_independent(tmp_path, monkeypatch):
    # measured from ml/ ...
    det_home, _ = mcfid._real_baseline()
    # ... must be identical when invoked from an unrelated CWD (the bug: CWD-relative glob missed here)
    monkeypatch.chdir(tmp_path)
    det_away, _ = mcfid._real_baseline()
    assert det_away == pytest.approx(det_home)
    # and it is the REAL measured baseline (~0.0109), NOT the deleted stale constant 0.0318
    assert 0.0 < det_away < 0.02
    assert det_away != pytest.approx(0.0318, abs=1e-3)


def test_missing_pools_fail_loud(tmp_path, monkeypatch):
    # point the package root at an empty dir -> no pools -> must RAISE, not silently guess a constant
    monkeypatch.setattr(mcfid, "ML_ROOT", tmp_path)
    with pytest.raises(FileNotFoundError, match="pool_real_"):
        mcfid._real_baseline()


def test_no_silent_stale_fallback_in_source():
    # the 3x-skew trap (a bare `return 0.0318, ...`) must be gone from the source for good
    src = Path(_SPEC.origin).read_text()
    assert "return 0.0318" not in src
