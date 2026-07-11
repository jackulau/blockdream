// Pixel-media export: save the block/pixel output as a PNG (still) or an animated GIF (a video,
// an imported GIF, or a baked 3D spin - all rendered block-for-block). This is the "download the
// animation in pixel format" path, distinct from the Minecraft-datapack export.
//
// The block output is already quantized to <=256 Minecraft map colours, so a paletted GIF is a
// lossless, tiny fit - and the encoder is written from scratch (GIF89a + LZW) so nothing is fetched
// from a CDN, honouring the "everything runs locally" constraint (a strict offline page).

import { preparePalette, type QuantizedFrame } from "@blockdream/color-core";
import javaMapPalette from "@blockdream/palette/data/java-map-colors-1.21.9.json";
import type { MapPalette } from "@blockdream/palette";
import type { VoxelVolume } from "@blockdream/voxel";

const AIR = 255; // VoxelVolume air sentinel (EMPTY in @blockdream/voxel)

// mapColorId -> [r,g,b], built once from the prepared map palette (every usable shade carries its id).
const MAP_RGB: Array<[number, number, number] | undefined> = (() => {
  const table = new Array<[number, number, number] | undefined>(256);
  for (const e of preparePalette(javaMapPalette as unknown as MapPalette).entries) {
    table[e.color.mapColorId] = [e.color.r, e.color.g, e.color.b];
  }
  return table;
})();

/** An RGBA raster (row-major, 4 bytes/px) - the common currency between renderers and the encoders. */
export interface Raster {
  width: number;
  height: number;
  data: Uint8ClampedArray; // length width*height*4
}

/** A block-art frame (map-palette quantized) -> opaque RGBA. Every pixel is a placed block's colour. */
export function quantizedToRaster(q: QuantizedFrame): Raster {
  const data = new Uint8ClampedArray(q.width * q.height * 4);
  for (let p = 0; p < q.width * q.height; p++) {
    const rgb = MAP_RGB[q.mapColorId[p]!] ?? [0, 0, 0];
    const o = p * 4;
    data[o] = rgb[0];
    data[o + 1] = rgb[1];
    data[o + 2] = rgb[2];
    data[o + 3] = 255;
  }
  return { width: q.width, height: q.height, data };
}

/**
 * Orthographic FRONT projection of a VoxelVolume -> RGBA, upright. For each (x,y) column we take the
 * frontmost non-air voxel (smallest z; z=0 is the front face) - so a flat slab shows its face AND a
 * spun solid shows its visible surface as it rotates (a fixed z=0 slice would be mostly air once
 * rotated). imageToFlat flips image-row 0 to the TOP of the volume (world Y up), so we read world
 * y = sy-1-iy to un-flip back to an upright picture. Air columns stay transparent, so an imported
 * GIF's transparency survives into the exported GIF.
 */
export function flatVolumeToRaster(v: VoxelVolume): Raster {
  const w = v.sx;
  const h = v.sy;
  const zStride = v.sx * v.sy;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let iy = 0; iy < h; iy++) {
    const wy = h - 1 - iy;
    for (let ix = 0; ix < w; ix++) {
      const col = ix + v.sx * wy;
      let id = AIR;
      for (let z = 0; z < v.sz; z++) {
        const c = v.data[col + z * zStride]!;
        if (c !== AIR) {
          id = c;
          break;
        }
      }
      if (id === AIR) continue; // leave transparent (alpha 0)
      const rgb = MAP_RGB[id] ?? [0, 0, 0];
      const o = (iy * w + ix) * 4;
      data[o] = rgb[0];
      data[o + 1] = rgb[1];
      data[o + 2] = rgb[2];
      data[o + 3] = 255;
    }
  }
  return { width: w, height: h, data };
}

/** Integer nearest-neighbour upscale so a small block grid exports as crisp, chunky pixels (never blurry). */
export function upscaleNearest(src: Raster, scale: number): Raster {
  const s = Math.max(1, Math.floor(scale));
  if (s === 1) return src;
  const w = src.width * s;
  const h = src.height * s;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const sy = (y / s) | 0;
    for (let x = 0; x < w; x++) {
      const sx = (x / s) | 0;
      const si = (sy * src.width + sx) * 4;
      const di = (y * w + x) * 4;
      data[di] = src.data[si]!;
      data[di + 1] = src.data[si + 1]!;
      data[di + 2] = src.data[si + 2]!;
      data[di + 3] = src.data[si + 3]!;
    }
  }
  return { width: w, height: h, data };
}

