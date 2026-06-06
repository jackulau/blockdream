// One-page showcase: both neural world models (auto-connecting, decoupled-smooth) and
// the block-art tester, on a single page. Each canvas captures keys only while focused
// so the two worlds don't fight over the keyboard.

import { Viewer } from "./viewer";
import { actionFromKeys } from "./action";
import { controlFromKeys } from "./driveAction";
import { createBlockArt } from "./blockart-core";
import { preparePalette, quantizeFrame, type RgbImage } from "@mineworld/color-core";
import javaMapPalette from "@mineworld/palette/data/java-map-colors-1.21.9.json";
import type { MapPalette } from "@mineworld/palette";
import { imageToVolume, spin, objToVolume, type VoxelVolume } from "@mineworld/voxel";
import { generateJavaDatapack, generateVoxelDatapack, fillBatch } from "@mineworld/emit-commands";
import { Viewer3D } from "./viewer3d";
import { blockForBase, localTextureUrl, loadTextureManifest } from "./blocks";
import { downloadDatapack } from "./datapack-export";

// map-colour id → Minecraft block id (baseId = id>>2); air for unmapped
const resolveBlock = (mapColorId: number) => blockForBase(mapColorId >> 2)?.id ?? "minecraft:air";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const MC_URL = "ws://127.0.0.1:8765";
const DR_URL = "ws://127.0.0.1:8766";

function heldFor(el: HTMLElement): Set<string> {
  const held = new Set<string>();
  el.addEventListener("keydown", (e) => {
    const k = e.key.toLowerCase();
    held.add(k);
    if (k.startsWith("arrow") || k === " ") e.preventDefault();
  });
  el.addEventListener("keyup", (e) => held.delete(e.key.toLowerCase()));
  el.addEventListener("blur", () => held.clear());
  return held;
}

function pill(el: HTMLElement, text: string, cls: "ok" | "err" | "idle"): void {
  el.textContent = text;
  el.className = `pill ${cls}`;
}

// --- Minecraft world model -----------------------------------------------------
const mcScreen = $<HTMLCanvasElement>("mc-screen");
const mcSkill = $<HTMLSelectElement>("mc-skill");
const mcHud = $<HTMLDivElement>("mc-hud");
const mcStatus = $<HTMLSpanElement>("mc-status");
const mcHeld = heldFor(mcScreen);

const mcViewer = new Viewer({
  url: MC_URL,
  canvas: mcScreen,
  pngKey: "png_b64",
  buildAction: () => {
    const a = actionFromKeys(mcHeld);
    return { buttons: a.buttons, camera: a.camera, skill: mcSkill.value };
  },
  buildReset: () => ({ skill: mcSkill.value }),
  onStats: ({ displayFps, genFps }) => {
    mcHud.textContent = `display ${displayFps.toFixed(0)} fps · gen ${genFps.toFixed(1)} fps\nmovement: ${mcSkill.value}`;
  },
  onStatus: (t, cls) => pill(mcStatus, cls === "ok" ? `live · ${mcSkill.value}` : t, cls),
});
$<HTMLButtonElement>("mc-reset").addEventListener("click", () => mcViewer.reset());
mcSkill.addEventListener("change", () => {
  if (mcViewer.connected) mcViewer.reset();
});

// --- Driving world model -------------------------------------------------------
const drRgb = $<HTMLCanvasElement>("dr-rgb");
const drBev = $<HTMLCanvasElement>("dr-bev");
const drBevCtx = drBev.getContext("2d")!;
const drHud = $<HTMLDivElement>("dr-hud");
const drStatus = $<HTMLSpanElement>("dr-status");
const drHeld = heldFor(drRgb);
let drTel: number[] = [];

