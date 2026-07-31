import { describe, it, expect } from "vitest";
import { preparePalette } from "@blockdream/color-core";
import type { QuantizedFrame } from "@blockdream/color-core";
import javaMapPalette from "@blockdream/palette/data/java-map-colors-1.21.9.json";
import type { MapPalette } from "@blockdream/palette";
import { createVolume, setVoxel } from "@blockdream/voxel";
import {
  encodeGif,
  quantizedToRaster,
  flatVolumeToRaster,
  upscaleNearest,
  fitScale,
  padRaster,
  type Raster,
  type GifFrame,
} from "../src/pixel-export";

// mapColorId -> [r,g,b], built the same way the module under test builds its table, so the
// raster tests assert against the real palette without hardcoding colour values.
const MAP_RGB: Array<[number, number, number] | undefined> = (() => {
  const table = new Array<[number, number, number] | undefined>(256);
  for (const e of preparePalette(javaMapPalette as unknown as MapPalette).entries) {
    table[e.color.mapColorId] = [e.color.r, e.color.g, e.color.b];
  }
  return table;
})();

/** Build a raster from an explicit per-pixel [r,g,b,a] list (row-major). */
function raster(width: number, height: number, px: Array<[number, number, number, number]>): Raster {
  expect(px.length).toBe(width * height);
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < px.length; i++) data.set(px[i]!, i * 4);
  return { width, height, data };
}

/** Read one pixel of a raster as [r,g,b,a]. */
function px(r: Raster, x: number, y: number): [number, number, number, number] {
  const o = (y * r.width + x) * 4;
  return [r.data[o]!, r.data[o + 1]!, r.data[o + 2]!, r.data[o + 3]!];
}

// ---- minimal GIF decoder (test-side; parses exactly what a spec decoder would) ------------------

interface ParsedFrame {
  delayCs: number;
  disposal: number;
  transparentFlag: boolean;
  transparentIndex: number;
  left: number;
  top: number;
  width: number;
  height: number;
  minCodeSize: number;
  indices: Uint8Array;
}

interface ParsedGif {
  magic: string;
  width: number;
  height: number;
  hasGlobalTable: boolean;
  tableBits: number; // global colour table has 2^tableBits entries
  table: Array<[number, number, number]>;
  netscapePresent: boolean;
  netscapeLoop: number;
  frames: ParsedFrame[];
  trailerSeen: boolean;
}

/** Standard GIF LZW decode: variable-width codes, LSB-first, over concatenated sub-block bytes. */
function lzwDecode(minCodeSize: number, data: Uint8Array, pixelCount: number): Uint8Array {
  const clearCode = 1 << minCodeSize;
  const eoiCode = clearCode + 1;
  let codeSize = minCodeSize + 1;
  let dict: number[][] = [];
  const reset = (): void => {
    dict = [];
    for (let i = 0; i < clearCode; i++) dict.push([i]);
    dict.push([]); // clear
    dict.push([]); // eoi
    codeSize = minCodeSize + 1;
  };
  reset();

  let bitPos = 0;
  const readCode = (): number => {
    let code = 0;
    for (let i = 0; i < codeSize; i++) {
      if (data[bitPos >> 3]! & (1 << (bitPos & 7))) code |= 1 << i;
      bitPos++;
    }
    return code;
  };

  const out: number[] = [];
  let prev: number[] | null = null;
  for (;;) {
    const code = readCode();
    if (code === eoiCode) break;
    if (code === clearCode) {
      reset();
      prev = null;
      continue;
    }
    let entry: number[];
    if (code < dict.length) {
      entry = dict[code]!;
    } else if (code === dict.length && prev !== null) {
      entry = [...prev, prev[0]!]; // the KwKwK case
    } else {
      throw new Error(`lzwDecode: invalid code ${code} (dict ${dict.length})`);
    }
    out.push(...entry);
    if (prev !== null) {
      dict.push([...prev, entry[0]!]);
      if (dict.length === 1 << codeSize && codeSize < 12) codeSize++;
    }
    prev = entry;
    if (out.length > pixelCount) throw new Error(`lzwDecode: overran ${pixelCount} pixels`);
  }
  return Uint8Array.from(out);
}

