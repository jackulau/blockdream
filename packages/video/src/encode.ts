import type { RgbImage } from "@blockdream/color-core";
import { runFfmpeg } from "./ffmpeg";

/** Encode a packed RGB image to a PNG buffer via ffmpeg (stdin → stdout). */
export function rgbToPng(img: RgbImage): Buffer {
  const args = [
    "-v", "error",
    "-f", "rawvideo", "-pix_fmt", "rgb24",
    "-s", `${img.width}x${img.height}`,
    "-i", "pipe:0",
    "-frames:v", "1",
    "-c:v", "png", "-f", "image2pipe", "pipe:1",
  ];
  const { stdout, status, stderr } = runFfmpeg(args, 1 << 28, Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength));
  if (status !== 0 || stdout.length === 0) throw new Error(`png encode failed (status ${status}): ${stderr.slice(0, 300)}`);
  return stdout;
}
