import {
  linearRgbToOklab,
  srgbChannelToLinear,
  linearToSrgbChannel,
} from "./oklab";
import { nearestByLab, nearestByLabHue, lutNearest, type PreparedPalette, type RgbLut } from "./match";
import type { RgbImage, QuantizedFrame } from "./image";

export type DitherMethod = "none" | "floyd-steinberg" | "bayer";

// Match-memo warmup: after this many memoized pixels, if fewer than a quarter were repeats,
// the frame is too high-entropy for the cache to pay off, so we drop it and match directly for
// the rest. Purely a perf knob — both the memoized and direct paths return the same index, so
// any value here is byte-identical.
const MEMO_WARMUP = 1 << 12; // 4096 pixels

// Module-local copy of the sRGB->linear decode table, built ONCE from the imported function (so
// every double is identical by construction). The bayer/nearest/hysteresis hot loops read 8-bit
// channels straight out of a Uint8Array, so a plain `SRGB_LIN[c]` load replaces a per-pixel
// imported-function call: vite-node compiles imported-binding reads to getter calls (goal-087
// lesson), and even in plain node this drops a call per channel. Only valid for integer 0..255
// inputs - exactly what a Uint8Array yields.
const SRGB_LIN = (() => {
  const t = new Float64Array(256);
  for (let c = 0; c < 256; c++) t[c] = srgbChannelToLinear(c);
  return t;
})();

export interface QuantizeOptions {
  method?: DitherMethod;
  /** Bayer ordered-dither amplitude in linear light (default 0.06). */
  bayerAmplitude?: number;
  /** Optional prebuilt LUT (buildRgbLut) for O(1)/pixel matching - the fast path. */
  lut?: RgbLut;
  /**
   * Gamut-map by hue: when set (the hue-penalty λ, e.g. 0.8), out-of-gamut
   * saturated colors keep their hue instead of going muddy. Overrides the LUT
   * (the hue-penalized search is exact). Best for stills/hero quality.
   */
  gamutMap?: number;
  /**
   * Live-cast temporal skip: the previous frame's RGB image + its quantized result. When BOTH are
   * supplied (and dimensions match), a pixel whose input RGB equals the previous frame's at the same
   * position copies the previous palette index instead of re-running the O(palette) match. Byte-
   * identical for the position-deterministic dithers (bayer/none): the chosen index is a pure
   * function of (r,g,b,bayerCell) and the palette/amplitude/gamut are frame-constant, so the copied
   * index equals a freshly-matched one. A screencast is ~97% temporally static, so this skips nearly
   * the whole frame. Ignored by floyd-steinberg (error diffusion is not position-deterministic).
   * Absent => every pixel is matched exactly as before (all non-live callers stay byte-unchanged).
   */
  prevImage?: RgbImage;
  prevQuantized?: QuantizedFrame;
}

/** Whether a temporal skip is usable: both prev buffers present and all dimensions match `img`. */
function temporalUsable(img: RgbImage, prevImage?: RgbImage, prevQuantized?: QuantizedFrame): boolean {
  return (
    !!prevImage &&
    !!prevQuantized &&
    prevImage.width === img.width &&
    prevImage.height === img.height &&
    prevQuantized.width === img.width &&
    prevQuantized.height === img.height
  );
}

/** Nearest palette index for a linear-RGB triple - gamut-mapped, LUT (fast), or exact OKLab. */
function matchLinear(lr: number, lg: number, lb: number, pal: PreparedPalette, lut?: RgbLut, gamutMap?: number): number {
  if (gamutMap !== undefined) {
    return nearestByLabHue(linearRgbToOklab(lr, lg, lb), pal, gamutMap).index;
  }
  if (lut) {
    return lutNearest(lut, linearToSrgbChannel(lr), linearToSrgbChannel(lg), linearToSrgbChannel(lb));
  }
  return nearestByLab(linearRgbToOklab(lr, lg, lb), pal).index;
}

/** Convert a packed sRGB image to a float linear-light working buffer (0..1). */
function toLinearBuffer(img: RgbImage): Float64Array {
  const n = img.width * img.height * 3;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = srgbChannelToLinear(img.data[i]!);
  return out;
}

function emptyFrame(img: RgbImage): QuantizedFrame {
  const px = img.width * img.height;
  return {
    width: img.width,
    height: img.height,
    paletteIndex: new Int32Array(px),
    mapColorId: new Uint8Array(px),
  };
}

function writePixel(frame: QuantizedFrame, p: number, entryIndex: number, mapColorId: number): void {
  frame.paletteIndex[p] = entryIndex;
  frame.mapColorId[p] = mapColorId;
}

/**
 * Match each pixel to the nearest palette color in OKLab. No dithering.
 * Pass a prebuilt `lut` (buildRgbLut) for O(1)/pixel matching - the fast path
 * for real-time/video; without it, exact brute-force OKLab match.
 */