/** Parse the whole GIF byte stream produced by encodeGif (throws on anything malformed). */
function parseGif(bytes: Uint8Array): ParsedGif {
  let pos = 0;
  const u8 = (): number => bytes[pos++]!;
  const u16 = (): number => u8() | (u8() << 8);
  const subBlocks = (): Uint8Array => {
    const parts: number[] = [];
    for (;;) {
      const n = u8();
      if (n === 0) break;
      for (let i = 0; i < n; i++) parts.push(u8());
    }
    return Uint8Array.from(parts);
  };

  const magic = String.fromCharCode(...bytes.subarray(0, 6));
  pos = 6;
  const width = u16();
  const height = u16();
  const packed = u8();
  u8(); // background colour index
  u8(); // pixel aspect ratio
  const hasGlobalTable = (packed & 0x80) !== 0;
  const tableBits = (packed & 0x07) + 1;
  const table: Array<[number, number, number]> = [];
  if (hasGlobalTable) {
    for (let i = 0; i < 1 << tableBits; i++) table.push([u8(), u8(), u8()]);
  }

  let netscapePresent = false;
  let netscapeLoop = -1;
  const frames: ParsedFrame[] = [];
  let gce: { delayCs: number; disposal: number; transparentFlag: boolean; transparentIndex: number } | null = null;
  let trailerSeen = false;

  while (pos < bytes.length) {
    const block = u8();
    if (block === 0x3b) {
      trailerSeen = true;
      break;
    }
    if (block === 0x21) {
      const label = u8();
      const data = subBlocks();
      if (label === 0xf9) {
        gce = {
          disposal: (data[0]! >> 2) & 0x07,
          transparentFlag: (data[0]! & 1) === 1,
          delayCs: data[1]! | (data[2]! << 8),
          transparentIndex: data[3]!,
        };
      } else if (label === 0xff && String.fromCharCode(...data.subarray(0, 11)) === "NETSCAPE2.0") {
        netscapePresent = true;
        expect(data[11]).toBe(1); // loop sub-block id
        netscapeLoop = data[12]! | (data[13]! << 8);
      }
    } else if (block === 0x2c) {
      const left = u16();
      const top = u16();
      const w = u16();
      const h = u16();
      const ipacked = u8();
      expect(ipacked & 0x80, "no local colour table expected").toBe(0);
      const minCodeSize = u8();
      const indices = lzwDecode(minCodeSize, subBlocks(), w * h);
      if (gce === null) throw new Error("image without a preceding graphics-control extension");
      frames.push({ ...gce, left, top, width: w, height: h, minCodeSize, indices });
      gce = null;
    } else {
      throw new Error(`unexpected block 0x${block.toString(16)} at offset ${pos - 1}`);
    }
  }
  return { magic, width, height, hasGlobalTable, tableBits, table, netscapePresent, netscapeLoop, frames, trailerSeen };
}

/** Replicate the encoder's palette assignment (first-seen opaque colour order, across ALL frames). */
function expectedPalette(frames: GifFrame[]): { indexOf: Map<number, number>; transparentIndex: number } {
  const indexOf = new Map<number, number>();
  let hasAlpha = false;
  for (const { raster: r } of frames) {
    for (let p = 0; p < r.data.length; p += 4) {
      if (r.data[p + 3]! < 128) {
        hasAlpha = true;
        continue;
      }
      const key = (r.data[p]! << 16) | (r.data[p + 1]! << 8) | r.data[p + 2]!;
      if (!indexOf.has(key)) indexOf.set(key, indexOf.size);
    }
  }
  return { indexOf, transparentIndex: hasAlpha ? indexOf.size : -1 };
}

// ---- fixtures -----------------------------------------------------------------------------------

const R: [number, number, number, number] = [200, 30, 30, 255];
const G: [number, number, number, number] = [20, 190, 60, 255];
const B: [number, number, number, number] = [10, 40, 220, 255];
const T: [number, number, number, number] = [0, 0, 0, 0]; // transparent (alpha < 128)

/** 3x2, two frames, three colours + one transparent pixel; distinct delays incl. a sub-2cs one. */
function twoFrameFixture(): GifFrame[] {
  return [
    { raster: raster(3, 2, [R, G, B, G, T, R]), delayMs: 120 },
    { raster: raster(3, 2, [B, B, R, T, G, G]), delayMs: 40 },
  ];
}