/** Pick an integer upscale that lands the longest side near `target` (crisp, bounded file size). */
export function fitScale(width: number, height: number, target = 384): number {
  return Math.max(1, Math.floor(target / Math.max(width, height)));
}

/** Center a raster inside a transparent W×H frame. A GIF needs every frame the same size, but a spin
 *  or block-motion sequence can vary per frame - padding to the common bound keeps the animation stable. */
export function padRaster(src: Raster, w: number, h: number): Raster {
  if (src.width === w && src.height === h) return src;
  const data = new Uint8ClampedArray(w * h * 4);
  const ox = ((w - src.width) >> 1) | 0;
  const oy = ((h - src.height) >> 1) | 0;
  for (let y = 0; y < src.height; y++) {
    const dy = y + oy;
    if (dy < 0 || dy >= h) continue;
    for (let x = 0; x < src.width; x++) {
      const dx = x + ox;
      if (dx < 0 || dx >= w) continue;
      const si = (y * src.width + x) * 4;
      const di = (dy * w + dx) * 4;
      data[di] = src.data[si]!;
      data[di + 1] = src.data[si + 1]!;
      data[di + 2] = src.data[si + 2]!;
      data[di + 3] = src.data[si + 3]!;
    }
  }
  return { width: w, height: h, data };
}

// ---- byte buffer -------------------------------------------------------------------------------
class ByteBuf {
  private buf = new Uint8Array(4096);
  len = 0;
  private ensure(n: number): void {
    if (this.len + n <= this.buf.length) return;
    const nb = new Uint8Array(Math.max(this.buf.length * 2, this.len + n));
    nb.set(this.buf);
    this.buf = nb;
  }
  byte(b: number): void {
    this.ensure(1);
    this.buf[this.len++] = b & 0xff;
  }
  bytes(a: ArrayLike<number>): void {
    this.ensure(a.length);
    this.buf.set(a as Uint8Array, this.len);
    this.len += a.length;
  }
  u16(v: number): void {
    this.byte(v & 0xff);
    this.byte((v >> 8) & 0xff);
  }
  ascii(s: string): void {
    for (let i = 0; i < s.length; i++) this.byte(s.charCodeAt(i));
  }
  take(): Uint8Array {
    return this.buf.slice(0, this.len);
  }
}

// ---- GIF LZW (variable-length codes, LSB-first, 255-byte sub-blocks) ----------------------------
// Follows the classic omggif/spec ordering: emit the current code at the CURRENT width, then grow the
// width / issue a clear as the dictionary fills. Interoperable with every GIF decoder.
function lzwEncode(minCodeSize: number, indices: Uint8Array, out: ByteBuf): void {
  const clearCode = 1 << minCodeSize;
  const eoiCode = clearCode + 1;
  out.byte(minCodeSize);

  let codeSize = minCodeSize + 1;
  let dict = new Map<number, number>();
  let next = eoiCode + 1;

  let accum = 0;
  let nbits = 0;
  const sub: number[] = [];
  const flushSub = (): void => {
    if (sub.length) {
      out.byte(sub.length);
      out.bytes(sub);
      sub.length = 0;
    }
  };
  const emit = (code: number): void => {
    accum |= code << nbits;
    nbits += codeSize;
    while (nbits >= 8) {
      sub.push(accum & 0xff);
      accum >>= 8;
      nbits -= 8;
      if (sub.length === 255) flushSub();
    }
  };

  emit(clearCode);
  let cur = indices[0]!;
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i]!;
    const key = (cur << 8) | k; // unique: k < 256, cur <= 4095
    const found = dict.get(key);
    if (found !== undefined) {
      cur = found;
      continue;
    }
    emit(cur);
    if (next === 4096) {
      emit(clearCode);
      dict = new Map();
      next = eoiCode + 1;
      codeSize = minCodeSize + 1;
    } else {
      if (next >= 1 << codeSize && codeSize < 12) codeSize++;
      dict.set(key, next++);
    }
    cur = k;
  }
  emit(cur);
  emit(eoiCode);
  if (nbits > 0) sub.push(accum & 0xff);
  flushSub();
  out.byte(0); // image-data block terminator
}

/** One RGBA frame ready to encode, with its on-screen dwell time. */
export interface GifFrame {
  raster: Raster;
  delayMs: number;
}

/**
 * Encode RGBA frames to a looping animated GIF89a. The frames share ONE global colour table built
 * from the distinct opaque colours actually used (block content is <=248 map colours, so it always
 * fits). Any pixel with alpha < 128 maps to a reserved transparent index.
 */