export function quantizeNearest(
  img: RgbImage,
  pal: PreparedPalette,
  lut?: RgbLut,
  gamutMap?: number,
  prevImage?: RgbImage,
  prevQuantized?: QuantizedFrame,
): QuantizedFrame {
  const frame = emptyFrame(img);
  const px = img.width * img.height;
  // Temporal skip: copy the prior index where this pixel's RGB is unchanged (byte-identical, see
  // QuantizeOptions). The match is a pure function of (r,g,b), so an unchanged pixel re-matches the
  // same index. Skipped pixels never touch the memo accounting; matched pixels are unaffected.
  const temporal = temporalUsable(img, prevImage, prevQuantized);
  const pImg = temporal ? prevImage!.data : null;
  const pIdx = temporal ? prevQuantized!.paletteIndex : null;
  // Exact memo for the brute-force path: with no LUT the match is a pure function of (r,g,b)
  // (gamutMap is frame-constant), so repeated colors reuse the result and skip the O(palette)
  // OKLab search. Byte-identical. The LUT path is already O(1)/pixel, so it skips the memo.
  const useLut = gamutMap === undefined && !!lut;
  // one tiny per-frame array (~244 doubles) for the gamut path, never per-pixel
  const sortedHue = gamutMap !== undefined ? buildSortedHue(pal) : null;
  // exact brute-force match - a pure function of (r,g,b) since gamutMap is frame-constant.
  // Dispatched through the allocation-free scratch matchers (bit-identical to the allocating
  // nearestByLab/nearestByLabHue; locked against quantizeNearestReference by dither-perf.test.ts).
  const match = (r: number, g: number, b: number): number => {
    linearToLabScratch(SRGB_LIN[r]!, SRGB_LIN[g]!, SRGB_LIN[b]!);
    return gamutMap === undefined ? nearestIdxByLab(labL, labA, labB, pal) : nearestIdxByLabHue(labL, labA, labB, pal, gamutMap, sortedHue!);
  };
  // Memo: repeated colors reuse the result and skip the O(palette) OKLab search (byte-identical).
  // Adaptive — if a warmup window shows few repeats, drop the memo so a high-entropy frame pays
  // no Map overhead. The LUT path is already O(1)/pixel and skips the memo entirely.
  const memo = useLut ? null : new Map<number, number>();
  let memoOn = memo !== null;
  let tried = 0;
  let hits = 0;
  for (let p = 0; p < px; p++) {
    const i = p * 3;
    const r = img.data[i]!;
    const g = img.data[i + 1]!;
    const b = img.data[i + 2]!;
    if (pImg && r === pImg[i]! && g === pImg[i + 1]! && b === pImg[i + 2]!) {
      const idx = pIdx![p]!; // re-matching would return this same index (pure function of r,g,b)
      writePixel(frame, p, idx, pal.entries[idx]!.color.mapColorId);
      continue;
    }
    let index: number;
    if (useLut) {
      index = lutNearest(lut!, r, g, b);
    } else if (memoOn) {
      const key = (r << 16) | (g << 8) | b;
      const hit = memo!.get(key);
      if (hit !== undefined) {
        index = hit;
        hits++;
      } else {
        index = match(r, g, b);
        memo!.set(key, index);
      }
      if (++tried === MEMO_WARMUP && hits * 4 < MEMO_WARMUP) memoOn = false; // <25% repeats → drop it
    } else {
      index = match(r, g, b);
    }
    writePixel(frame, p, index, pal.entries[index]!.color.mapColorId);
  }
  return frame;
}

/**
 * Reference nearest-quantizer, kept verbatim from before the scratch-matcher dispatch: the
 * memo-miss/memo-off match allocates a fresh {L,a,b} and {index,color,dist2} per pixel via
 * nearestByLab/nearestByLabHue. Exported only for the same-run opt-vs-ref A/B in
 * dither-perf.test.ts. Do not optimize.
 */
export function quantizeNearestReference(
  img: RgbImage,
  pal: PreparedPalette,
  lut?: RgbLut,
  gamutMap?: number,
  prevImage?: RgbImage,
  prevQuantized?: QuantizedFrame,
): QuantizedFrame {
  const frame = emptyFrame(img);
  const px = img.width * img.height;
  const temporal = temporalUsable(img, prevImage, prevQuantized);
  const pImg = temporal ? prevImage!.data : null;
  const pIdx = temporal ? prevQuantized!.paletteIndex : null;
  const useLut = gamutMap === undefined && !!lut;
  const match = (r: number, g: number, b: number): number => {
    const lab = linearRgbToOklab(srgbChannelToLinear(r), srgbChannelToLinear(g), srgbChannelToLinear(b));
    return gamutMap === undefined ? nearestByLab(lab, pal).index : nearestByLabHue(lab, pal, gamutMap).index;
  };
  const memo = useLut ? null : new Map<number, number>();
  let memoOn = memo !== null;
  let tried = 0;
  let hits = 0;
  for (let p = 0; p < px; p++) {
    const i = p * 3;
    const r = img.data[i]!;
    const g = img.data[i + 1]!;
    const b = img.data[i + 2]!;
    if (pImg && r === pImg[i]! && g === pImg[i + 1]! && b === pImg[i + 2]!) {
      const idx = pIdx![p]!;
      writePixel(frame, p, idx, pal.entries[idx]!.color.mapColorId);
      continue;
    }
    let index: number;
    if (useLut) {
      index = lutNearest(lut!, r, g, b);
    } else if (memoOn) {
      const key = (r << 16) | (g << 8) | b;
      const hit = memo!.get(key);
      if (hit !== undefined) {
        index = hit;
        hits++;
      } else {
        index = match(r, g, b);
        memo!.set(key, index);
      }
      if (++tried === MEMO_WARMUP && hits * 4 < MEMO_WARMUP) memoOn = false;
    } else {
      index = match(r, g, b);
    }
    writePixel(frame, p, index, pal.entries[index]!.color.mapColorId);
  }
  return frame;
}