describe("encodeGif container structure (decoded back byte-by-byte)", () => {
  it("emits GIF89a magic, screen size, and a global colour table sized to the palette", () => {
    const frames = twoFrameFixture();
    const gif = parseGif(encodeGif(frames));

    expect(gif.magic).toBe("GIF89a");
    expect(gif.width).toBe(3);
    expect(gif.height).toBe(2);
    expect(gif.hasGlobalTable).toBe(true);

    // 3 opaque colours + 1 transparent slot = 4 entries -> 2 bits -> table of 4
    expect(gif.tableBits).toBe(2);
    expect(gif.table.length).toBe(4);

    // the table holds the distinct colours in first-seen order
    expect(gif.table[0]).toEqual([R[0], R[1], R[2]]);
    expect(gif.table[1]).toEqual([G[0], G[1], G[2]]);
    expect(gif.table[2]).toEqual([B[0], B[1], B[2]]);
  });

  it("emits the NETSCAPE2.0 loop-forever extension exactly once", () => {
    const gif = parseGif(encodeGif(twoFrameFixture()));
    expect(gif.netscapePresent).toBe(true);
    expect(gif.netscapeLoop).toBe(0); // 0 = loop forever
  });

  it("per-frame graphics control carries the delay in centiseconds, disposal 2, and the frame count matches", () => {
    const frames = twoFrameFixture();
    const gif = parseGif(encodeGif(frames));

    expect(gif.frames.length).toBe(frames.length);
    expect(gif.frames[0]!.delayCs).toBe(12); // 120 ms
    expect(gif.frames[1]!.delayCs).toBe(4); // 40 ms
    for (const f of gif.frames) {
      expect(f.disposal).toBe(2); // restore to background
      expect(f.left).toBe(0);
      expect(f.top).toBe(0);
      expect(f.width).toBe(3);
      expect(f.height).toBe(2);
    }
  });

  it("clamps very short delays up to the 2 cs floor", () => {
    const one = [{ raster: raster(1, 1, [R]), delayMs: 5 }];
    const gif = parseGif(encodeGif(one));
    expect(gif.frames[0]!.delayCs).toBe(2);
  });

  it("sets the transparent-colour index when any pixel has alpha < 128", () => {
    const frames = twoFrameFixture();
    const gif = parseGif(encodeGif(frames));
    const { transparentIndex } = expectedPalette(frames);
    expect(transparentIndex).toBe(3); // slot after the 3 opaque colours
    for (const f of gif.frames) {
      expect(f.transparentFlag).toBe(true);
      expect(f.transparentIndex).toBe(transparentIndex);
    }
  });

  it("a fully-opaque input reserves NO transparent index", () => {
    const frames: GifFrame[] = [{ raster: raster(2, 1, [R, G]), delayMs: 100 }];
    const gif = parseGif(encodeGif(frames));
    expect(gif.frames[0]!.transparentFlag).toBe(false);
  });

  it("ends with the 0x3B trailer as the very last byte", () => {
    const bytes = encodeGif(twoFrameFixture());
    expect(bytes[bytes.length - 1]).toBe(0x3b);
    expect(parseGif(bytes).trailerSeen).toBe(true);
  });

  it("rejects an empty frame list", () => {
    expect(() => encodeGif([])).toThrow(/no frames/);
  });
});

