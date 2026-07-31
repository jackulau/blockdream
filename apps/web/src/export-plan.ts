// Pure export planning + status honesty for the showcase's download buttons. DOM-free on
// purpose (the repo's pure-core style): the budget decision, the pre-work HUD text, and the
// PNG success/failure reporting are all decided here and unit-tested, while showcase.ts only
// wires them to elements.

import { fitScale } from "./pixel-export";

/** Ceiling on TOTAL output pixels across all frames of one browser GIF export. Each frame is
 *  padded + integer-upscaled to an RGBA raster (4 bytes/pixel) BEFORE the synchronous encode,
 *  so a plan of P total pixels holds ~4P bytes of rasters plus ~P bytes of palette indices in
 *  memory at once. 150e6 pixels ≈ 600 MB of rasters - already heavy but survivable; the
 *  unbounded worst case (a 60 fps 11-minute clip = 13200 frames ≈ 5.8 GB) simply kills the
 *  tab, which is why this one is a hard cap, not a warn-and-continue like the datapack's. */
export const GIF_EXPORT_PIXEL_BUDGET = 150e6;

export interface GifExportPlan {
  frames: number;
  outWidth: number; // upscaled output size (max frame size × integer scale)
  outHeight: number;
  totalPixels: number; // frames × outWidth × outHeight
  maxFrames: number; // most frames of this size the budget allows
  ok: boolean; // false → refuse before allocating anything
  message: string; // HUD line: "encoding N frames…" or the refusal with the math
}

/** Decide whether a GIF export fits in browser memory BEFORE any per-frame raster is
 *  allocated. `dims` are the source frame sizes (blocks); target is the upscale target
 *  edge in px (the showcase uses 384, matching its downloadGif call). */
export function planGifExport(
  dims: Array<{ sx: number; sy: number }>,
  target = 384,
  budget = GIF_EXPORT_PIXEL_BUDGET,
): GifExportPlan {
  const frames = dims.length;
  const W = Math.max(1, ...dims.map((d) => d.sx));
  const H = Math.max(1, ...dims.map((d) => d.sy));
  const scale = fitScale(W, H, target);
  const outWidth = W * scale;
  const outHeight = H * scale;
  const totalPixels = frames * outWidth * outHeight;
  const maxFrames = Math.max(1, Math.floor(budget / (outWidth * outHeight)));
  const ok = totalPixels <= budget;
  const mb = Math.round((totalPixels * 4) / 1e6);
  const message = ok
    ? `encoding ${frames} GIF frame${frames === 1 ? "" : "s"} at ${outWidth}×${outHeight}…`
    : `GIF export refused: ${frames} frames at ${outWidth}×${outHeight} would need ~${mb} MB of ` +
      `frame rasters and would freeze or kill the tab. At this size the budget is ${maxFrames} frames · ` +
      `lower the fps, use a shorter clip, or export the datapack instead (it streams frame files).`;
  return { frames, outWidth, outHeight, totalPixels, maxFrames, ok, message };
}

/** Pre-generation HUD line for the datapack export: the budget warning (when any) must be
 *  visible BEFORE the synchronous generate+zip starts, not only after it survives. */
export function packingHudText(budget: { warn: boolean; message: string }, frameCount: number): string {
  const packing = `packing ${frameCount} frame${frameCount === 1 ? "" : "s"} into a datapack…`;
  return budget.warn ? `WARNING: ${budget.message} · ${packing}` : packing;
}

/** Reflect a PNG download's real outcome into a status element: success text only after the
 *  encode actually resolved (downloadPng rejects with e.g. "PNG encode failed"), failure text
 *  into the SAME element otherwise - never a success line over an unhandled rejection. */
export async function reportPngDownload(
  download: Promise<void>,
  status: { textContent: string | null },
  successText: string,
): Promise<void> {
  try {
    await download;
    status.textContent = successText;
  } catch (err) {
    status.textContent = `PNG export failed: ${(err as Error).message}`;
  }
}