// ---------------------------------------------------------------------------
// Floyd-Steinberg hot-path matchers (allocation-free).
//
// matchLinear -> linearRgbToOklab -> nearestByLab(/Hue) allocates a fresh {L,a,b} and a fresh
// {index,color,dist2} PER PIXEL. Floyd-Steinberg is the DEFAULT still-image quantizer (see
// quantizeFrame), so on the hero web path that is two short-lived objects per pixel of pure GC
// pressure. These twins run the SAME arithmetic in the SAME order (the OKLab constants are
// copied verbatim from oklab.ts and the L-band-prune walks verbatim from match.ts) but pass the
// OKLab triple through module scratch scalars and return only the index. Byte-identical, locked
// against quantizeFloydSteinbergReference by dither-perf.test.ts.
// ---------------------------------------------------------------------------

let labL = 0;
let labA = 0;
let labB = 0;

/** linearRgbToOklab with scratch-scalar output (identical constants and operation order). */
function linearToLabScratch(r: number, g: number, b: number): void {
  const l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
  const m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
  const s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;
  const l_ = Math.cbrt(l);
  const m_ = Math.cbrt(m);
  const s_ = Math.cbrt(s);
  labL = 0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_;
  labA = 1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_;
  labB = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_;
}

/** lowerBoundL twin (private in match.ts): lowest index p with sortedL[p] >= L. */
function lowerBound(pal: PreparedPalette, L: number): number {
  const sL = pal.sortedL;
  let lo = 0;
  let hi = pal.sortedOrigIdx.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sL[mid]! < L) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * nearestByLab with scalar query and index-only return (identical walk, no Match object).
 * `dL*dL` is computed once per entry (the reference computes it in both the break check and
 * dist2): same operands, same value, so dist2 is bit-identical.
 */
function nearestIdxByLab(qL: number, qa: number, qb: number, pal: PreparedPalette): number {
  const sL = pal.sortedL;
  const sA = pal.sortedA;
  const sB = pal.sortedB;
  const oi = pal.sortedOrigIdx;
  const n = oi.length;
  const start = lowerBound(pal, qL);
  let bestIdx = 0;
  let best = Infinity;
  for (let p = start; p < n; p++) {
    const dL = sL[p]! - qL;
    const dL2 = dL * dL;
    if (dL2 >= best) break;
    const da = sA[p]! - qa;
    const db = sB[p]! - qb;
    const d = dL2 + da * da + db * db;
    const k = oi[p]!;
    if (d < best || (d === best && k < bestIdx)) {
      best = d;
      bestIdx = k;
    }
  }
  for (let p = start - 1; p >= 0; p--) {
    const dL = qL - sL[p]!;
    const dL2 = dL * dL;
    if (dL2 >= best) break;
    const da = sA[p]! - qa;
    const db = sB[p]! - qb;
    const d = dL2 + da * da + db * db;
    const k = oi[p]!;
    if (d < best || (d === best && k < bestIdx)) {
      best = d;
      bestIdx = k;
    }
  }
  return bestIdx;
}

/**
 * hueDistance twin, module-LOCAL on purpose: it runs once per visited palette entry (millions of
 * times per frame), and a cross-module import compiles to an exports-object accessor lookup per
 * call under the ESM->CJS/SSR transforms, which both costs a getter invocation in the innermost
 * loop and blocks inlining.
 *
 * The `% (2 * Math.PI)` in match.ts's hueDistance is dropped: bit-identical here, and it was
 * MOST of the whole quantize (JS `%` on doubles is an fmod stub call, ~16M calls per 256px
 * frame). Proof: both arguments are Math.atan2 outputs in [-pi, pi], so d0 = |h1 - h2| lies in
 * [0, 2pi]. For d0 < 2pi, fmod is exact, so d0 % 2pi === d0 and the remaining branch is
 * untouched. For d0 === 2pi (only when the hues are exactly -pi and pi): with the fmod, d = +0
 * and the branch is skipped, returning +0; without it, d = 2pi > pi, returning 2pi - 2pi = +0.
 * Identical doubles in every case (atan2 never returns NaN/Infinity for finite inputs).
 */
