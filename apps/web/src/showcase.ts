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
import { imageToVolume, spin } from "@mineworld/voxel";
import { Viewer3D } from "./viewer3d";
import { blockForBase, localTextureUrl, loadTextureManifest } from "./blocks";

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
});
ba.loadUrl("/test-assets/pixelart.png"); // preload sample so the section is alive on load

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

  const img = new Image();
  img.onload = () => {
    const rgb = rgbImageFromImg(img, 28);
    const q = quantizeFrame(rgb, pal3d, { method: "none" });
    const frames = spin(imageToVolume(q, { mode: "flat", depth: 3 }), 24, "y");
    viewer.setFrames(frames);
    scrub.max = String(frames.length - 1);
    viewer.play();
    playBtn.textContent = "pause";
  };
  img.src = "/test-assets/pixelart.png";

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