function drawBev(lidar: number[]): void {
  const S = drBev.width;
  const cx = S / 2;
  const cy = S / 2;
  drBevCtx.fillStyle = "#05070c";
  drBevCtx.fillRect(0, 0, S, S);
  drBevCtx.fillStyle = "#cdd6ff";
  for (let k = 0; k < lidar.length; k++) {
    const ang = (2 * Math.PI * k) / lidar.length;
    const d = lidar[k]! * (S / 2 - 2);
    drBevCtx.fillRect(Math.round(cx + d * Math.sin(ang)) - 1, Math.round(cy - d * Math.cos(ang)) - 1, 2, 2);
  }
  drBevCtx.fillStyle = "#33d94e";
  drBevCtx.fillRect(cx - 1, cy - 2, 3, 4);
}

const drViewer = new Viewer({
  url: DR_URL,
  canvas: drRgb,
  pngKey: "rgb_png_b64",
  buildAction: () => ({ control: controlFromKeys(drHeld) }),
  onFrame: (msg) => {
    drawBev((msg.lidar as number[]) ?? []);
    drTel = (msg.telemetry as number[]) ?? drTel;
  },
  onStats: ({ displayFps, genFps }) => {
    drHud.textContent =
      `display ${displayFps.toFixed(0)} fps · gen ${genFps.toFixed(0)} fps\n` +
      `speed ${((drTel[3] ?? 0) * 30).toFixed(1)} m/s · yaw-rate ${(drTel[2] ?? 0).toFixed(2)}`;
  },
  onStatus: (t, cls) => pill(drStatus, cls === "ok" ? "live" : t, cls),
});
$<HTMLButtonElement>("dr-reset").addEventListener("click", () => drViewer.reset());

// --- block art -----------------------------------------------------------------
const ba = createBlockArt({
  file: $<HTMLInputElement>("ba-file"),
  grid: $<HTMLInputElement>("ba-grid"),
  gridVal: $<HTMLSpanElement>("ba-gridVal"),
  dither: $<HTMLSelectElement>("ba-dither"),
  stats: $<HTMLDivElement>("ba-stats"),
  src: $<HTMLCanvasElement>("ba-src"),
  out: $<HTMLCanvasElement>("ba-out"),
  bom: $<HTMLUListElement>("ba-bom"),
  tooltip: $<HTMLDivElement>("ba-tooltip"),
  useTextures: $<HTMLInputElement>("ba-useTextures"),
}, {
  onRender: (q) => {
    const dl = $<HTMLButtonElement>("ba-download");
    dl.disabled = false;
    $<HTMLDivElement>("ba-export").textContent = `${q.width}×${q.height} = ${q.width * q.height} blocks · 1 frame`;
  },
});
ba.loadUrl("/test-assets/pixelart.png"); // preload sample so the section is alive on load

// Download a vanilla datapack that builds the current image as a block-wall.
$<HTMLButtonElement>("ba-download").addEventListener("click", () => {
  const q = ba.getFrame();
  if (!q) return;
  const pack = generateJavaDatapack([q], resolveBlock, { namespace: "mineworld_art" });
  $<HTMLDivElement>("ba-export").textContent = `datapack: ${pack.totalSetblocks} setblocks · ${pack.frameCount} frame · load /function mineworld_art:setup`;
  downloadDatapack("mineworld-blockart-datapack", pack.files);
});

// auto-connect both world models so the page "just works"
mcViewer.connect();
drViewer.connect();

// --- 3D voxel builder + replay -------------------------------------------------
const pal3d = preparePalette(javaMapPalette as unknown as MapPalette);
const hexByMap = new Map<number, number>();
for (const e of pal3d.entries) {
  const c = e.color;
  hexByMap.set(c.mapColorId, (c.r << 16) | (c.g << 8) | c.b);
}

// a neutral mid-gray solid block id for monochrome .obj imports (low channel spread, mid brightness)
let grayId = 0;
{
  let best = Infinity;
  for (const e of pal3d.entries) {
    const { r, g, b, mapColorId } = e.color;
    const mean = (r + g + b) / 3;
    const spread = Math.abs(r - mean) + Math.abs(g - mean) + Math.abs(b - mean);
    const score = spread + Math.abs(mean - 130);
    if (score < best && blockForBase(mapColorId >> 2)) {
      best = score;
      grayId = mapColorId;
    }
  }
}