function hueDist(h1: number, h2: number): number {
  let d = Math.abs(h1 - h2);
  if (d > Math.PI) d = 2 * Math.PI - d;
  return d;
}

/**
 * Per-FRAME hue array in L-sorted order: sortedHue[p] = entries[sortedOrigIdx[p]].hue, the same
 * doubles the reference reads through `pal.entries[k]!.hue`, but as stride-1 Float64Array loads
 * instead of an object-chain dereference per visited entry. Built once per quantize call (a
 * palette is ~244 entries; the walk visits entries millions of times per frame).
 */
function buildSortedHue(pal: PreparedPalette): Float64Array {
  const oi = pal.sortedOrigIdx;
  const out = new Float64Array(oi.length);
  for (let p = 0; p < oi.length; p++) out[p] = pal.entries[oi[p]!]!.hue;
  return out;
}

/**
 * nearestByLabHue with scalar query and index-only return (identical walk, no Match object).
 * Bit-exact hoists only: `dL*dL` is computed once per entry (same operands, same value), and
 * `lc = lambda * cT` is hoisted out of the walk: `lambda * cT * hd * hd` associates left, so
 * `((lambda*cT)*hd)*hd` performs the identical three multiplies either way.
 */
function nearestIdxByLabHue(qL: number, qa: number, qb: number, pal: PreparedPalette, lambda: number, sHue: Float64Array): number {
  const cT = Math.hypot(qa, qb);
  const hT = Math.atan2(qb, qa);
  const lc = lambda * cT;
  const sL = pal.sortedL;
  const sA = pal.sortedA;
  const sB = pal.sortedB;
  const oi = pal.sortedOrigIdx;
  const n = oi.length;
  const start = lowerBound(pal, qL);
  let bestIdx = 0;
  let bestPenalty = Infinity;
  for (let p = start; p < n; p++) {
    const dL = sL[p]! - qL;
    const dL2 = dL * dL;
    if (dL2 >= bestPenalty) break;
    const da = sA[p]! - qa;
    const db = sB[p]! - qb;
    const dist2 = dL2 + da * da + db * db;
    const k = oi[p]!;
    const hd = hueDist(hT, sHue[p]!);
    const penalty = dist2 + lc * hd * hd;
    if (penalty < bestPenalty || (penalty === bestPenalty && k < bestIdx)) {
      bestPenalty = penalty;
      bestIdx = k;
    }
  }
  for (let p = start - 1; p >= 0; p--) {
    const dL = qL - sL[p]!;
    const dL2 = dL * dL;
    if (dL2 >= bestPenalty) break;
    const da = sA[p]! - qa;
    const db = sB[p]! - qb;
    const dist2 = dL2 + da * da + db * db;
    const k = oi[p]!;
    const hd = hueDist(hT, sHue[p]!);
    const penalty = dist2 + lc * hd * hd;
    if (penalty < bestPenalty || (penalty === bestPenalty && k < bestIdx)) {
      bestPenalty = penalty;
      bestIdx = k;
    }
  }
  return bestIdx;
}

// Floyd-Steinberg diffusion weights. Same literals the reference passes to its diffuse closure,
// hoisted to constants so each write is the identical `cell += err * weight` float op.
const FS_W7 = 7 / 16;
const FS_W3 = 3 / 16;
const FS_W5 = 5 / 16;
const FS_W1 = 1 / 16;

/**
 * Floyd–Steinberg error diffusion. Matching happens in OKLab (perceptual);
 * error is computed and diffused in LINEAR light so gamma doesn't bias it.
 * Serpentine scan reduces directional worming artifacts.
 *
 * HOT LOOP: this is the default still-image quantizer, and at 512x512 with gamutMap the
 * reference shape was a visible UI stall. Two mechanical changes, no numeric ones:
 * (a) the per-neighbor diffuse closure (12 calls + 4 bounds comparisons each per pixel) is
 *     replaced by per-pixel hoisted validity flags and direct error-buffer writes, and
 * (b) the per-pixel {L,a,b}/{index,color,dist2} allocations in the match are replaced by the
 *     allocation-free scratch matchers above.
 * Every float op, its operands, and the cross-pixel write order are unchanged, so the diffused
 * error cascade is bit-exact. Byte-identical to quantizeFloydSteinbergReference (locked by
 * dither-perf.test.ts).
 */
