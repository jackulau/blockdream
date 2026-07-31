import { describe, it, expect } from "vitest";
import { quantizeFrame, type RgbImage } from "@blockdream/color-core";
import { generateJavaDatapack } from "@blockdream/emit-commands";
import { quantizeForDatapack } from "../src/blockart-export";
import { paletteForChoice } from "../src/blockart-core";
import { resolveBlock } from "../src/resolve-block";
import { blockArtExportText } from "../src/ui-feedback";

// §02 datapack export parity (goal 088 D12). The preview quantizes against the 244-colour MAP
// palette but the export resolves through the SOLID resolver (air for unplaceable bases): a
// live repro showed 63/4096 air holes + a 95→39 block collapse on a gradient, while the CLI
// (solid palette end to end) had none. The export now re-quantizes the source frame against
// the solid palette - locked here: zero air cells for full-gamut input, block set equal to the
// solid-palette quantization, and the OLD path's holes demonstrated so the premise can't rot.

/** Full-gamut gradient: hue sweep across x, lightness across y - touches every palette region. */
function gradient(w: number, h: number): RgbImage {
  const data = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const j = (y * w + x) * 3;
      const t = x / (w - 1);
      const l = y / (h - 1);
      data[j] = Math.round(255 * l * Math.abs(Math.sin(Math.PI * t)));
      data[j + 1] = Math.round(255 * l * Math.abs(Math.sin(Math.PI * (t + 1 / 3))));
      data[j + 2] = Math.round(255 * l * Math.abs(Math.sin(Math.PI * (t + 2 / 3))));
    }
  }
  return { width: w, height: h, data };
}

const rgb = gradient(64, 64);

describe("§02 datapack export parity (solid palette end to end)", () => {
  it("the OLD path (map-palette frame through the solid resolver) really produced air holes", () => {
    const mapQ = quantizeFrame(rgb, paletteForChoice("map"), { method: "floyd-steinberg" });
    let air = 0;
    for (let p = 0; p < mapQ.mapColorId.length; p++) {
      if (resolveBlock(mapQ.mapColorId[p]!) === "minecraft:air") air++;
    }
    expect(air).toBeGreaterThan(0); // the bug premise: unplaceable map bases fold to air
  });

  it("the export frame has ZERO air cells on full-gamut input - every cell places a real block", () => {
    const q = quantizeForDatapack(rgb, "floyd-steinberg");
    for (let p = 0; p < q.mapColorId.length; p++) {
      expect(resolveBlock(q.mapColorId[p]!), `cell ${p}`).not.toBe("minecraft:air");
    }
  });

  it("the emitted pack contains no air setblocks and its block set equals the solid-palette quantization", () => {
    const q = quantizeForDatapack(rgb, "floyd-steinberg");
    const pack = generateJavaDatapack([q], resolveBlock, {
      namespace: "blockdream",
      supportedFormats: { min_inclusive: 48, max_inclusive: 88 },
    });
    // one setblock per cell - no cell was dropped or resolved to air
    expect(pack.totalSetblocks).toBe(q.width * q.height);
    const frameFiles = [...pack.files.entries()].filter(([k]) => /function\/frames\//.test(k));
    expect(frameFiles.length).toBeGreaterThan(0);
    const placed = new Set<string>();
    for (const [, content] of frameFiles) {
      expect(content).not.toContain("minecraft:air");
      for (const m of content.matchAll(/setblock -?\d+ -?\d+ -?\d+ (\S+) replace/g)) placed.add(m[1]!);
    }
    // block set parity: exactly the blocks the solid-palette quantization resolves to
    const expected = new Set<string>();
    for (let p = 0; p < q.mapColorId.length; p++) expected.add(resolveBlock(q.mapColorId[p]!));
    expect(placed).toEqual(expected);
    expect(placed.size).toBeGreaterThan(10); // a real gradient uses a real spread of blocks
  });

  it("dither parity: the export honors the preview's selected dither method", () => {
    const a = quantizeForDatapack(rgb, "none");
    const b = quantizeForDatapack(rgb, "floyd-steinberg");
    expect(Buffer.from(a.mapColorId).equals(Buffer.from(b.mapColorId))).toBe(false);
  });

  it("the D11f single-frame message logic is unaffected by the parity fix", () => {
    expect(blockArtExportText(64, 64, 1)).toContain("· 1 frame");
    expect(blockArtExportText(64, 64, 8)).toContain("animated GIF: exporting the current frame only");
  });
});
