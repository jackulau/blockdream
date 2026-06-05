import {
  preparePalette,
  quantizeFrame,
  createRgbImage,
  setPixel,
  type RgbImage,
  type QuantizedFrame,
  type PreparedPalette,
  type DitherMethod,
} from "@mineworld/color-core";
import { getJavaMapPalette } from "@mineworld/palette";
import { extractFrames, rgbToPng } from "@mineworld/video";

function renderQuantized(q: QuantizedFrame, pal: PreparedPalette): RgbImage {
  const img = createRgbImage(q.width, q.height);
  for (let p = 0; p < q.width * q.height; p++) {
    const c = pal.entries[q.paletteIndex[p]!]!.color;
    img.data[p * 3] = c.r;
    img.data[p * 3 + 1] = c.g;
    img.data[p * 3 + 2] = c.b;
  }
  return img;
}

function blit(dst: RgbImage, src: RgbImage, ox: number, oy: number, scale: number): void {
  for (let y = 0; y < src.height; y++) {
    for (let x = 0; x < src.width; x++) {
      const i = (y * src.width + x) * 3;
      const r = src.data[i]!, g = src.data[i + 1]!, b = src.data[i + 2]!;
      for (let sy = 0; sy < scale; sy++) {
        for (let sx = 0; sx < scale; sx++) {
          setPixel(dst, ox + x * scale + sx, oy + y * scale + sy, r, g, b);
        }
      }
    }
  }
}

/** Side-by-side (source | block-art) comparison image, both upscaled `scale`×. */
export function buildComparison(source: RgbImage, q: QuantizedFrame, pal: PreparedPalette, scale = 4): RgbImage {
  const gap = scale * 2;
  const W = source.width * scale * 2 + gap;
  const H = source.height * scale;
  const out = createRgbImage(W, H);
  for (let i = 0; i < out.data.length; i += 3) {
    out.data[i] = 24;
    out.data[i + 1] = 24;
    out.data[i + 2] = 28;
  }
  blit(out, source, 0, 0, scale);
  blit(out, renderQuantized(q, pal), source.width * scale + gap, 0, scale);
  return out;
}

export interface PreviewOptions {
  grid?: number;
  method?: DitherMethod;
  scale?: number;
  paletteVersion?: string;
}

/** Render a clip's first frame to a side-by-side (source | block-art) PNG buffer. */
export function previewPng(input: string, opts: PreviewOptions = {}): Buffer {
  const grid = opts.grid ?? 128;
  const pal = preparePalette(getJavaMapPalette(opts.paletteVersion));
  const [source] = extractFrames(input, { width: grid, height: grid, maxFrames: 1 });
  if (!source) throw new Error("no frame decoded");
  const q = quantizeFrame(source, pal, { method: opts.method ?? "floyd-steinberg" });
  return rgbToPng(buildComparison(source, q, pal, opts.scale ?? 4));
}