export function quantizeFloydSteinberg(img: RgbImage, pal: PreparedPalette, lut?: RgbLut, gamutMap?: number): QuantizedFrame {
  const { width, height } = img;
  const frame = emptyFrame(img);
  const buf = toLinearBuffer(img); // mutated in place with diffused error
  // one tiny per-frame array (~244 doubles), never per-pixel
  const sortedHue = gamutMap !== undefined ? buildSortedHue(pal) : null;

  for (let y = 0; y < height; y++) {
    const leftToRight = y % 2 === 0;
    const xStart = leftToRight ? 0 : width - 1;
    const xEnd = leftToRight ? width : -1;
    const step = leftToRight ? 1 : -1;
    const rowBase = y * width;
    const downBase = rowBase + width;
    const hasDown = y + 1 < height;
    for (let x = xStart; x !== xEnd; x += step) {
      const p = rowBase + x;
      const i = p * 3;
      const lr = buf[i]!;
      const lg = buf[i + 1]!;
      const lb = buf[i + 2]!;
      // same dispatch order as matchLinear: gamutMap overrides the LUT, LUT beats brute force
      let index: number;
      if (gamutMap !== undefined) {
        linearToLabScratch(lr, lg, lb);
        index = nearestIdxByLabHue(labL, labA, labB, pal, gamutMap, sortedHue!);
      } else if (lut) {
        index = lutNearest(lut, linearToSrgbChannel(lr), linearToSrgbChannel(lg), linearToSrgbChannel(lb));
      } else {
        linearToLabScratch(lr, lg, lb);
        index = nearestIdxByLab(labL, labA, labB, pal);
      }
      const entry = pal.entries[index]!;
      const chosen = entry.lin;
      writePixel(frame, p, index, entry.color.mapColorId);

      const er = lr - chosen[0];
      const eg = lg - chosen[1];
      const eb = lb - chosen[2];

      // Neighbor validity, computed ONCE per pixel (the reference re-checks 4 bounds per diffuse
      // call, 12 calls per pixel). Forward is +step in x, behind is -step; only y+1 can leave the
      // image vertically. Writes keep the reference order (fwd(7/16), behind-down(3/16),
      // down(5/16), fwd-down(1/16), channels r,g,b within each neighbor), though each of the 12
      // targets is a distinct cell, so the per-cell accumulation order across pixels (the part
      // float addition cares about) is fixed by the serpentine scan either way.
      const xf = x + step;
      const xb = x - step;
      const fwdOk = xf >= 0 && xf < width;
      const backOk = xb >= 0 && xb < width;
      if (fwdOk) {
        const j = (rowBase + xf) * 3;
        buf[j]! += er * FS_W7;
        buf[j + 1]! += eg * FS_W7;
        buf[j + 2]! += eb * FS_W7;
      }
      if (hasDown) {
        if (backOk) {
          const j = (downBase + xb) * 3;
          buf[j]! += er * FS_W3;
          buf[j + 1]! += eg * FS_W3;
          buf[j + 2]! += eb * FS_W3;
        }
        const j = (downBase + x) * 3;
        buf[j]! += er * FS_W5;
        buf[j + 1]! += eg * FS_W5;
        buf[j + 2]! += eb * FS_W5;
        if (fwdOk) {
          const jf = (downBase + xf) * 3;
          buf[jf]! += er * FS_W1;
          buf[jf + 1]! += eg * FS_W1;
          buf[jf + 2]! += eb * FS_W1;
        }
      }
    }
  }
  return frame;
}

/**
 * Reference Floyd-Steinberg, kept verbatim from before the de-closuring/de-allocation
 * optimization: per-neighbor diffuse closure + allocating matchLinear per pixel. Exported only
 * for the same-run opt-vs-ref A/B in dither-perf.test.ts. Do not optimize.
 */
export function quantizeFloydSteinbergReference(img: RgbImage, pal: PreparedPalette, lut?: RgbLut, gamutMap?: number): QuantizedFrame {
  const { width, height } = img;
  const frame = emptyFrame(img);
  const buf = toLinearBuffer(img); // mutated in place with diffused error

  const diffuse = (x: number, y: number, c: number, err: number, w: number) => {
    if (x < 0 || x >= width || y < 0 || y >= height) return;
    buf[(y * width + x) * 3 + c]! += err * w;
  };

  for (let y = 0; y < height; y++) {
    const leftToRight = y % 2 === 0;
    const xStart = leftToRight ? 0 : width - 1;
    const xEnd = leftToRight ? width : -1;
    const step = leftToRight ? 1 : -1;
    for (let x = xStart; x !== xEnd; x += step) {
      const p = y * width + x;
      const i = p * 3;
      const lr = buf[i]!;
      const lg = buf[i + 1]!;
      const lb = buf[i + 2]!;
      const index = matchLinear(lr, lg, lb, pal, lut, gamutMap);
      const chosen = pal.entries[index]!.lin;
      writePixel(frame, p, index, pal.entries[index]!.color.mapColorId);

      const er = lr - chosen[0];
      const eg = lg - chosen[1];
      const eb = lb - chosen[2];

      // forward neighbor is +step in x
      const fwd = step;
      diffuse(x + fwd, y, 0, er, 7 / 16);
      diffuse(x + fwd, y, 1, eg, 7 / 16);
      diffuse(x + fwd, y, 2, eb, 7 / 16);
      diffuse(x - fwd, y + 1, 0, er, 3 / 16);
      diffuse(x - fwd, y + 1, 1, eg, 3 / 16);
      diffuse(x - fwd, y + 1, 2, eb, 3 / 16);
      diffuse(x, y + 1, 0, er, 5 / 16);
      diffuse(x, y + 1, 1, eg, 5 / 16);
      diffuse(x, y + 1, 2, eb, 5 / 16);
      diffuse(x + fwd, y + 1, 0, er, 1 / 16);
      diffuse(x + fwd, y + 1, 1, eg, 1 / 16);
      diffuse(x + fwd, y + 1, 2, eb, 1 / 16);
    }
  }
  return frame;
}

