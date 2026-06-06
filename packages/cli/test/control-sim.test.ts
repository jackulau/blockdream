// Proves the live in-Minecraft control bridge end-to-end (headless): server-observed player
// pose → derived VPT action → action message → world-model frame → map-colour tiles that a
// map-wall renderer copies into MapState.colors. This is the in-repo contract for the Fabric
// mod (WorldModelClient + InputCapture).

import { describe, it, expect } from "vitest";
import {
  deriveAction,
  frameToMapTiles,
  runControlLoop,
  actionMessage,
  BTN,
  N_BUTTONS,
  type Pose,
} from "../src/control-sim";

const base: Pose = { x: 0, z: 0, yaw: 0, pitch: 0, onGround: true, sprinting: false, sneaking: false };

describe("server-side input derivation (vanilla client, no mixin)", () => {
  it("walking the way you face → forward button", () => {
    // yaw 0 → facing +Z; moving +Z is forward
    const a = deriveAction(base, { ...base, z: 0.2 });
    expect(a.buttons[BTN.forward]).toBe(1);
    expect(a.buttons[BTN.back]).toBe(0);
  });

  it("moving opposite your facing → back button", () => {
    const a = deriveAction(base, { ...base, z: -0.2 });
    expect(a.buttons[BTN.back]).toBe(1);
  });

  it("strafing maps to left/right relative to facing", () => {
    const right = deriveAction(base, { ...base, x: 0.2 }); // +X with yaw 0 is to the right
    expect(right.buttons[BTN.right]).toBe(1);
    const left = deriveAction(base, { ...base, x: -0.2 });
    expect(left.buttons[BTN.left]).toBe(1);
  });

  it("facing is respected: same world motion is 'forward' after a 90° turn", () => {
    // yaw 90° in MC faces -X; moving -X should read as forward
    const turned: Pose = { ...base, yaw: 90 };
    const a = deriveAction(turned, { ...turned, x: -0.2 });
    expect(a.buttons[BTN.forward]).toBe(1);
  });

  it("look delta becomes camera in [-1,1]; big turns clamp", () => {
    const a = deriveAction(base, { ...base, yaw: 6, pitch: -6 }); // 6° each, CAMERA_DEG=12 → 0.5
    expect(a.camera[0]).toBeCloseTo(0.5, 5);
    expect(a.camera[1]).toBeCloseTo(-0.5, 5);
    const big = deriveAction(base, { ...base, yaw: 90 });
    expect(big.camera[0]).toBe(1); // clamped
  });

  it("jump (left ground), sneak, sprint flags map to buttons", () => {
    const jump = deriveAction(base, { ...base, onGround: false });
    expect(jump.buttons[BTN.jump]).toBe(1);
    expect(deriveAction(base, { ...base, sneaking: true }).buttons[BTN.sneak]).toBe(1);
    expect(deriveAction(base, { ...base, sprinting: true }).buttons[BTN.sprint]).toBe(1);
  });

  it("standing still → all-zero buttons, zero camera", () => {
    const a = deriveAction(base, { ...base });
    expect(a.buttons).toEqual(new Array(N_BUTTONS).fill(0));
    expect(a.camera).toEqual([0, 0]);
  });

  it("carries the movement-type skill through (boat etc.)", () => {
    const a = deriveAction(base, { ...base, z: 0.2 }, "boat");
    expect(a.skill).toBe("boat");
    expect(JSON.parse(actionMessage(a))).toMatchObject({ type: "action", skill: "boat" });
  });
});

describe("action message matches the serve.py schema", () => {
  it("is {type:'action', buttons:[9], camera:[2]}", () => {
    const a = deriveAction(base, { ...base, z: 0.2 });
    const msg = JSON.parse(actionMessage(a));
    expect(msg.type).toBe("action");
    expect(msg.buttons).toHaveLength(9);
    expect(msg.camera).toHaveLength(2);
    expect(msg.buttons.every((v: number) => v === 0 || v === 1)).toBe(true);
  });
});

describe("frame → map-colour tiles (what MapState.colors receives)", () => {
  it("a 256×128 frame splits into 2×1 valid 16384-byte tiles", () => {
    const w = 256, h = 128;
    const data = new Uint8Array(w * h * 3).fill(100);
    const out = frameToMapTiles({ width: w, height: h, data });
    expect(out).toHaveLength(2); // 2 cols × 1 row
    for (const t of out) {
      expect(t.colors).toHaveLength(16384);
      expect(t.colors.every((b) => b >= 0 && b <= 255)).toBe(true); // valid bytes
    }
  });

  it("rejects non-128-multiple frames (wall must tile cleanly)", () => {
    expect(() => frameToMapTiles({ width: 100, height: 128, data: new Uint8Array(100 * 128 * 3) })).toThrow();
  });
});

describe("full loop carries input through to distinct frames", () => {
  it("different player motion yields different map tiles", () => {
    const fwd = runControlLoop([base, { ...base, z: 0.3 }]);
    const turn = runControlLoop([base, { ...base, yaw: 10 }]);
    expect(fwd).toHaveLength(1);
    const a = fwd[0]!.tiles[0]!.colors;
    const b = turn[0]!.tiles[0]!.colors;
    // forward (raised horizon) vs camera-pan (moved sun) → the rendered maps differ
    let diff = 0;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diff++;
    expect(diff).toBeGreaterThan(0);
  });

  it("produces one bridge step per pose transition, each a valid map frame", () => {
    const steps = runControlLoop([base, { ...base, z: 0.2 }, { ...base, z: 0.4, yaw: 5 }], { size: 256 });
    expect(steps).toHaveLength(2);
    for (const s of steps) {
      expect(s.tiles.length).toBe(4); // 256×256 → 2×2 maps
      expect(JSON.parse(s.message).type).toBe("action");
    }
  });
});
