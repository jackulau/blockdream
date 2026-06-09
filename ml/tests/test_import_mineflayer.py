"""The Mineflayer->pool importer's pure resampling core + segment numbering (no ffmpeg)."""

import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

import import_mineflayer  # noqa: E402
from import_mineflayer import ticks_to_arrays, N_BUTTONS, PHYS_DIM  # noqa: E402


def _tick(t, forward=False, sprint=False, yaw=0.0, pos=(0, 0, 0), vel=(0, 0, 0), onGround=True, speed=0.0):
    return {
        "t": t,
        "buttons": {"forward": forward, "sprint": sprint, "jump": False, "back": False, "left": False,
                    "right": False, "sneak": False, "use": False, "attack": False},
        "camera": [yaw, 0.0],
        "physics": {"pos": list(pos), "vel": list(vel), "yaw": yaw, "pitch": 0.0,
                    "onGround": onGround, "inWater": False, "speed": speed},
    }


def test_shapes_and_empty():
    a, p = ticks_to_arrays([], 8, 30.0)
    assert a.shape == (8, N_BUTTONS + 2)
    assert p.shape == (8, PHYS_DIM)
    assert a.sum() == 0 and p.sum() == 0


def test_buttons_and_camera_mapped():
    ticks = [_tick(0.0, forward=True, sprint=True, yaw=1.5)]
    a, _ = ticks_to_arrays(ticks, 4, 1.0)
    assert (a[:, 0] == 1.0).all()  # forward
    assert (a[:, 6] == 1.0).all()  # sprint
    assert (a[:, N_BUTTONS] == 1.5).all()  # camera yaw


def test_physics_nearest_tick_resampling():
    # two regimes: first half on-ground slow, second half fast in-air
    ticks = [
        _tick(0.0, pos=(0, 64, 0), vel=(0, 0, 0), onGround=True, speed=0.0),
        _tick(1.0, pos=(10, 70, 0), vel=(5, 1, 0), onGround=False, speed=5.0),
    ]
    a, p = ticks_to_arrays(ticks, 2, 1.0)
    # frame 0 -> nearest t=0 tick (on ground, speed 0); frame 1 -> nearest t=1 (in air, speed 5)
    assert p[0, 8] == 1.0 and p[0, 10] == 0.0   # onGround, speed
    assert p[1, 8] == 0.0 and p[1, 10] == 5.0   # in air, speed 5
    assert p[1, 0] == 10.0                        # pos.x advanced


def test_resampling_monotonic_time_coverage():
    ticks = [_tick(i * 0.1, forward=(i % 2 == 0)) for i in range(30)]  # 3s @ 10Hz
    a, _ = ticks_to_arrays(ticks, 30, 3.0)
    assert a.shape[0] == 30
    assert 0 < a[:, 0].sum() < 30  # some-but-not-all frames have forward held


def test_reimport_appends_new_segment(tmp_path, monkeypatch):
    """Importing the same fixture twice must APPEND seg_00001.npz, not clobber seg_00000.npz."""
    src = tmp_path / "collector_out"
    src.mkdir()
    (src / "walk.json").write_text(json.dumps({"skill": "walk", "size": 8, "seconds": 1.0, "ticks": [_tick(0.0, forward=True)]}))
    (src / "walk.mp4").write_bytes(b"")  # existence check only — decode_mp4 is stubbed below

    fills = iter([7, 9])  # distinct frame content per import so a clobber is detectable
    monkeypatch.setattr(import_mineflayer, "decode_mp4", lambda path, size: np.full((4, size, size, 3), next(fills), dtype=np.uint8))

    assert import_mineflayer.main(["--in", str(src), "--out", str(tmp_path / "data")]) == 0
    assert import_mineflayer.main(["--in", str(src), "--out", str(tmp_path / "data")]) == 0

    pool = tmp_path / "data" / "pool_real_walk"
    assert (pool / "seg_00001.npz").exists()  # second import created a NEW file
    assert (np.load(pool / "seg_00000.npz")["frames"] == 7).all()  # first import untouched
    assert (np.load(pool / "seg_00001.npz")["frames"] == 9).all()  # re-import landed in the new segment