export function encodeGif(frames: GifFrame[]): Uint8Array {
  if (!frames.length) throw new Error("encodeGif: no frames");
  const { width, height } = frames[0]!.raster;

  // gather distinct opaque colours -> palette index
  const colorIndex = new Map<number, number>();
  const palette: number[] = []; // flat r,g,b
  let hasAlpha = false;
  for (const { raster } of frames) {
    const d = raster.data;
    for (let p = 0; p < d.length; p += 4) {
      if (d[p + 3]! < 128) {
        hasAlpha = true;
        continue;
      }
      const key = (d[p]! << 16) | (d[p + 1]! << 8) | d[p + 2]!;
      if (!colorIndex.has(key)) {
        colorIndex.set(key, palette.length / 3);
        palette.push(d[p]!, d[p + 1]!, d[p + 2]!);
      }
    }
  }
  const transparentIndex = hasAlpha ? palette.length / 3 : -1;
  if (hasAlpha) palette.push(0, 0, 0); // dummy slot for the transparent index
  const nColors = Math.max(2, palette.length / 3);
  if (nColors > 256) throw new Error(`encodeGif: ${nColors} colours exceeds 256`);

  let bits = 1;
  while (1 << bits < nColors) bits++; // color-table size = 2^bits
  const tableSize = 1 << bits;
  const minCodeSize = Math.max(2, bits);

  const out = new ByteBuf();
  out.ascii("GIF89a");
  out.u16(width);
  out.u16(height);
  out.byte(0x80 | ((bits - 1) << 4) | (bits - 1)); // global table, color res, table size
  out.byte(0); // background color index
  out.byte(0); // pixel aspect ratio

  // global color table (padded to tableSize)
  for (let i = 0; i < tableSize; i++) {
    out.byte(palette[i * 3] ?? 0);
    out.byte(palette[i * 3 + 1] ?? 0);
    out.byte(palette[i * 3 + 2] ?? 0);
  }

  // NETSCAPE2.0 loop-forever extension
  out.byte(0x21);
  out.byte(0xff);
  out.byte(11);
  out.ascii("NETSCAPE2.0");
  out.byte(3);
  out.byte(1);
  out.u16(0); // 0 = loop forever
  out.byte(0);

  const idx = new Uint8Array(width * height);
  for (const { raster, delayMs } of frames) {
    // graphics control: disposal 2 (restore to bg) so transparent areas don't accumulate
    const delayCs = Math.max(2, Math.round(delayMs / 10));
    out.byte(0x21);
    out.byte(0xf9);
    out.byte(4);
    out.byte((2 << 2) | (transparentIndex >= 0 ? 1 : 0));
    out.u16(delayCs);
    out.byte(transparentIndex >= 0 ? transparentIndex : 0);
    out.byte(0);

    // image descriptor (full frame, no local table)
    out.byte(0x2c);
    out.u16(0);
    out.u16(0);
    out.u16(width);
    out.u16(height);
    out.byte(0);

    const d = raster.data;
    for (let p = 0, q = 0; p < d.length; p += 4, q++) {
      if (d[p + 3]! < 128) {
        idx[q] = transparentIndex >= 0 ? transparentIndex : 0;
      } else {
        idx[q] = colorIndex.get((d[p]! << 16) | (d[p + 1]! << 8) | d[p + 2]!)!;
      }
    }
    lzwEncode(minCodeSize, idx, out);
  }

  out.byte(0x3b); // trailer
  return out.take();
}

// ---- PNG (via canvas) + download ---------------------------------------------------------------

/** Draw a raster onto a fresh 2D canvas (used for PNG encoding + preview). */
function rasterToCanvas(r: Raster): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = r.width;
  c.height = r.height;
  const ctx = c.getContext("2d")!;
  const img = ctx.createImageData(r.width, r.height);
  img.data.set(r.data);
  ctx.putImageData(img, 0, 0);
  return c;
}

/** Trigger a browser download of raw bytes under `name` with the given MIME type. */
export function downloadBlob(name: string, bytes: Uint8Array, mime: string): void {
  const blob = new Blob([new Uint8Array(bytes)], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Encode a raster to a PNG blob and download it (transparency preserved). */
export async function downloadPng(name: string, raster: Raster): Promise<void> {
  const canvas = rasterToCanvas(raster);
  const blob: Blob | null = await new Promise((res) => canvas.toBlob(res, "image/png"));
  if (!blob) throw new Error("PNG encode failed");
  downloadBlob(name, new Uint8Array(await blob.arrayBuffer()), "image/png");
}

/** Encode frames to an animated GIF and download it. */
export function downloadGif(name: string, frames: GifFrame[]): void {
  downloadBlob(name, encodeGif(frames), "image/gif");
}