// downscale any canvas to an RgbImage for quantization
function rgbImageFromCanvas(src: HTMLCanvasElement, gridW: number): RgbImage {
  const aspect = src.height / src.width || 1;
  const w = Math.min(gridW, src.width);
  const h = Math.max(1, Math.round(w * aspect));
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(src, 0, 0, w, h);
  const { data } = ctx.getImageData(0, 0, w, h);
  const out = new Uint8Array(w * h * 3);
  for (let i = 0, j = 0; i < data.length; i += 4, j += 3) {
    out[j] = data[i]!;
    out[j + 1] = data[i + 1]!;
    out[j + 2] = data[i + 2]!;
  }
  return { width: w, height: h, data: out };
}

// decode an animated GIF to per-frame canvases via the browser ImageDecoder API
async function decodeGif(file: File): Promise<HTMLCanvasElement[]> {
  const Dec = (window as unknown as { ImageDecoder?: any }).ImageDecoder;
  if (!Dec) throw new Error("ImageDecoder unsupported in this browser");
  const dec = new Dec({ data: await file.arrayBuffer(), type: file.type || "image/gif" });
  await dec.tracks.ready;
  const count = dec.tracks.selectedTrack?.frameCount ?? 1;
  const out: HTMLCanvasElement[] = [];
  for (let i = 0; i < count; i++) {
    const { image } = await dec.decode({ frameIndex: i });
    const c = document.createElement("canvas");
    c.width = image.displayWidth;
    c.height = image.displayHeight;
    c.getContext("2d")!.drawImage(image, 0, 0);
    out.push(c);
    image.close();
  }
  return out;
}

function rgbImageFromImg(img: HTMLImageElement, gridW: number): RgbImage {
  const aspect = img.naturalHeight / img.naturalWidth || 1;
  const w = gridW;
  const h = Math.max(1, Math.round(gridW * aspect));
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(img, 0, 0, w, h);
  const { data } = ctx.getImageData(0, 0, w, h);
  const out = new Uint8Array(w * h * 3);
  for (let i = 0, j = 0; i < data.length; i += 4, j += 3) {
    out[j] = data[i]!;
    out[j + 1] = data[i + 1]!;
    out[j + 2] = data[i + 2]!;
  }
  return { width: w, height: h, data: out };
}

