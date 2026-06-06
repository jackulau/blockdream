// Animated-GIF decode via the browser ImageDecoder API → per-frame canvases + their REAL
// per-frame delays (ms). VideoFrame.duration is microseconds; we convert to ms so players
// honor the GIF's true cadence instead of one hardcoded fps. Shared by the 2D block-art
// tester and the 3D voxel viewer. Browser-only (ImageDecoder); jsdom can't run it, so the
// timing math lives in anim.ts (which IS unit-tested).

export interface DecodedGif {
  canvases: HTMLCanvasElement[];
  durationsMs: Array<number | undefined>;
}

export function isGif(file: File): boolean {
  return file.type === "image/gif" || /\.gif$/i.test(file.name);
}

export async function decodeGif(file: File): Promise<DecodedGif> {
  const Dec = (window as unknown as { ImageDecoder?: any }).ImageDecoder;
  if (!Dec) throw new Error("ImageDecoder unsupported in this browser");
  const dec = new Dec({ data: await file.arrayBuffer(), type: file.type || "image/gif" });
  await dec.tracks.ready;
  const count = dec.tracks.selectedTrack?.frameCount ?? 1;
  const canvases: HTMLCanvasElement[] = [];
  const durationsMs: Array<number | undefined> = [];
  for (let i = 0; i < count; i++) {
    const { image } = await dec.decode({ frameIndex: i });
    const c = document.createElement("canvas");
    c.width = image.displayWidth;
    c.height = image.displayHeight;
    c.getContext("2d")!.drawImage(image, 0, 0);
    canvases.push(c);
    durationsMs.push(typeof image.duration === "number" ? image.duration / 1000 : undefined);
    image.close();
  }
  return { canvases, durationsMs };
}
