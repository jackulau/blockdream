import { describe, it, expect } from "vitest";
import {
  AIR_MAP_COLOR_ID,
  resolveSolidBlockId,
  solidBlockByMapColorId,
  makeBlockResolver,
  FALLBACK_BLOCK,
} from "../src/block-resolver";

// goal 036 D4/D5: the strict solid resolver must be air-aware AND shade-tolerant. Air (0) resolves to
// air BEFORE any shade folding (0 & ~3 | 2 == 2 would otherwise resurrect base 0's block); every
// non-canonical shade of a real base folds to that base's canonical +2 block instead of dropping to air.
describe("solid block resolver (air-aware + shade-tolerant)", () => {
  const byId = solidBlockByMapColorId();
  // pick a real base that has a placeable block (its canonical +2 key is in the map)
  const someKey = [...byId.keys()].find((k) => k >= 2)!; // a baseId*4+2 id
  const base = someKey & ~3; // baseId*4

  it("air sentinel resolves to air, not base 0", () => {
    expect(AIR_MAP_COLOR_ID).toBe(0);
    expect(resolveSolidBlockId(byId, AIR_MAP_COLOR_ID)).toBeUndefined();
    expect(makeBlockResolver()(AIR_MAP_COLOR_ID)).toBe(FALLBACK_BLOCK); // "minecraft:air"
  });

  it("canonical +2 shade resolves to its block", () => {
    const block = resolveSolidBlockId(byId, someKey);
    expect(block).toBeTruthy();
    expect(makeBlockResolver()(someKey)).toBe(block);
  });

  it("non-canonical shades (+0/+1/+3) fold to the same block as +2", () => {
    const canonical = resolveSolidBlockId(byId, base + 2);
    expect(canonical).toBeTruthy();
    // +1 and +3 are darker/lighter shades of the same base -> same safe block
    expect(resolveSolidBlockId(byId, base + 1)).toBe(canonical);
    expect(resolveSolidBlockId(byId, base + 3)).toBe(canonical);
    // (+0 only folds when it isn't the global air sentinel; for base > 0 it must fold, not drop)
    if (base > 0) expect(resolveSolidBlockId(byId, base + 0)).toBe(canonical);
  });

  it("a genuinely unmapped base resolves to air", () => {
    // find a +2 key that isn't in the palette (a base with no placeable block) and assert it -> air
    const unmapped = [...Array(64).keys()].map((b) => b * 4 + 2).find((k) => !byId.has(k));
    if (unmapped !== undefined) {
      expect(resolveSolidBlockId(byId, unmapped)).toBeUndefined();
      expect(makeBlockResolver()(unmapped)).toBe(FALLBACK_BLOCK);
    }
  });
});
