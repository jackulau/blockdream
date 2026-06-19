import { describe, it, expect } from "vitest";
import { buildToLiveCommands, buildToLiveFrames, buildBoxSetupCommands, type WallFrame } from "../src/rcon-bridge";

function solidFrame(w: number, h: number, rgb: [number, number, number]): WallFrame {
  const pixels = new Uint8Array(w * h * 3);
  for (let i = 0; i < w * h; i++) {
    pixels[i * 3] = rgb[0];
    pixels[i * 3 + 1] = rgb[1];
    pixels[i * 3 + 2] = rgb[2];
  }
  return { width: w, height: h, pixels };
}

const RED: [number, number, number] = [200, 40, 40];

describe("buildToLiveCommands (cast a 3D build live via RCON)", () => {
  it("turns an image into a depth-bounded 3D build, placed at origin", () => {
    const origin = { x: 100, y: 70, z: 20 };
    const { commands, volume } = buildToLiveCommands(solidFrame(8, 8, RED), origin, { depth: 4 });
    expect(commands.length).toBeGreaterThan(0);
    expect([volume.sx, volume.sy]).toEqual([8, 8]); // footprint = image size
    expect(volume.sz).toBeGreaterThan(0);
    expect(volume.sz).toBeLessThanOrEqual(4); // depth bounded by --depth
    // every emitted command sits inside the build's world box [origin, origin+dims)
    for (const c of commands) {
      const t = c.split(/\s+/);
      expect(t[0] === "fill" || t[0] === "setblock").toBe(true);
      expect(+t[1]!).toBeGreaterThanOrEqual(origin.x);
      expect(+t[2]!).toBeGreaterThanOrEqual(origin.y);
      expect(+t[3]!).toBeGreaterThanOrEqual(origin.z);
    }
  });

  it("buildBoxSetupCommands clears exactly the W×H×D build box at origin (one /fill)", () => {
    const { volume } = buildToLiveCommands(solidFrame(8, 8, RED), { x: 0, y: 64, z: 0 }, { depth: 4 });
    const setup = buildBoxSetupCommands({ x: 100, y: 70, z: 20 }, volume);
    expect(setup).toHaveLength(1);
    expect(setup[0]).toBe(`fill 100 70 20 ${100 + volume.sx - 1} ${70 + volume.sy - 1} ${20 + volume.sz - 1} minecraft:air replace`);
  });

  it("--facing east rotates the footprint (X/Z swap, lossless quarter-turn)", () => {
    const f = solidFrame(10, 6, RED); // 10 wide
    const south = buildToLiveCommands(f, { x: 0, y: 0, z: 0 }, { depth: 3, facing: "south" }).volume;
    const east = buildToLiveCommands(f, { x: 0, y: 0, z: 0 }, { depth: 3, facing: "east" }).volume;
    expect(south.sx).toBe(10); // south = no turn
    expect([east.sx, east.sz]).toEqual([south.sz, south.sx]); // east swaps X/Z
    expect(east.sy).toBe(south.sy); // height unchanged by a Y rotation
  });
});

describe("buildToLiveFrames (live 3D animation)", () => {
  it("no --animate → one keyframe list (identical to buildToLiveCommands)", () => {
    const f = solidFrame(8, 8, RED);
    const origin = { x: 1, y: 2, z: 3 };
    const { frameCommands } = buildToLiveFrames(f, origin, { depth: 4 });
    expect(frameCommands).toHaveLength(1);
    expect(frameCommands[0]).toEqual(buildToLiveCommands(f, origin, { depth: 4 }).commands);
  });

  it("--animate spin → N delta frames on a cube-padded build (never clips)", () => {
    const f = solidFrame(10, 6, RED); // non-cubic footprint
    const { frameCommands, volume } = buildToLiveFrames(f, { x: 0, y: 0, z: 0 }, { depth: 3, animate: "spin", animateFrames: 6 });
    expect(frameCommands).toHaveLength(6);
    expect(volume.sx).toBe(volume.sz); // cube-padded X/Z so the spin never clips
    expect(frameCommands[0]!.length).toBeGreaterThan(0); // frame 0 = keyframe
    expect(frameCommands.every((fr) => Array.isArray(fr))).toBe(true);
  });

  it("--animate-frames sets the frame count", () => {
    const f = solidFrame(8, 8, RED);
    const { frameCommands } = buildToLiveFrames(f, { x: 0, y: 0, z: 0 }, { depth: 2, animate: "spin", animateFrames: 12 });
    expect(frameCommands).toHaveLength(12);
  });
});