// 8×8 Bayer ordered-dither matrix base (0..63). Feeds both the flat hot-path table and the 2D
// table the verbatim reference twins index.
const BAYER8_BASE = [
  [0, 32, 8, 40, 2, 34, 10, 42],
  [48, 16, 56, 24, 50, 18, 58, 26],
  [12, 44, 4, 36, 14, 46, 6, 38],
  [60, 28, 52, 20, 62, 30, 54, 22],
  [3, 35, 11, 43, 1, 33, 9, 41],
  [51, 19, 59, 27, 49, 17, 57, 25],
  [15, 47, 7, 39, 13, 45, 5, 37],
  [63, 31, 55, 23, 61, 29, 53, 21],
];

// Flat hot-path table, normalized to (-0.5 .. +0.5) and indexed ((y & 7) << 3) | (x & 7): one
// typed-array load per pixel instead of two array-of-arrays derefs. IDENTICAL doubles to the 2D
// reference table below (same base integers, same `v / 64 - 0.5`).
const BAYER8 = (() => {
  const out = new Float64Array(64);
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) out[(y << 3) | x] = BAYER8_BASE[y]![x]! / 64 - 0.5;
  return out;
})();

// 2D table for the verbatim reference twins (the pre-optimization hot loops indexed [y&7][x&7]).
const BAYER8_REF = BAYER8_BASE.map((row) => row.map((v) => v / 64 - 0.5));

/**
 * Ordered (Bayer) dithering - fully deterministic per pixel position, which
 * makes it the most TEMPORALLY STABLE dither for video: a static region maps to
 * the same colors every frame, so there is no dither "crawl"/flicker.
 */
export function quantizeBayer(
  img: RgbImage,
  pal: PreparedPalette,
  amplitude = 0.06,
  lut?: RgbLut,
  gamutMap?: number,
  prevImage?: RgbImage,
  prevQuantized?: QuantizedFrame,
): QuantizedFrame {
  const { width, height } = img;
  const frame = emptyFrame(img);
  // Temporal skip: copy the prior index where this pixel's RGB is unchanged (byte-identical, see
  // QuantizeOptions). bayer is position-deterministic, so an unchanged pixel at the same (x,y) cell
  // re-matches the same index. Skipped pixels never touch the memo accounting.
  const temporal = temporalUsable(img, prevImage, prevQuantized);
  const pImg = temporal ? prevImage!.data : null;
  const pIdx = temporal ? prevQuantized!.paletteIndex : null;
  // Exact memo: bayer is position-deterministic, so the match is a pure function of
  // (r, g, b, bayerCell) (amplitude/gamutMap are frame-constant). Real frames repeat colors
  // within each of the 64 cells → skip the O(palette) match on repeats. Byte-identical.
  // Adaptive — drop the memo after a warmup window that shows few repeats so a high-entropy
  // frame pays no Map overhead. The LUT path is already O(1)/pixel, so it skips the memo.
  const memo = lut ? null : new Map<number, number>();
  let memoOn = memo !== null;
  let tried = 0;
  let hits = 0;
  // one tiny per-frame array (~244 doubles) for the gamut path, never per-pixel
  const sortedHue = gamutMap !== undefined ? buildSortedHue(pal) : null;
  // Same dispatch order as matchLinear (gamutMap overrides the LUT, LUT beats brute force), but
  // inlined in the loop and through the allocation-free scratch matchers: no per-pixel
  // {L,a,b}/{index,color,dist2}, no per-pixel closure call, and the sRGB decode is a module-local
  // table load. Bit-identical (locked against quantizeBayerReference by dither-perf.test.ts).
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      const i = p * 3;
      const r = img.data[i]!;
      const g = img.data[i + 1]!;
      const b = img.data[i + 2]!;
      if (pImg && r === pImg[i]! && g === pImg[i + 1]! && b === pImg[i + 2]!) {
        const idx = pIdx![p]!; // re-matching would return this same index (pure fn of r,g,b,cell)
        writePixel(frame, p, idx, pal.entries[idx]!.color.mapColorId);
        continue;
      }
      let index: number;
      if (memoOn) {
        const key = ((r << 16) | (g << 8) | b) * 64 + ((y & 7) << 3) + (x & 7);
        const hit = memo!.get(key);
        if (hit !== undefined) {
          index = hit;
          hits++;
        } else {
          const t = BAYER8[((y & 7) << 3) | (x & 7)]! * amplitude;
          const lr = SRGB_LIN[r]! + t;
          const lg = SRGB_LIN[g]! + t;
          const lb = SRGB_LIN[b]! + t;
          if (gamutMap !== undefined) {
            linearToLabScratch(lr, lg, lb);
            index = nearestIdxByLabHue(labL, labA, labB, pal, gamutMap, sortedHue!);
          } else if (lut) {
            index = lutNearest(lut, linearToSrgbChannel(lr), linearToSrgbChannel(lg), linearToSrgbChannel(lb));
          } else {
            linearToLabScratch(lr, lg, lb);
            index = nearestIdxByLab(labL, labA, labB, pal);
          }
          memo!.set(key, index);
        }
        if (++tried === MEMO_WARMUP && hits * 4 < MEMO_WARMUP) memoOn = false; // <25% repeats → drop it
      } else {
        const t = BAYER8[((y & 7) << 3) | (x & 7)]! * amplitude;
        const lr = SRGB_LIN[r]! + t;
        const lg = SRGB_LIN[g]! + t;
        const lb = SRGB_LIN[b]! + t;
        if (gamutMap !== undefined) {
          linearToLabScratch(lr, lg, lb);
          index = nearestIdxByLabHue(labL, labA, labB, pal, gamutMap, sortedHue!);
        } else if (lut) {
          index = lutNearest(lut, linearToSrgbChannel(lr), linearToSrgbChannel(lg), linearToSrgbChannel(lb));
        } else {
          linearToLabScratch(lr, lg, lb);
          index = nearestIdxByLab(labL, labA, labB, pal);
        }
      }
      writePixel(frame, p, index, pal.entries[index]!.color.mapColorId);
    }
  }
  return frame;
}

