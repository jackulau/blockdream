import { describe, it, expect } from "vitest";
import type { QuantizedFrame } from "@mineworld/color-core";
import { imageToSolid } from "../src/depth";
import { getVoxel, EMPTY, type VoxelVolume } from "../src/volume";

// Accuracy spec for image→3D: whatever depth we infer, the reconstruction must be FAITHFUL to the
// source image — the front view reproduces the subject exactly (colour + silhouette), and the
// background is fully isolated. These are the guarantees that make the build "accurate", separate
// from how pleasing the inferred depth looks (validated visually in the browser).

function scene(size: number, draw: (set: (x: number, y: number, id: number) => void) => void): { frame: QuantizedFrame; ids: number[] } {
  const ids = new Array(size * size).fill(0); // 0 = background
  draw((x, y, id) => {
    if (x >= 0 && y >= 0 && x < size && y < size) ids[y * size + x] = id;
  });
  return { frame: { width: size, height: size, mapColorId: Uint8Array.from(ids), paletteIndex: Int32Array.from(ids) }, ids };
}

// frontmost (max-z) voxel colour per XY column → the "front view" of the solid
function frontView(v: VoxelVolume): (number | null)[] {
  const out: (number | null)[] = new Array(v.sx * v.sy).fill(null);
  for (let y = 0; y < v.sy; y++)
    for (let x = 0; x < v.sx; x++) {
      for (let z = v.sz - 1; z >= 0; z--) {
        const c = getVoxel(v, x, y, z);
        if (c !== EMPTY) {
          out[y * v.sx + x] = c;
          break;
        }
      }
    }
  return out;
}

describe("image→3D accuracy", () => {
  it("silhouette fidelity: every subject pixel occupies its column, every background pixel is empty", () => {
    const size = 20;
    const { frame } = scene(size, (set) => {
      // an irregular subject (not just a square) — a plus / cross shape, ids 5 and 7
      for (let i = 4; i < 16; i++) set(i, 10, 5);
      for (let j = 4; j < 16; j++) set(10, j, 7);
      set(6, 6, 9); // an isolated subject pixel near the arm
    });
    const v = imageToSolid(frame, { maxDepth: 12 });
    for (let iy = 0; iy < size; iy++)
      for (let ix = 0; ix < size; ix++) {
        const id = frame.mapColorId[iy * size + ix]!;
        const wy = size - 1 - iy;
        let occupied = 0;
        for (let z = 0; z < v.sz; z++) if (getVoxel(v, ix, wy, z) !== EMPTY) occupied++;
        if (id === 0) expect(occupied).toBe(0); // background → air
        else expect(occupied).toBeGreaterThanOrEqual(1); // subject → at least one block
      }
  });

  it("colour fidelity: a subject column contains ONLY its source pixel's colour", () => {
    const size = 16;
    const { frame } = scene(size, (set) => {
      for (let i = 3; i < 13; i++) for (let j = 3; j < 13; j++) set(i, j, ((i + j) % 7) + 1); // varied colours
    });
    const v = imageToSolid(frame, { maxDepth: 10 });
    for (let iy = 0; iy < size; iy++)
      for (let ix = 0; ix < size; ix++) {
        const id = frame.mapColorId[iy * size + ix]!;
        if (id === 0) continue;
        const wy = size - 1 - iy;
        for (let z = 0; z < v.sz; z++) {
          const c = getVoxel(v, ix, wy, z);
          if (c !== EMPTY) expect(c).toBe(id); // never the wrong block
        }
      }
  });

  it("front-view reconstruction reproduces the source subject EXACTLY (colour + position)", () => {
    const size = 18;
    const { frame } = scene(size, (set) => {
      for (let i = 2; i < 16; i++) for (let j = 5; j < 12; j++) set(i, j, ((i * 3 + j) % 11) + 1);
    });
    const v = imageToSolid(frame, { maxDepth: 14 });
    const front = frontView(v);
    for (let iy = 0; iy < size; iy++)
      for (let ix = 0; ix < size; ix++) {
        const id = frame.mapColorId[iy * size + ix]!;
        const wy = size - 1 - iy;
        const seen = front[wy * v.sx + ix];
        if (id === 0) expect(seen).toBeNull(); // background not visible
        else expect(seen).toBe(id); // exact pixel colour at the exact place
      }
  });

  it("is coherent from the side too (a real 3D body, not a one-voxel card)", () => {
    const size = 22;
    const { frame } = scene(size, (set) => {
      for (let i = 4; i < 18; i++) for (let j = 4; j < 18; j++) set(i, j, 5);
    });
    const v = imageToSolid(frame, { maxDepth: 14 });
    // side view (look along X): the central rows occupy many depth layers
    let maxDepthSeen = 0;
    const cy = size - 1 - 11;
    for (let x = 0; x < v.sx; x++) {
      let d = 0;
      for (let z = 0; z < v.sz; z++) if (getVoxel(v, x, cy, z) !== EMPTY) d++;
      maxDepthSeen = Math.max(maxDepthSeen, d);
    }
    expect(maxDepthSeen).toBeGreaterThan(6); // interior is genuinely thick
  });
});