describe("encodeGif LZW round-trip (test-side decoder)", () => {
  it("decodes every frame back to the exact per-pixel palette indices (multi-frame with transparency)", () => {
    const frames = twoFrameFixture();
    const gif = parseGif(encodeGif(frames));
    const { indexOf, transparentIndex } = expectedPalette(frames);

    for (let fi = 0; fi < frames.length; fi++) {
      const src = frames[fi]!.raster;
      const want = new Uint8Array(src.width * src.height);
      for (let p = 0, q = 0; p < src.data.length; p += 4, q++) {
        want[q] =
          src.data[p + 3]! < 128
            ? transparentIndex
            : indexOf.get((src.data[p]! << 16) | (src.data[p + 1]! << 8) | src.data[p + 2]!)!;
      }
      expect(gif.frames[fi]!.indices).toEqual(want);
    }
  });

  it("round-trips a larger many-colour frame (exercises LZW code-width growth) pixel-for-pixel via the colour table", () => {
    // deterministic pseudo-random 32x32 frame drawing from 40 distinct colours
    let seed = 0x12345678;
    const rand = (): number => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed;
    };
    const colors: Array<[number, number, number, number]> = [];
    for (let i = 0; i < 40; i++) colors.push([(i * 6 + 5) & 0xff, (i * 11 + 3) & 0xff, (i * 17 + 9) & 0xff, 255]);
    const pxs: Array<[number, number, number, number]> = [];
    for (let i = 0; i < 32 * 32; i++) pxs.push(colors[rand() % 40]!);
    const src = raster(32, 32, pxs);

    const gif = parseGif(encodeGif([{ raster: src, delayMs: 50 }]));
    const decoded = gif.frames[0]!;
    expect(decoded.indices.length).toBe(32 * 32);
    for (let q = 0; q < decoded.indices.length; q++) {
      const rgb = gif.table[decoded.indices[q]!]!;
      expect(rgb).toEqual([src.data[q * 4]!, src.data[q * 4 + 1]!, src.data[q * 4 + 2]!]);
    }
  });

  it("handles the 256-distinct-colour maximum (8-bit codes) without loss", () => {
    // 16x16, every pixel a distinct colour: exactly 256 opaque colours, no transparency
    const pxs: Array<[number, number, number, number]> = [];
    for (let i = 0; i < 256; i++) pxs.push([i, (i * 2) & 0xff, 255 - i, 255]);
    const src = raster(16, 16, pxs);
    const gif = parseGif(encodeGif([{ raster: src, delayMs: 100 }]));
    expect(gif.tableBits).toBe(8);
    expect(gif.table.length).toBe(256);
    const decoded = gif.frames[0]!.indices;
    for (let q = 0; q < 256; q++) {
      expect(gif.table[decoded[q]!]).toEqual([pxs[q]![0], pxs[q]![1], pxs[q]![2]]);
    }
  });
});

describe("encodeGif >256-colour overflow", () => {
  it("throws when the distinct opaque colours exceed 256", () => {
    const pxs: Array<[number, number, number, number]> = [];
    for (let i = 0; i < 257; i++) pxs.push([i & 0xff, i >> 8, 0, 255]);
    expect(() => encodeGif([{ raster: raster(257, 1, pxs), delayMs: 100 }])).toThrow(/exceeds 256/);
  });

  it("throws when 256 opaque colours + the reserved transparent slot overflow the table", () => {
    const pxs: Array<[number, number, number, number]> = [];
    for (let i = 0; i < 256; i++) pxs.push([i, 0, 0, 255]);
    pxs.push(T); // forces a 257th (transparent) palette slot
    expect(() => encodeGif([{ raster: raster(257, 1, pxs), delayMs: 100 }])).toThrow(/exceeds 256/);
  });
});

describe("quantizedToRaster", () => {
  const prepared = preparePalette(javaMapPalette as unknown as MapPalette);

  it("maps each mapColorId to its palette RGB with alpha 255", () => {
    const a = prepared.entries[0]!.color;
    const b = prepared.entries[7]!.color;
    const q: QuantizedFrame = {
      width: 2,
      height: 1,
      mapColorId: Uint8Array.from([a.mapColorId, b.mapColorId]),
      paletteIndex: Int32Array.from([0, 7]),
    };
    const r = quantizedToRaster(q);
    expect(r.width).toBe(2);
    expect(r.height).toBe(1);
    expect(px(r, 0, 0)).toEqual([a.r, a.g, a.b, 255]);
    expect(px(r, 1, 0)).toEqual([b.r, b.g, b.b, 255]);
  });

  it("an id with no palette entry falls back to opaque black", () => {
    let unknownId = -1;
    for (let id = 0; id < 256; id++) {
      if (MAP_RGB[id] === undefined) {
        unknownId = id;
        break;
      }
    }
    expect(unknownId).toBeGreaterThanOrEqual(0);
    const q: QuantizedFrame = {
      width: 1,
      height: 1,
      mapColorId: Uint8Array.from([unknownId]),
      paletteIndex: Int32Array.from([0]),
    };
    expect(px(quantizedToRaster(q), 0, 0)).toEqual([0, 0, 0, 255]);
  });
});