/**
 * Reference Bayer quantizer, kept verbatim from before the scratch-matcher/flat-table
 * optimization: 2D BAYER8 indexing + allocating matchLinear per memo-miss/memo-off pixel.
 * Exported only for the same-run opt-vs-ref A/B in dither-perf.test.ts. Do not optimize.
 */
export function quantizeBayerReference(
  img: RgbImage,
  pal: PreparedPalette,
  amplitude = 0.06,
  lut?: RgbLut,
  gamutMap?: number,
  prevImage?: RgbImage,
  prevQuantized?: QuantizedFrame,
): QuantizedFrame {
  const { width, height } = img;
  const frame = emptyFrame(img);
  const temporal = temporalUsable(img, prevImage, prevQuantized);
  const pImg = temporal ? prevImage!.data : null;
  const pIdx = temporal ? prevQuantized!.paletteIndex : null;
  const memo = lut ? null : new Map<number, number>();
  let memoOn = memo !== null;
  let tried = 0;
  let hits = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      const i = p * 3;
      const r = img.data[i]!;
      const g = img.data[i + 1]!;
      const b = img.data[i + 2]!;
      if (pImg && r === pImg[i]! && g === pImg[i + 1]! && b === pImg[i + 2]!) {
        const idx = pIdx![p]!;
        writePixel(frame, p, idx, pal.entries[idx]!.color.mapColorId);
        continue;
      }
      let index: number;
      if (memoOn) {
        const key = ((r << 16) | (g << 8) | b) * 64 + ((y & 7) << 3) + (x & 7);
        const hit = memo!.get(key);
        if (hit !== undefined) {
          index = hit;
          hits++;
        } else {
          const t = BAYER8_REF[y & 7]![x & 7]! * amplitude;
          index = matchLinear(srgbChannelToLinear(r) + t, srgbChannelToLinear(g) + t, srgbChannelToLinear(b) + t, pal, lut, gamutMap);
          memo!.set(key, index);
        }
        if (++tried === MEMO_WARMUP && hits * 4 < MEMO_WARMUP) memoOn = false;
      } else {
        const t = BAYER8_REF[y & 7]![x & 7]! * amplitude;
        index = matchLinear(
          srgbChannelToLinear(r) + t,
          srgbChannelToLinear(g) + t,
          srgbChannelToLinear(b) + t,
          pal,
          lut,
          gamutMap,
        );
      }
      writePixel(frame, p, index, pal.entries[index]!.color.mapColorId);
    }
  }
  return frame;
}

export function quantizeFrame(
  img: RgbImage,
  pal: PreparedPalette,
  opts: QuantizeOptions = {},
): QuantizedFrame {
  switch (opts.method ?? "floyd-steinberg") {
    case "none":
      // position-deterministic → temporal skip is byte-identical (prev threaded through)
      return quantizeNearest(img, pal, opts.lut, opts.gamutMap, opts.prevImage, opts.prevQuantized);
    case "bayer":
      // position-deterministic → temporal skip is byte-identical (prev threaded through)
      return quantizeBayer(img, pal, opts.bayerAmplitude, opts.lut, opts.gamutMap, opts.prevImage, opts.prevQuantized);
    case "floyd-steinberg":
    default:
      // error diffusion is NOT position-deterministic — a pixel depends on its neighbours' diffused
      // error, so a temporal skip would corrupt it. Always full-quantize (prev intentionally ignored).
      return quantizeFloydSteinberg(img, pal, opts.lut, opts.gamutMap);
  }
}

