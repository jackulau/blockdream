// Animated-GIF decode via the browser ImageDecoder API → per-frame canvases + their REAL
// per-frame delays (ms). VideoFrame.duration is microseconds; we convert to ms so players
// honor the GIF's true cadence instead of one hardcoded fps. Shared by the 2D block-art
// tester and the 3D voxel viewer. Browser-only (ImageDecoder); jsdom can't run it, so the
// timing math lives in anim.ts and the budget math in plannedGifFrames (both unit-tested).

import { importAbortError } from "./video";

/** Memory budget on TOTAL retained decode pixels across all frames of one GIF. Unlike the
 *  video path (which streams each frame into a compact one-byte-per-voxel wall slice and
 *  drops the pixels), this decode RETAINS a full-resolution canvas per frame - RGBA, so a
 *  600-frame 1080p GIF is ~5 GB and kills the tab. 128e6 pixels ≈ 512 MB of canvases:
 *  heavy but survivable, and far above every reasonable GIF (a 480×360 clip still keeps
 *  740 frames). Past it the decode keeps the FIRST N frames and reports the cap honestly
 *  (`capped`), mirroring the video path's "resolution capped (memory)" HUD pattern. */
export const GIF_DECODE_PIXEL_BUDGET = 128e6;

export interface DecodedGif {
  canvases: HTMLCanvasElement[];
  durationsMs: Array<number | undefined>;
  /** Set when the pixel budget truncated the decode: only the first `kept` of `total`
   *  frames were retained. Hosts surface this instead of silently playing a shorter clip. */
  capped?: { kept: number; total: number };
}

export interface GifDecodeOptions {
  /** Cancel the decode: checked before every frame; rejects with an AbortError-named error. */
  signal?: AbortSignal;
  /** Override the retained-pixel budget (tests); defaults to GIF_DECODE_PIXEL_BUDGET. */
  pixelBudget?: number;
}

/** How many frames of a `width`×`height` GIF fit the retained-pixel budget (≥1). Pure. */
export function plannedGifFrames(
  frameCount: number,
  width: number,
  height: number,
  budget = GIF_DECODE_PIXEL_BUDGET,
): number {
  const perFrame = Math.max(1, width * height);
  return Math.max(1, Math.min(frameCount, Math.floor(budget / perFrame)));
}

export function isGif(file: File): boolean {
  return file.type === "image/gif" || /\.gif$/i.test(file.name);
}

export async function decodeGif(file: File, opts: GifDecodeOptions = {}): Promise<DecodedGif> {
  const Dec = (window as unknown as { ImageDecoder?: any }).ImageDecoder;
  if (!Dec) throw new Error("ImageDecoder unsupported in this browser");
  const dec = new Dec({ data: await file.arrayBuffer(), type: file.type || "image/gif" });
  await dec.tracks.ready;
  const count = dec.tracks.selectedTrack?.frameCount ?? 1;
  const canvases: HTMLCanvasElement[] = [];
  const durationsMs: Array<number | undefined> = [];
  let keep = count; // tightened after frame 0, once the real frame size is known
  for (let i = 0; i < keep; i++) {
    if (opts.signal?.aborted) throw importAbortError();
    const { image } = await dec.decode({ frameIndex: i });
    if (i === 0) keep = plannedGifFrames(count, image.displayWidth, image.displayHeight, opts.pixelBudget);
    const c = document.createElement("canvas");
    c.width = image.displayWidth;
    c.height = image.displayHeight;
    c.getContext("2d")!.drawImage(image, 0, 0);
    canvases.push(c);
    durationsMs.push(typeof image.duration === "number" ? image.duration / 1000 : undefined);
    image.close();
  }
  const out: DecodedGif = { canvases, durationsMs };
  if (keep < count) out.capped = { kept: keep, total: count };
  return out;
}