async function setup3dViewer(): Promise<void> {
  const canvas = $<HTMLCanvasElement>("v3-canvas");
  const playBtn = $<HTMLButtonElement>("v3-play");
  const scrub = $<HTMLInputElement>("v3-scrub");
  const spinCb = $<HTMLInputElement>("v3-spin");
  const hud = $<HTMLDivElement>("v3-hud");
  await loadTextureManifest();

  const viewer = new Viewer3D({
    canvas,
    textureFor: (id) => {
      const info = blockForBase(id >> 2); // mapColorId → baseId
      return info ? localTextureUrl(info.id) : null;
    },
    colorFor: (id) => hexByMap.get(id) ?? 0x808080,
    onFrame: (i, n) => {
      scrub.value = String(i);
      hud.textContent = `frame ${i + 1}/${n} · drag to orbit`;
    },
  });

  const depth = $<HTMLInputElement>("v3-depth");
  let current3d: VoxelVolume[] = [];
  let lastSource: ReturnType<typeof quantizeFrame> | null = null;

  // nearest-downscale a quantized frame so the voxel volume stays light (3D = W×H×depth × frames)
  function downscale(q: ReturnType<typeof quantizeFrame>, maxW: number) {
    if (q.width <= maxW) return q;
    const s = q.width / maxW;
    const w = maxW;
    const h = Math.max(1, Math.round(q.height / s));
    const mapColorId = new Uint8Array(w * h);
    const paletteIndex = new Int32Array(w * h);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const p = Math.min(q.height - 1, Math.floor(y * s)) * q.width + Math.min(q.width - 1, Math.floor(x * s));
        mapColorId[y * w + x] = q.mapColorId[p]!;
        paletteIndex[y * w + x] = q.paletteIndex[p]!;
      }
    return { width: w, height: h, mapColorId, paletteIndex };
  }

  function build3d(q: ReturnType<typeof quantizeFrame>): void {
    lastSource = q;
    current3d = spin(imageToVolume(q, { mode: "flat", depth: Number(depth.value) }), 24, "y");
    viewer.setFrames(current3d);
    scrub.max = String(current3d.length - 1);
    viewer.play();
    playBtn.textContent = "pause";
    hud.textContent = `${current3d.length} frames · drag to orbit`;
  }

  // initial source = the preloaded sample image
  const img = new Image();
  img.onload = () => build3d(quantizeFrame(rgbImageFromImg(img, 28), pal3d, { method: "none" }));
  img.src = "/test-assets/pixelart.png";

  // "build 3D from image" voxelizes the CURRENT block-art image (downscaled) one-click
  $<HTMLButtonElement>("v3-rebuild").addEventListener("click", () => {
    const q = ba.getFrame();
    build3d(q ? downscale(q, 32) : lastSource ?? quantizeFrame(rgbImageFromImg(img, 28), pal3d, { method: "none" }));
  });
  depth.addEventListener("input", () => {
    if (lastSource) build3d(lastSource);
  });

  function showFrames(frames: VoxelVolume[], label: string): void {
    current3d = frames;
    viewer.setFrames(frames);
    scrub.max = String(frames.length - 1);
    viewer.play();
    playBtn.textContent = "pause";
    hud.textContent = `${label} · ${frames.length} frame${frames.length > 1 ? "s" : ""} · drag to orbit`;
  }

  // import a .obj model (→ voxel shell) or an animated .gif (→ block animation)
  $<HTMLInputElement>("v3-import").addEventListener("change", async (ev) => {
    const file = (ev.target as HTMLInputElement).files?.[0];
    if (!file) return;
    hud.textContent = `importing ${file.name}…`;
    try {
      if (/\.obj$/i.test(file.name)) {
        showFrames([objToVolume(await file.text(), { resolution: 32, mapColorId: grayId })], `model ${file.name}`);
      } else {
        const canvases = await decodeGif(file);
        const frames = canvases.map((c) =>
          imageToVolume(quantizeFrame(rgbImageFromCanvas(c, 28), pal3d, { method: "none" }), { mode: "flat", depth: 2 }),
        );
        showFrames(frames, `gif ${file.name}`);
      }
    } catch (err) {
      hud.textContent = `import failed: ${(err as Error).message}`;
    }
  });

  // Download a vanilla datapack that builds the 3D spin animation (fill-batched)
  $<HTMLButtonElement>("v3-download").addEventListener("click", () => {
    if (!current3d.length) return;
    const pack = generateVoxelDatapack(current3d, resolveBlock, {
      namespace: "mineworld_3d",
      optimize: (cells, r) => fillBatch(cells, r),
    });
    $<HTMLDivElement>("v3-export").textContent =
      `3D datapack: ${pack.totalSetblocks} blocks · ${pack.frameCount} frames · /function mineworld_3d:setup`;
    downloadDatapack("mineworld-3d-datapack", pack.files);
  });

  playBtn.addEventListener("click", () => {
    if (viewer.isPlaying) {
      viewer.pause();
      playBtn.textContent = "play";
    } else {
      viewer.play();
      playBtn.textContent = "pause";
    }
  });
  scrub.addEventListener("input", () => {
    viewer.pause();
    playBtn.textContent = "play";
    viewer.setFrame(Number(scrub.value));
  });
  spinCb.addEventListener("change", () => viewer.setSpin(spinCb.checked));
}
void setup3dViewer();