/**
 * One frame of temporal-hysteresis quantization (the hot loop behind quantizeVideo; lives here so
 * it shares the module-local scratch matchers and flat BAYER8 - vite-node compiles hot-loop reads
 * of imported bindings to getter calls). The CANDIDATE is exactly what the non-temporal
 * quantizer picks for the method ("bayer" applies the position's Bayer offset; `gamutMap`
 * overrides the LUT; any other method matches plain nearest). The hysteresis keep/switch
 * decision is applied on top: a pixel keeps `prev`'s index while that color stays within
 * `bestDist2 + threshold` of the (dithered) target in OKLab.
 *
 * Allocation-free per pixel: scratch-scalar Lab, index-only matchers, and per-CALL typed arrays
 * of the palette's L/a/b/mapColorId indexed by palette index (frame-constant). Identical
 * arithmetic order to the allocating form - element-identical to quantizeVideoReference (locked
 * by dither-perf.test.ts).
 */
export function quantizeFrameHysteresis(
  img: RgbImage,
  pal: PreparedPalette,
  opts: QuantizeOptions,
  threshold: number,
  prev?: QuantizedFrame,
): QuantizedFrame {
  const { width, height } = img;
  const frame = emptyFrame(img);
  const gamutMap = opts.gamutMap;
  const lut = opts.lut;
  const isBayer = opts.method === "bayer";
  const amplitude = opts.bayerAmplitude ?? 0.06;
  const sortedHue = gamutMap !== undefined ? buildSortedHue(pal) : null;
  // frame-constant palette views: Lab + mapColorId by ORIGINAL index, so the hysteresis
  // distances and result writes are typed-array loads instead of entry-object chains
  const n = pal.entries.length;
  const palL = new Float64Array(n);
  const palA = new Float64Array(n);
  const palB = new Float64Array(n);
  const palMap = new Uint8Array(n);
  for (let k = 0; k < n; k++) {
    const e = pal.entries[k]!;
    palL[k] = e.lab.L;
    palA[k] = e.lab.a;
    palB[k] = e.lab.b;
    palMap[k] = e.color.mapColorId;
  }
  const data = img.data;
  const prevIdxArr = prev ? prev.paletteIndex : null;
  const outIdx = frame.paletteIndex;
  const outMap = frame.mapColorId;
  let p = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++, p++) {
      const i = p * 3;
      const r = data[i]!;
      const g = data[i + 1]!;
      const b = data[i + 2]!;
      // candidate + target Lab (for bayer, the DITHERED color) in the scratch scalars
      let idx: number;
      if (isBayer) {
        const t = BAYER8[((y & 7) << 3) | (x & 7)]! * amplitude;
        const lr = SRGB_LIN[r]! + t;
        const lg = SRGB_LIN[g]! + t;
        const lb = SRGB_LIN[b]! + t;
        linearToLabScratch(lr, lg, lb);
        idx =
          gamutMap !== undefined
            ? nearestIdxByLabHue(labL, labA, labB, pal, gamutMap, sortedHue!)
            : lut
              ? lutNearest(lut, linearToSrgbChannel(lr), linearToSrgbChannel(lg), linearToSrgbChannel(lb))
              : nearestIdxByLab(labL, labA, labB, pal);
      } else {
        linearToLabScratch(SRGB_LIN[r]!, SRGB_LIN[g]!, SRGB_LIN[b]!);
        idx =
          gamutMap !== undefined
            ? nearestIdxByLabHue(labL, labA, labB, pal, gamutMap, sortedHue!)
            : lut
              ? lutNearest(lut, r, g, b)
              : nearestIdxByLab(labL, labA, labB, pal);
      }
      let chosenIdx = idx;
      if (prevIdxArr) {
        const prevIdx = prevIdxArr[p]!;
        if (prevIdx !== chosenIdx) {
          // same operand order as labDist2(target, entry): target minus entry, L then a then b
          const bL = labL - palL[idx]!;
          const bA = labA - palA[idx]!;
          const bB = labB - palB[idx]!;
          const bestDist2 = bL * bL + bA * bA + bB * bB;
          const kL = labL - palL[prevIdx]!;
          const kA = labA - palA[prevIdx]!;
          const kB = labB - palB[prevIdx]!;
          const keepDist = kL * kL + kA * kA + kB * kB;
          if (keepDist <= bestDist2 + threshold) chosenIdx = prevIdx;
        }
      }
      outIdx[p] = chosenIdx;
      outMap[p] = palMap[chosenIdx]!;
    }
  }
  return frame;
}

export { linearToSrgbChannel };
