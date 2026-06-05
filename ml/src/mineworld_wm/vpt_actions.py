"""Map an OpenAI VPT per-frame action (the .jsonl format) into our action space.

VPT frame action (subset we use):
  keyboard.keys : list of "key.keyboard.<name>" currently held
  mouse.buttons : list of pressed mouse buttons (0 = attack/left, 1 = use/right)
  mouse.dx, dy  : mouse movement in pixels this frame (the camera signal)

Our action space (matches actions.ActionEncoder / the demos):
  buttons[9] = [forward, back, left, right, jump, sneak, sprint, attack, use]
  camera[2]  = [dx, dy] continuous, clamped to [-1, 1]
"""

from __future__ import annotations

# button index → the VPT keyboard key that sets it
KEY_TO_BUTTON = {
    "key.keyboard.w": 0,
    "key.keyboard.s": 1,
    "key.keyboard.a": 2,
    "key.keyboard.d": 3,
    "key.keyboard.space": 4,
    "key.keyboard.left.shift": 5,
    "key.keyboard.left.control": 6,  # sprint
}
N_BUTTONS = 9
ATTACK = 7
USE = 8

# VPT mouse dx/dy are raw pixel deltas; ±CAMERA_DENOM px → ±1.0 (then clamped).
CAMERA_DENOM = 20.0


def _clamp(v: float, lo: float = -1.0, hi: float = 1.0) -> float:
    return lo if v < lo else hi if v > hi else v


def parse_vpt_action(frame: dict) -> tuple[list[int], list[float]]:
    """One VPT jsonl frame dict → (buttons[9] 0/1, camera[2] in [-1,1])."""
    buttons = [0] * N_BUTTONS
    kb = frame.get("keyboard", {}) or {}
    for key in kb.get("keys", []) or []:
        idx = KEY_TO_BUTTON.get(key)
        if idx is not None:
            buttons[idx] = 1

    mouse = frame.get("mouse", {}) or {}
    pressed = mouse.get("buttons", []) or []
    if 0 in pressed:
        buttons[ATTACK] = 1
    if 1 in pressed:
        buttons[USE] = 1

    cx = _clamp(float(mouse.get("dx", 0.0)) / CAMERA_DENOM)
    cy = _clamp(float(mouse.get("dy", 0.0)) / CAMERA_DENOM)
    return buttons, [cx, cy]
