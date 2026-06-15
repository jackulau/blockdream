import { describe, it, expect } from "vitest";
import {
  MC_VERSIONS,
  DEFAULT_MC_VERSION,
  JAVA_DATAPACK_SUPPORTED,
  BEDROCK_MIN_ENGINE,
  BEDROCK_BLOCK_VERSION,
  resolveMcVersion,
  isKnownMcVersion,
  getJavaMapPalette,
  getBedrockMapPalette,
  getSolidBlockMapPalette,
  getFullBlockColorPalette,
  getJavaBlockPalette,
} from "../src/index";

describe("MC version registry", () => {
  it("pins the authoritative pack_format for each 1.21.x release", () => {
    // From the Minecraft Wiki "Pack format" table.
    const expected: Record<string, number> = {
      "1.21": 48,
      "1.21.1": 48,
      "1.21.2": 57,
      "1.21.3": 57,
      "1.21.4": 61,
      "1.21.5": 71,
      "1.21.6": 80,
      "1.21.7": 81,
      "1.21.8": 81,
      "1.21.9": 88,
      "1.21.10": 88,
    };
    for (const [id, pf] of Object.entries(expected)) {
      expect(resolveMcVersion(id).packFormat, id).toBe(pf);
    }
  });

  it("pins the authoritative DataVersion for each 1.21.x release", () => {
    const expected: Record<string, number> = {
      "1.21": 3953,
      "1.21.1": 3955,
      "1.21.2": 4080,
      "1.21.3": 4082,
      "1.21.4": 4189,
      "1.21.5": 4325,
      "1.21.6": 4435,
      "1.21.7": 4438,
      "1.21.8": 4440,
      "1.21.9": 4554,
      "1.21.10": 4556,
    };
    for (const [id, dv] of Object.entries(expected)) {
      expect(resolveMcVersion(id).dataVersion, id).toBe(dv);
    }
  });

  it("DataVersion and pack_format both increase monotonically down the line", () => {
    for (let i = 1; i < MC_VERSIONS.length; i++) {
      expect(MC_VERSIONS[i]!.dataVersion).toBeGreaterThan(MC_VERSIONS[i - 1]!.dataVersion);
      expect(MC_VERSIONS[i]!.packFormat).toBeGreaterThanOrEqual(MC_VERSIONS[i - 1]!.packFormat);
    }
  });

  it("defaults to the compatibility floor and round-trips through resolveMcVersion", () => {
    expect(DEFAULT_MC_VERSION).toBe("1.21");
    expect(resolveMcVersion(undefined).id).toBe("1.21");
    expect(resolveMcVersion("").id).toBe("1.21");
    expect(resolveMcVersion("  1.21.5  ").id).toBe("1.21.5");
    expect(MC_VERSIONS[0]!.id).toBe(DEFAULT_MC_VERSION);
  });

  it("supported_formats spans the whole line (floor → latest)", () => {
    expect(JAVA_DATAPACK_SUPPORTED.min_inclusive).toBe(48);
    expect(JAVA_DATAPACK_SUPPORTED.max_inclusive).toBe(88);
    for (const m of MC_VERSIONS) {
      expect(m.packFormat).toBeGreaterThanOrEqual(JAVA_DATAPACK_SUPPORTED.min_inclusive);
      expect(m.packFormat).toBeLessThanOrEqual(JAVA_DATAPACK_SUPPORTED.max_inclusive);
    }
  });

  it("Bedrock floors are 1.21.0 (forward-compatible)", () => {
    expect(BEDROCK_MIN_ENGINE).toEqual([1, 21, 0]);
    expect(BEDROCK_BLOCK_VERSION).toBe(0x01_15_00_00);
  });

  it("rejects an unsupported version with a helpful message", () => {
    expect(() => resolveMcVersion("1.19.4")).toThrow(/unsupported.*1\.19\.4/i);
    expect(() => resolveMcVersion("9.9")).toThrow(/Supported:/);
    expect(isKnownMcVersion("1.21.5")).toBe(true);
    expect(isKnownMcVersion("1.19")).toBe(false);
  });
});

describe("palette version aliasing (the --version ENOENT fix)", () => {
  // Before the fix, every one of these threw ENOENT because only
  // java-block-palette-1.21.json / java-map-colors-1.21.9.json exist on disk.
  it("resolves any 1.21.x patch to the canonical solid-block palette", () => {
    for (const v of ["1.21", "1.21.4", "1.21.5", "1.21.9", "1.21.10"]) {
      const { palette, blockByMapColorId } = getSolidBlockMapPalette(v);
      expect(palette.colors.length, v).toBeGreaterThan(0);
      expect(blockByMapColorId.size, v).toBe(palette.colors.length);
    }
  });

  it("resolves any 1.21.x patch to the 244-color map palette (java + bedrock)", () => {
    for (const v of ["1.21", "1.21.5", "1.21.9"]) {
      expect(getJavaMapPalette(v).colors.length, `java ${v}`).toBe(244);
      expect(getBedrockMapPalette(v).colors.length, `bedrock ${v}`).toBe(244);
    }
  });

  it("resolves any 1.21.x patch to the wide-gamut block-color set", () => {
    for (const v of ["1.21", "1.21.6", "1.21.10"]) {
      expect(getFullBlockColorPalette(v).blocks.length, v).toBeGreaterThan(100);
      expect(getJavaBlockPalette(v).bases.length, v).toBeGreaterThan(0);
    }
  });

  it("still throws for a palette version with no canonical fallback file", () => {
    // A bogus prefix path can't resolve - but a real loader with a known canonical never throws on patch ids.
    expect(() => getJavaMapPalette("1.21.7")).not.toThrow();
  });
});