describe("flatVolumeToRaster", () => {
  // pick two real map colour ids so expected RGB comes from the actual palette
  const ids = MAP_RGB.map((rgb, id) => (rgb ? id : -1)).filter((id) => id >= 0);
  const A = ids[0]!;
  const B = ids[1]!;
  const C = ids[2]!;
  const D = ids[3]!;

  it("frontmost (smallest z) non-air voxel wins; deeper voxels show through air; air stays transparent", () => {
    const v = createVolume(2, 2, 2);
    setVoxel(v, 0, 1, 0, A); // top-left, front
    setVoxel(v, 0, 0, 0, B); // bottom-left, front...
    setVoxel(v, 0, 0, 1, C); // ...hides this back voxel
    setVoxel(v, 1, 0, 1, D); // bottom-right: front is air, back voxel shows
    // (1, 1, *) left fully air

    const r = flatVolumeToRaster(v);
    expect(r.width).toBe(2);
    expect(r.height).toBe(2);

    // world-Y un-flip: raster row 0 (top) = highest world y
    expect(px(r, 0, 0)).toEqual([...MAP_RGB[A]!, 255]); // y=1 -> top row
    expect(px(r, 0, 1)).toEqual([...MAP_RGB[B]!, 255]); // front B wins over back C
    expect(px(r, 1, 1)).toEqual([...MAP_RGB[D]!, 255]); // seen through front air
    expect(px(r, 1, 0)).toEqual([0, 0, 0, 0]); // all-air column -> transparent
  });

  it("a single voxel at the top of a tall volume lands on raster row 0", () => {
    const v = createVolume(1, 3, 1);
    setVoxel(v, 0, 2, 0, A); // highest world y
    const r = flatVolumeToRaster(v);
    expect(px(r, 0, 0)).toEqual([...MAP_RGB[A]!, 255]);
    expect(px(r, 0, 1)[3]).toBe(0);
    expect(px(r, 0, 2)[3]).toBe(0);
  });
});

describe("upscaleNearest", () => {
  it("scale 3 replicates each source pixel into a crisp 3x3 block", () => {
    const src = raster(2, 1, [R, B]);
    const up = upscaleNearest(src, 3);
    expect(up.width).toBe(6);
    expect(up.height).toBe(3);
    for (let y = 0; y < 3; y++) {
      for (let x = 0; x < 6; x++) {
        expect(px(up, x, y)).toEqual(x < 3 ? R : B);
      }
    }
  });

  it("scale 1 returns the source raster unchanged (same object)", () => {
    const src = raster(1, 1, [G]);
    expect(upscaleNearest(src, 1)).toBe(src);
  });

  it("non-integer and sub-1 scales floor/clamp (2.9 -> 2, 0 -> 1)", () => {
    const src = raster(1, 1, [G]);
    expect(upscaleNearest(src, 2.9).width).toBe(2);
    expect(upscaleNearest(src, 0)).toBe(src);
  });
});

describe("fitScale", () => {
  it("lands the longest side near the target with an integer scale", () => {
    expect(fitScale(10, 20, 384)).toBe(19); // 20 * 19 = 380 <= 384
    expect(fitScale(96, 96)).toBe(4); // default target 384: 96 * 4 = 384
  });

  it("never scales below 1 even when the raster already exceeds the target", () => {
    expect(fitScale(500, 100, 384)).toBe(1);
  });
});

describe("padRaster", () => {
  it("centres a smaller raster inside a transparent frame", () => {
    const src = raster(1, 1, [R]);
    const out = padRaster(src, 4, 3);
    expect(out.width).toBe(4);
    expect(out.height).toBe(3);
    for (let y = 0; y < 3; y++) {
      for (let x = 0; x < 4; x++) {
        // ox = (4-1)>>1 = 1, oy = (3-1)>>1 = 1
        expect(px(out, x, y)).toEqual(x === 1 && y === 1 ? R : [0, 0, 0, 0]);
      }
    }
  });

  it("even-into-odd centring keeps the content contiguous and centred", () => {
    const src = raster(2, 2, [R, G, B, R]);
    const out = padRaster(src, 5, 5);
    // ox = (5-2)>>1 = 1, oy = 1: content occupies x 1..2, y 1..2
    expect(px(out, 1, 1)).toEqual(R);
    expect(px(out, 2, 1)).toEqual(G);
    expect(px(out, 1, 2)).toEqual(B);
    expect(px(out, 2, 2)).toEqual(R);
    expect(px(out, 0, 0)[3]).toBe(0);
    expect(px(out, 4, 4)[3]).toBe(0);
    expect(px(out, 3, 1)[3]).toBe(0);
  });

  it("same-size padding is a no-op returning the source object", () => {
    const src = raster(2, 1, [R, G]);
    expect(padRaster(src, 2, 1)).toBe(src);
  });
});
