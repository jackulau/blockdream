import { describe, it, expect } from "vitest";
import {
  getJavaMapPalette,
  getSolidBlockMapPalette,
  getFullBlockMapPalette,
  getFullBlockColorPalette,
} from "@mineworld/palette";
import { preparePalette } from "../src/match";
import { gamutCoverage } from "../src/quality";

describe("gamut coverage (palette comparison)", () => {
  const map244 = preparePalette(getJavaMapPalette());
  const solid16 = preparePalette(getSolidBlockMapPalette().palette);
  const full = preparePalette(getFullBlockMapPalette().palette);

  it("the full block palette is much larger than the 16-concrete set", () => {
    expect(getFullBlockColorPalette().count).toBeGreaterThan(250);
    expect(full.entries.length).toBeGreaterThan(solid16.entries.length * 4);
  });

  it("the full block palette covers more of sRGB than the 16-concrete set", () => {
    const cSolid = gamutCoverage(solid16, 24);
    const cFull = gamutCoverage(full, 24);
    // wider gamut: higher covered fraction AND lower mean nearest ΔE
    expect(cFull.covered).toBeGreaterThan(cSolid.covered);
    expect(cFull.meanNearest).toBeLessThan(cSolid.meanNearest);
  });

  it("reports each palette's coverage (map-244 is the widest single surface)", () => {
    const cMap = gamutCoverage(map244, 24);
    const cFull = gamutCoverage(full, 24);
    const cSolid = gamutCoverage(solid16, 24);
    // sanity: all are valid fractions; map and full both beat the tiny set
    for (const c of [cMap, cFull, cSolid]) {
      expect(c.covered).toBeGreaterThanOrEqual(0);
      expect(c.covered).toBeLessThanOrEqual(1);
    }
    expect(cMap.meanNearest).toBeLessThan(cSolid.meanNearest);
  });
});
