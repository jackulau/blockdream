import { describe, it, expect } from "vitest";
import { fillLines, greedyBoxes, MAX_FILL_VOLUME, type PlacedCell } from "../src/fill";

// goal 036 D3: no single /fill may exceed Minecraft's 32768-block cap (else it's rejected at runtime
// and that region never builds/clears).
function fillVolume(line: string): number {
  const m = line.match(/^fill (-?\d+) (-?\d+) (-?\d+) (-?\d+) (-?\d+) (-?\d+) /);
  if (!m) return 1; // setblock
  const [x0, y0, z0, x1, y1, z1] = m.slice(1, 7).map(Number) as number[];
  return (x1! - x0! + 1) * (y1! - y0! + 1) * (z1! - z0! + 1);
}

describe("/fill 32768 cap (D3)", () => {
  it("a box within the cap is a single fill", () => {
    const lines = fillLines(0, 0, 0, 31, 31, 31, "minecraft:stone"); // 32768 exactly
    expect(lines).toHaveLength(1);
    expect(fillVolume(lines[0]!)).toBe(MAX_FILL_VOLUME);
  });

  it("an oversized box splits into <=cap pieces that tile it exactly", () => {
    const lines = fillLines(0, 0, 0, 63, 63, 63, "minecraft:stone"); // 262144 = 8x the cap
    expect(lines.length).toBeGreaterThan(1);
    let total = 0;
    for (const l of lines) {
      const vol = fillVolume(l);
      expect(vol).toBeLessThanOrEqual(MAX_FILL_VOLUME);
      total += vol;
    }
    expect(total).toBe(64 * 64 * 64); // exact tiling: no overlap, no gap
  });

  it("greedyBoxes never emits a fill over the cap", () => {
    // a 64x64x16 solid region (1,048,576 blocks) -> greedy merges into big boxes that MUST be split
    const cells: PlacedCell[] = [];
    for (let z = 0; z < 16; z++) for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
      cells.push({ x, y, z, mapColorId: 6 });
    }
    const lines = greedyBoxes(cells, () => "minecraft:stone");
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) expect(fillVolume(l)).toBeLessThanOrEqual(MAX_FILL_VOLUME);
    // every cell still covered exactly once
    expect(lines.reduce((s, l) => s + fillVolume(l), 0)).toBe(64 * 64 * 16);
  });
});
