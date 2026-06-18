import { describe, it, expect } from "vitest";
import type { QuantizedFrame } from "@blockdream/color-core";
import { detectBackgroundMask, silhouetteDistance } from "../src/depth";

// The silhouette distance transform drives the inflated-dome thickness. With the old chamfer 3-4
// transform the iso-distance contours were OCTAGONAL (diagonal steps under-counted at 4/3 instead of
// √2), so domes were faceted and lumpy. These specs pin the EXACT Euclidean behaviour: for a filled
// disc the distance is radius-minus-distance-from-centre, ISOTROPICALLY — the same along axes and
// diagonals (a true circle). The isotropy bound is the discriminator a chamfer transform fails.

function discFrame(size: number, cx: number, cy: number, r: number, id = 5): QuantizedFrame {
  const ids = new Array(size * size).fill(0); // 0 = background
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) if (Math.hypot(x - cx, y - cy) <= r) ids[y * size + x] = id;
  return { width: size, height: size, mapColorId: Uint8Array.from(ids), paletteIndex: Int32Array.from(ids) };
}

function maskOf(frame: QuantizedFrame): Uint8Array {
  const bg = detectBackgroundMask(frame);
  const mask = new Uint8Array(frame.width * frame.height);
  for (let i = 0; i < mask.length; i++) mask[i] = bg[i] ? 0 : 1;
  return mask;
}

describe("exact Euclidean distance transform", () => {
  const size = 81;
  const c = 40;
  const R = 30;
  const frame = discFrame(size, c, c, R);
  const mask = maskOf(frame);
  const d = silhouetteDistance(mask, size, size);

  it("disc centre distance equals the radius", () => {
    const center = d[c * size + c]!;
    expect(Math.abs(center - R)).toBeLessThanOrEqual(2);
  });

  it("distance grows monotonically inward (centre is the farthest point)", () => {
    const center = d[c * size + c]!;
    const rim = d[(c - Math.round(R * 0.85)) * size + c]!; // near the disc edge
    const mid = d[(c - Math.round(R * 0.5)) * size + c]!;
    expect(center).toBeGreaterThan(mid);
    expect(mid).toBeGreaterThan(rim);
    expect(rim).toBeGreaterThan(0);
  });

  it("is ISOTROPIC: DT(p) + |p - centre| ≈ R in every direction (true circle, not an octagon)", () => {
    // sample interior pixels at radius R/2 from the centre along axes AND diagonals
    const dirs: [number, number][] = [
      [1, 0], [0, 1], [-1, 0], [0, -1], // axes
      [1, 1], [-1, 1], [1, -1], [-1, -1], // diagonals
      [2, 1], [1, 2], [-2, 1], [1, -2], // obliques
    ];
    const r = R * 0.5;
    const sums: number[] = [];
    for (const [dx, dy] of dirs) {
      const len = Math.hypot(dx, dy);
      const px = Math.round(c + (dx / len) * r);
      const py = Math.round(c + (dy / len) * r);
      const dt = d[py * size + px]!;
      const fromCentre = Math.hypot(px - c, py - c);
      sums.push(dt + fromCentre); // ≈ R for an exact transform, regardless of direction
    }
    for (const s of sums) expect(Math.abs(s - R)).toBeLessThanOrEqual(3);
    // isotropy: the spread between the best (axis) and worst (diagonal) direction is tiny.
    // A chamfer 3-4 transform under-counts diagonals and blows this spread well past 3.
    expect(Math.max(...sums) - Math.min(...sums)).toBeLessThanOrEqual(3);
  });

  it("background cells are exactly zero", () => {
    expect(d[0]!).toBe(0); // a corner is background
    expect(d[(size - 1) * size + (size - 1)]!).toBe(0);
  });
});
