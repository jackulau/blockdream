"""Maps real VPT jsonl action frames into our action space."""

from __future__ import annotations

from blockdream_wm.vpt_actions import parse_vpt_action, CAMERA_DENOM


def test_movement_keys_map_to_buttons():
    frame = {"keyboard": {"keys": ["key.keyboard.w", "key.keyboard.a", "key.keyboard.space"]}, "mouse": {"buttons": [], "dx": 0, "dy": 0}}
    btn, cam = parse_vpt_action(frame)
    assert btn[0] == 1  # forward (w)
    assert btn[2] == 1  # left (a)
    assert btn[4] == 1  # jump (space)
    assert btn[1] == 0 and btn[3] == 0
    assert cam == [0.0, 0.0]


def test_sneak_sprint_and_mouse_buttons():
    frame = {"keyboard": {"keys": ["key.keyboard.left.shift", "key.keyboard.left.control"]}, "mouse": {"buttons": [0, 1], "dx": 0, "dy": 0}}
    btn, _ = parse_vpt_action(frame)
    assert btn[5] == 1  # sneak
    assert btn[6] == 1  # sprint
    assert btn[7] == 1  # attack (mouse 0)
    assert btn[8] == 1  # use (mouse 1)


def test_camera_from_mouse_delta_clamped():
    frame = {"keyboard": {"keys": []}, "mouse": {"buttons": [], "dx": CAMERA_DENOM, "dy": -CAMERA_DENOM * 5}}
    _, cam = parse_vpt_action(frame)
    assert cam[0] == 1.0  # +denom px → +1
    assert cam[1] == -1.0  # large negative → clamped to -1


def test_ignores_unmapped_keys_and_handles_empty():
    # real VPT frames include keys like 'e' (inventory), 'f3' (debug) we don't map
    frame = {"keyboard": {"keys": ["key.keyboard.e", "key.keyboard.f3"]}, "mouse": {"buttons": [], "dx": 0, "dy": 0}}
    btn, cam = parse_vpt_action(frame)
    assert sum(btn) == 0
    # missing fields default safely
    btn2, cam2 = parse_vpt_action({})
    assert sum(btn2) == 0 and cam2 == [0.0, 0.0]
