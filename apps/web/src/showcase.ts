// One-page showcase: both neural world models (auto-connecting, decoupled-smooth) and
// the block-art tester, on a single page. Each canvas captures keys only while focused
// so the two worlds don't fight over the keyboard.

import "./style.css"; // design system: tokens (sumi/washi palette, type/space/motion scale) + base layer
import { Viewer } from "./viewer";
import { actionFromKeys } from "./action";
import { controlFromKeys } from "./driveAction";
import { createBlockArt } from "./blockart-core";
import { preparePalette, quantizeFrame, nearestSrgbHue, type RgbImage } from "@blockdream/color-core";
import { getSolidBlockMapPalette } from "@blockdream/palette/solid";
// Pure-data subpath (no node:fs/url) so the browser bundle never pulls in the fs-based palette loaders.
import { JAVA_DATAPACK_SUPPORTED } from "@blockdream/palette/versions";
import {
  imageToSolid,
  objToVolume,
  objSequenceToFrames,
  gltfToFrames,
  glbToFrames,
  generateSequence,
  TRANSFORM_ANIMS,
  type SequenceAnimName,
  type VoxelVolume,
} from "@blockdream/voxel";
import { rgbFramesToFlat3d } from "./video3d";
import { isVideoFile, decodeVideo } from "./video";
import { analyzeFileAudio } from "./audio";
import type { NoteEvent } from "@blockdream/audio";
import { initialArrangeState, arrangeReducer, planDatapackPlacement } from "./canvas-mod";
import { log } from "./log";
import { generateJavaDatapack, generateVoxelDatapack, greedyBoxes } from "@blockdream/emit-commands";
import { Viewer3D } from "./viewer3d";
import { localTextureUrl, faceTextureUrl, loadTextureManifest, hasLocalTextures, swatchDataUrl } from "./blocks";
import { resolveBlock, safeBlockInfo } from "./resolve-block";
import { volumeBom } from "./bom3d";
import { downloadDatapack } from "./datapack-export";
import { decodeGif } from "./gif";

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
  onStats: ({ displayFps, genFps, latencyMs }) => {
    mcHud.textContent = `display ${displayFps.toFixed(0)} fps · gen ${genFps.toFixed(1)} fps · ${latencyMs.toFixed(0)} ms\nmovement: ${mcSkill.value}`;
  },
  onStatus: (t, cls) => pill(mcStatus, cls === "ok" ? `live · ${mcSkill.value}` : t, cls),
});
$<HTMLButtonElement>("mc-reset").addEventListener("click", () => mcViewer.reset());
mcSkill.addEventListener("change", () => {
  if (mcViewer.connected) {
    mcViewer.reset();
    // keep the status pill in sync with the selected skill (it was stale: "live · walk" while pig)
    pill(mcStatus, `live · ${mcSkill.value}`, "ok");
  }
});

// --- Driving world model -------------------------------------------------------
const drRgb = $<HTMLCanvasElement>("dr-rgb");
const drBev = $<HTMLCanvasElement>("dr-bev");
const drBevCtx = drBev.getContext("2d")!;
const drHud = $<HTMLDivElement>("dr-hud");
const drStatus = $<HTMLSpanElement>("dr-status");
const drCap = $<HTMLElement>("dr-rgb-cap");
const drHeld = heldFor(drRgb);
let drTel: number[] = [];

// Defensive telemetry guard: the drive server sanitizes its emit (drive D1), but never let a
// NaN/Inf or off-physical value reach the HUD - map non-finite → 0 and clamp to physical ranges.
const finiteClamp = (x: number, lo: number, hi: number): number =>
  Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : 0;

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
    // honest caption: real decoded pixels when comma's VQ decoder is loaded, else the token field
    drCap.textContent =
      msg.decoded === false
        ? "generated commaVQ token field · fetch comma's VQ decoder for real pixels"
        : "imagined dashcam · comma's VQ tokens decoded to real pixels · arrows to drive";
  },
  onStats: ({ displayFps, genFps, latencyMs }) => {
    const speed = finiteClamp((drTel[3] ?? 0) * 30, 0, 60);
    const yawRate = finiteClamp(drTel[2] ?? 0, -6, 6);
    drHud.textContent =
      `display ${displayFps.toFixed(0)} fps · gen ${genFps.toFixed(0)} fps · ${latencyMs.toFixed(0)} ms\n` +
      `speed ${speed.toFixed(1)} m/s · yaw-rate ${yawRate.toFixed(2)}`;
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
}, {
  onRender: (q) => {
    const dl = $<HTMLButtonElement>("ba-download");
    dl.disabled = false;
    $<HTMLDivElement>("ba-export").textContent = `${q.width}×${q.height} = ${q.width * q.height} blocks · 1 frame`;
  },
});
ba.loadUrl("/test-assets/pixelart.png"); // preload sample so the section is alive on load

// drag & drop an image onto the block-art canvases
const baDrop = $<HTMLDivElement>("ba-drop");
for (const e of ["dragenter", "dragover"]) {
  baDrop.addEventListener(e, (ev) => {
    ev.preventDefault();
    baDrop.classList.add("drag");
  });
}
for (const e of ["dragleave", "drop"]) {
  baDrop.addEventListener(e, () => baDrop.classList.remove("drag"));
}
baDrop.addEventListener("drop", (ev) => {
  ev.preventDefault();
  const f = (ev as DragEvent).dataTransfer?.files?.[0];
  if (f && f.type.startsWith("image/")) void ba.loadFile(f); // GIF → animated, else static
});

// Download a vanilla datapack that builds the current image as a block-wall.
$<HTMLButtonElement>("ba-download").addEventListener("click", () => {
  const q = ba.getFrame();
  if (!q) return;
  const pack = generateJavaDatapack([q], resolveBlock, {
    namespace: "blockdream",
    supportedFormats: JAVA_DATAPACK_SUPPORTED,
  });
  $<HTMLDivElement>("ba-export").textContent = `datapack: ${pack.totalSetblocks} setblocks · ${pack.frameCount} frame · load /function blockdream:setup`;
  downloadDatapack("blockdream-blockart-datapack", pack.files);
});

// auto-connect both world models so the page "just works"
mcViewer.connect();
drViewer.connect();

// --- 3D voxel builder + replay -------------------------------------------------
// The 3D path quantizes against the PLACEABLE solid-block color space (same OKLab matcher
// as the 2D pixel-art path) so what the viewer shows is exactly what the datapack places.
// Stills get the 2D path's error-diffusion dither; animation frames stay nearest+gamut
// (per-frame dither speckle would defeat the temporal stabilizer).
const pal3d = preparePalette(getSolidBlockMapPalette().palette);
const QUANT3D_STILL = { method: "floyd-steinberg", gamutMap: 0.8 } as const;
// Quantization for a SOLID built from a flat import (GIF/video). A 2D motion graphic typically has a
// uniform background; nearest (no dither) keeps that field ONE block so detectBackgroundMask can flood
// it away and isolate the subject. Floyd–Steinberg would scatter the flat field into dithered islands
// that block the flood, leaving the whole rectangle as a slab (the mint box around the Snorlax).
const QUANT3D_FLAT_BUILD = { method: "none", gamutMap: 0.8 } as const;
// single-color OKLab match for 3D model imports (vertex colors / material colors → blocks)
const match3d = (r: number, g: number, b: number) => nearestSrgbHue(r, g, b, pal3d, 0.8).color.mapColorId;
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
    if (score < best && safeBlockInfo(mapColorId)) {
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

// Like rgbImageFromCanvas, but ALSO returns a 1=air mask from the source alpha (alpha < 128 → air),
// for the flat animation path: a transparent GIF/video pixel becomes air so the subject floats instead
// of sitting on a filled rectangle. An opaque clip (e.g. any video) yields an all-zero mask (full frame).
function rgbAndAirFromCanvas(src: HTMLCanvasElement, gridW: number): { rgb: RgbImage; air: Uint8Array } {
  const aspect = src.height / src.width || 1;
  const w = Math.min(gridW, src.width);
  const h = Math.max(1, Math.round(w * aspect));
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  ctx.clearRect(0, 0, w, h); // transparent default so untouched pixels read as air, not black
  ctx.drawImage(src, 0, 0, w, h);
  const { data } = ctx.getImageData(0, 0, w, h);
  const out = new Uint8Array(w * h * 3);
  const air = new Uint8Array(w * h);
  for (let i = 0, j = 0, p = 0; i < data.length; i += 4, j += 3, p++) {
    out[j] = data[i]!;
    out[j + 1] = data[i + 1]!;
    out[j + 2] = data[i + 2]!;
    if (data[i + 3]! < 128) air[p] = 1;
  }
  return { rgb: { width: w, height: h, data: out }, air };
}

// Per-frame grid width for a flat animation, ADAPTIVE to frame count. The flat path's render cost is
// ~ (front-face cells x frames); a 240-frame GIF and a 24-frame clip should not get the same grid. We
// hold the total cell budget B roughly constant: cells/frame = w * h = w^2 * aspect (aspect = h/w), so
// w = sqrt(B / (frames * aspect)), clamped. A long clip lands near the floor, a short one near a crisp
// cap — both far above the old fixed 64. Bayer keeps flat regions merged, so this budget tracks geometry.
function flatGridWidth(frameCount: number, aspect: number): number {
  const B = 2_400_000; // total front-face cells across all frames (pre-greedy-merge)
  const n = Math.max(1, frameCount);
  const a = aspect > 0 ? aspect : 0.75;
  const w = Math.round(Math.sqrt(B / (n * a)));
  return Math.max(64, Math.min(160, w)); // never worse than the old 64; cap so blocks/datapack stay sane
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
  const animSel = $<HTMLSelectElement>("v3-anim");
  const hud = $<HTMLDivElement>("v3-hud");
  const tooltip = $<HTMLDivElement>("v3-tooltip");
  const bomEl = $<HTMLUListElement>("v3-bom");
  await loadTextureManifest();

  // bill-of-materials for the built volume - same markup contract as blockart-core's renderBom,
  // counted by the pure volumeBom helper and named by the SAFE block that is actually placed.
  function renderBom3d(vol: VoxelVolume): void {
    const useTex = hasLocalTextures();
    bomEl.innerHTML = "";
    for (const row of volumeBom(vol)) {
      const info = safeBlockInfo(row.id);
      if (!info) continue;
      const li = document.createElement("li");
      const ic = document.createElement("img");
      ic.className = "ic";
      ic.alt = info.name;
      const swatch = swatchDataUrl(info);
      const real = useTex ? localTextureUrl(info.id) : null;
      if (real) {
        ic.src = real;
        ic.onerror = () => {
          ic.onerror = null;
          ic.src = swatch;
        };
      } else {
        ic.src = swatch;
      }
      const nm = document.createElement("div");
      nm.className = "nm";
      nm.innerHTML = `${info.name}<br><small>${info.id}</small>`;
      const ct = document.createElement("div");
      ct.className = "ct";
      ct.innerHTML = `${row.count}<small>${row.pct.toFixed(1)}%</small>`;
      li.append(ic, nm, ct);
      bomEl.appendChild(li);
    }
  }

  const viewer = new Viewer3D({
    canvas,
    // hover picking: same tooltip contract as the 2D block-art canvas (name, id, rgb swatch)
    onPick: (pick, ev) => {
      const info = pick ? safeBlockInfo(pick.id) : undefined;
      if (!pick || !info) {
        tooltip.style.display = "none";
        return;
      }
      tooltip.innerHTML =
        `<span class="sw" style="background:rgb(${info.rgb.r},${info.rgb.g},${info.rgb.b})"></span>` +
        `${info.name} <span class="id">${info.id}</span><br>` +
        `voxel ${pick.x}, ${pick.y}, ${pick.z} · rgb(${info.rgb.r}, ${info.rgb.g}, ${info.rgb.b})`;
      tooltip.style.display = "block";
      tooltip.style.left = `${ev.clientX + 14}px`;
      tooltip.style.top = `${ev.clientY + 14}px`;
    },
    textureFor: (id) => {
      const info = safeBlockInfo(id); // texture of the SAFE placeable block → preview == export
      return info ? localTextureUrl(info.id) : null;
    },
    // per-face textures: dir 2 = +Y (top), dir 3 = -Y (bottom), else side. null → falls back to textureFor.
    faceTextureFor: (id, dir) => {
      const info = safeBlockInfo(id);
      if (!info) return null;
      const face = dir === 2 ? "top" : dir === 3 ? "bottom" : "side";
      return faceTextureUrl(info.id, face);
    },
    colorFor: (id) => hexByMap.get(id) ?? 0x808080,
    onFrame: (i, n) => {
      scrub.value = String(i);
      hud.textContent = `frame ${i + 1}/${n} · drag to orbit`;
    },
  });

  const depth = $<HTMLInputElement>("v3-depth");
  let current3d: VoxelVolume[] = [];
  let current3dMusic: NoteEvent[] = []; // note-block music transcribed from an imported video's audio
  let baseVolume: VoxelVolume | null = null; // the single built solid (source for block-motion anims)

  // --- canvas mod: Arrange mode (drag the build + the note-block music area) + a note-block toggle ---
  const arrangeChk = $<HTMLInputElement>("v3-arrange");
  const arrangeTarget = $<HTMLSelectElement>("v3-arrange-target");
  const musicToggle = $<HTMLInputElement>("v3-music-toggle");
  let arrange = initialArrangeState(0);
  viewer.onArrange((s) => {
    arrange = { ...arrange, selected: s.selected, positions: { build: s.build, music: s.music }, showMusic: s.showMusic };
  });
  arrangeChk.addEventListener("change", () => {
    viewer.setArrangeEnabled(arrangeChk.checked);
    arrange = arrangeReducer(arrange, { type: "setEnabled", enabled: arrangeChk.checked });
    canvas.style.cursor = arrangeChk.checked ? "move" : "crosshair";
  });
  arrangeTarget.addEventListener("change", () => {
    const id = arrangeTarget.value === "music" ? "music" : "build";
    viewer.selectObject(id);
    arrange = arrangeReducer(arrange, { type: "select", id });
  });
  musicToggle.addEventListener("change", () => {
    viewer.setShowMusic(musicToggle.checked);
    arrange = arrangeReducer(arrange, { type: "setShowMusic", show: musicToggle.checked });
  });
  let lastSource: ReturnType<typeof quantizeFrame> | null = null;
  let depthMap: Float32Array | null = null; // optional per-pixel depth for the current source
  // The active FLAT import (GIF/video): per-frame RGB, or null when we're showing a single solid /
  // model / sequence. Non-null ⇒ "build 3D from image" solidifies the imported subject (current frame)
  // and the animation dropdown rides a transform on top of the playing frames instead of discarding them.
  let flatFramesRgb: RgbImage[] | null = null;
  let flatLabel = ""; // hud label for the active flat import (e.g. "gif snorlax.gif")
  // True only while current3d is a sequence GENERATED from baseVolume (explode/wave/buildup) — i.e. one
  // that reverts cleanly to the single solid. Distinguishes a generated sequence from an IMPORTED
  // multi-frame animation (GIF/video/glb/obj-seq), which must NOT be discarded when a transform is picked.
  let seqFromBase = false;
  const isTransformAnim = (s: string) => (TRANSFORM_ANIMS as readonly string[]).includes(s);

  // Build a genuine 3D SOLID from the current source. imageToSolid isolates the subject from the
  // background, inflates thickness by silhouette shape (a rounded dome, not a brightness emboss),
  // and centers it on the mid-plane so it reads from EVERY angle. A real per-pixel depth map
  // (depthMap, from a depth model or a Blender depth pass) overrides the heuristic when present.
  // One volume → the viewer spins it LIVE, so there are no baked, nearest-neighbour-aliased frames
  // (the old `spin()` 24-frame turntable was the source of the "bad spin").
  function rebuildVolume(): void {
    const q = lastSource;
    if (!q) return;
    flatFramesRgb = null; // a single solid is not a flat import…
    seqFromBase = false; // …nor a generated sequence
    const maxDepth = Math.max(4, Number(depth.value));
    const depthOf =
      depthMap && depthMap.length === q.width * q.height
        ? (x: number, y: number) => depthMap![y * q.width + x]!
        : undefined;
    // shape-from-shading: per-pixel OKLab lightness of the matched block carves internal relief into
    // the dome (a bright cheek bulges, a dark socket recedes) — ignored when a real depthOf is present.
    const shadingOf = (x: number, y: number) => pal3d.entries[q.paletteIndex[y * q.width + x]!]!.lab.L;
    const vol = log.time("imageToSolid", () => imageToSolid(q, { maxDepth, depthOf, shadingOf, shadingGain: 0.5 }));
    log.debug("build3d", { dims: [vol.sx, vol.sy, vol.sz], depthMapped: !!depthOf });
    baseVolume = vol;
    current3d = [vol];
    renderBom3d(vol);
    viewer.setFrames(current3d); // single solid → live transform animation (no baked frames)
    // re-apply the chosen live animation (setFrames defaults a single volume to "spin")
    if (isTransformAnim(animSel.value)) viewer.setAnim(animSel.value);
    scrub.max = "0";
    $<HTMLButtonElement>("v3-download").disabled = false;
    viewer.play();
    playBtn.textContent = "pause";
    hud.textContent = `solid ${vol.sx}×${vol.sy}×${vol.sz}${depthOf ? " · depth-mapped" : ""} · ${animSel.value} · drag to orbit`;
  }

  // adopt a new source image (drops any stale depth map computed for the previous one)
  function setSource(q: ReturnType<typeof quantizeFrame>): void {
    lastSource = q;
    depthMap = null;
    rebuildVolume();
  }

  // The image "build 3D from image" should solidify: the SUBJECT the user imported (the currently
  // displayed frame of an active GIF/video) when one is loaded, else the §02 block-art source. This is
  // the fix for "build 3D from image builds an unrelated image" — it now follows the §03 import.
  function build3dSource(): RgbImage | null {
    if (flatFramesRgb && flatFramesRgb.length) {
      const i = Math.round(Number(scrub.value));
      const idx = Math.min(flatFramesRgb.length - 1, Math.max(0, Number.isFinite(i) ? i : 0));
      return flatFramesRgb[idx] ?? flatFramesRgb[0]!;
    }
    return ba.getSourceRgb(40);
  }

  // Build one 3D solid from an RGB source (re-quantized in the 3D palette), keeping the prior fallbacks
  // (the last source, then the preloaded sample) when nothing usable is supplied. `quant` lets a flat
  // import build with nearest (clean background isolation) while the §02 still keeps its dither.
  function buildSolidFrom(rgb: RgbImage | null, quant: Parameters<typeof quantizeFrame>[2] = QUANT3D_STILL): void {
    setSource(rgb ? quantizeFrame(rgb, pal3d, quant) : lastSource ?? quantizeFrame(rgbImageFromImg(img, 40), pal3d, QUANT3D_STILL));
  }

  // initial source = the preloaded sample image (higher res than the old 28px for a sharper solid)
  const img = new Image();
  img.onload = () => setSource(quantizeFrame(rgbImageFromImg(img, 40), pal3d, QUANT3D_STILL));
  img.src = "/test-assets/pixelart.png";

  // "build 3D from image" re-quantizes the SOURCE colors in the 3D palette - not a nearest
  // subsample of the already-dithered 2D map-palette frame (which compounds two quantizers). With a
  // GIF/video imported, it solidifies that subject's current frame; otherwise the §02 block-art source.
  $<HTMLButtonElement>("v3-rebuild").addEventListener("click", () => {
    if (flatFramesRgb) animSel.value = "spin"; // a flat clip parks the dropdown at "still" for head-on
    // playback; a freshly built solid should turntable-spin like the section copy promises.
    buildSolidFrom(build3dSource(), flatFramesRgb ? QUANT3D_FLAT_BUILD : QUANT3D_STILL);
  });
  depth.addEventListener("input", () => rebuildVolume());

  // animation selector: live transform anims (spin/bob/rock/tumble/pulse/orbit/none) apply instantly;
  // block-motion anims (explode/wave/buildup) regenerate a frame sequence from the built solid.
  animSel.addEventListener("change", () => {
    const sel = animSel.value;
    // A flat GIF/video import is a multi-frame animation whose frames ARE the content. Apply the chosen
    // animation WITHOUT discarding the import: a transform anim rides live on top of the playing frames
    // (camera swings to 3/4 so a rotation reads in depth; "still" restores head-on), while a sequence
    // anim needs a single solid, so solidify the imported subject's current frame and sequence THAT.
    if (flatFramesRgb) {
      if (isTransformAnim(sel)) {
        viewer.reframe(sel === "none"); // none → head-on; any motion → 3/4 so it reads in depth
        viewer.setAnim(sel);
        hud.textContent = `${flatLabel} · ${sel === "none" ? "head-on" : sel} · drag to orbit`;
      } else {
        buildSolidFrom(build3dSource(), QUANT3D_FLAT_BUILD); // solidify current frame (exits flat mode, sets baseVolume)
        if (baseVolume) {
          showFrames(generateSequence(sel as SequenceAnimName, baseVolume, 24), sel);
          seqFromBase = true;
        }
      }
      return;
    }
    if (isTransformAnim(sel)) {
      if (seqFromBase) rebuildVolume(); // revert a GENERATED sequence to its solid (imports are left intact)
      viewer.setAnim(sel);
      if (lastSource) hud.textContent = `${sel} · drag to orbit`;
    } else if (baseVolume) {
      showFrames(generateSequence(sel as SequenceAnimName, baseVolume, 24), sel);
      seqFromBase = true;
    }
  });

  function showFrames(frames: VoxelVolume[], label: string, durationsMs?: Array<number | undefined>, faceOn = false): void {
    current3d = frames;
    if (!faceOn) flatFramesRgb = null; // a model / sequence / solid is not a flat import…
    seqFromBase = false; // …and is not a base-derived sequence unless the caller re-sets this after
    if (frames[0]) renderBom3d(frames[0]);
    if (faceOn) animSel.value = "none"; // reflect the head-on, no-transform default in the dropdown
    viewer.setFrames(frames, { durationsMs, faceOn }); // faceOn (flat GIF/video) → head-on, no transform
    scrub.max = String(frames.length - 1);
    $<HTMLButtonElement>("v3-download").disabled = false;
    viewer.play();
    playBtn.textContent = "pause";
    hud.textContent = `${label} · ${frames.length} frame${frames.length > 1 ? "s" : ""} · drag to orbit`;
  }

  // import a real animation → block animation: a Blender glTF/.glb (node-TRS animation sampled to
  // frames), an .obj-per-frame sequence (select multiple), a single .obj model, an animated .gif,
  // a VIDEO file (.mp4/.webm/.mov — decoded natively in the browser, no ffmpeg), or a still image
  // (→ a 3D solid the viewer spins). Files arrive from the picker, a drag-drop, OR a pasted URL —
  // all three funnel through importFiles so every source gets the identical pipeline.
  async function importFiles(files: File[]): Promise<void> {
    if (!files.length) return;
    viewer.pause(); // stop the render loop overwriting the status line
    flatFramesRgb = null; // a fresh import invalidates the prior flat import (re-set below on success)
    current3dMusic = []; // a fresh import drops any prior video's note-block music
    viewer.setMusicArea([]);
    musicToggle.disabled = true;
    playBtn.textContent = "play";
    hud.textContent = `importing ${files.length > 1 ? `${files.length} files` : files[0]!.name}…`;
    try {
      const objs = files.filter((f) => /\.obj$/i.test(f.name));
      const glb = files.find((f) => /\.glb$/i.test(f.name));
      const gltf = files.find((f) => /\.gltf$/i.test(f.name));
      const gif = files.find((f) => /\.gif$/i.test(f.name) || f.type === "image/gif");
      const video = files.find((f) => isVideoFile(f));
      const image = files.find((f) => f.type.startsWith("image/")); // any still image (gif handled above)
      if (glb) {
        showFrames(glbToFrames(await glb.arrayBuffer(), { frames: 24, resolution: 40, mapColorId: grayId, matchColor: match3d }), `glb ${glb.name}`);
      } else if (gltf) {
        showFrames(gltfToFrames(await gltf.text(), { frames: 24, resolution: 40, mapColorId: grayId, matchColor: match3d }), `glTF ${gltf.name}`);
      } else if (objs.length > 1) {
        const texts = await Promise.all(objs.sort((a, b) => a.name.localeCompare(b.name)).map((f) => f.text()));
        showFrames(objSequenceToFrames(texts, { resolution: 40, mapColorId: grayId, matchColor: match3d }), `obj-seq ×${texts.length}`);
      } else if (objs.length === 1) {
        showFrames([objToVolume(await objs[0]!.text(), { resolution: 40, mapColorId: grayId, solid: true, matchColor: match3d })], `model ${objs[0]!.name}`);
      } else if (gif) {
        // animated GIF → FLAT, faithful per-frame block animation. A 2D motion graphic has no "subject"
        // to lift off a "background"; the OLD dome-inflation path turned it into a boiling blob. Here the
        // front face of each thin slab IS the source frame, block-for-block — the frames ARE the motion,
        // played at the GIF's real per-frame timing. Transparent pixels (canvas alpha) map to air.
        const { canvases, durationsMs } = await decodeGif(gif);
        const gw = flatGridWidth(canvases.length, (canvases[0]!.height || 3) / (canvases[0]!.width || 4));
        const decoded = canvases.map((c) => rgbAndAirFromCanvas(c, gw));
        const rgb = decoded.map((d) => d.rgb);
        const frames = rgbFramesToFlat3d(rgb, pal3d, {
          depth: 2,
          isAirForFrame: (f, x, y) => decoded[f]!.air[y * rgb[f]!.width + x] === 1,
        });
        showFrames(frames, `gif ${gif.name} · flat`, durationsMs, true);
        flatFramesRgb = rgb; // remember the imported frames so build-from-image / transforms follow them
        flatLabel = `gif ${gif.name}`;
      } else if (video) {
        // VIDEO → same FLAT faithful per-frame block animation (decoded natively in the browser). Video
        // has no transparency, so the air mask is empty and the full frame is reproduced as blocks.
        const { canvases, durationsMs } = await decodeVideo(video, { fps: 12, maxFrames: 48 });
        if (!canvases.length) throw new Error("no frames decoded from video");
        const gw = flatGridWidth(canvases.length, (canvases[0]!.height || 9) / (canvases[0]!.width || 16));
        const decoded = canvases.map((c) => rgbAndAirFromCanvas(c, gw));
        const rgb = decoded.map((d) => d.rgb);
        const frames = rgbFramesToFlat3d(rgb, pal3d, {
          depth: 2,
          isAirForFrame: (f, x, y) => decoded[f]!.air[y * rgb[f]!.width + x] === 1,
        });
        showFrames(frames, `video ${video.name} · flat`, durationsMs, true);
        flatFramesRgb = rgb; // remember the imported frames so build-from-image / transforms follow them
        flatLabel = `video ${video.name}`;
        // If the clip carries audio, transcribe it to a note-block music timeline + a draggable music
        // area beside the build (kept on builder state for the toggle + datapack export). Audio never
        // blocks the visual import.
        try {
          current3dMusic = await analyzeFileAudio(video);
          if (current3dMusic.length) {
            const v0 = frames[0];
            const offset = v0 ? Math.max(v0.sx, v0.sy, v0.sz) : 12; // park the music area clear of the build
            viewer.setMusicArea(current3dMusic);
            viewer.setObjectPosition("music", offset, 0);
            viewer.setShowMusic(true);
            musicToggle.disabled = false;
            musicToggle.checked = true;
            arrange = arrangeReducer(arrange, { type: "move", id: "music", to: { x: offset, z: 0 } });
            arrange = arrangeReducer(arrange, { type: "setShowMusic", show: true });
            hud.textContent = `video ${video.name} · 3D · ${current3dMusic.length} note-block notes from audio · Arrange to move`;
          }
        } catch (err) {
          log.warn("audio analysis failed", err);
        }
      } else if (image) {
        // still image → a single subject-isolated 3D solid the viewer spins live (its own animation)
        const bmp = await createImageBitmap(image);
        const c = document.createElement("canvas");
        c.width = bmp.width;
        c.height = bmp.height;
        c.getContext("2d")!.drawImage(bmp, 0, 0);
        bmp.close();
        setSource(quantizeFrame(rgbImageFromCanvas(c, 40), pal3d, QUANT3D_STILL));
        hud.textContent = `image ${image.name} · 3D solid · ${animSel.value} · drag to orbit`;
      } else {
        hud.textContent = "unsupported file · use .gltf/.glb, .obj (one or many), .gif, a video (.mp4/.webm/.mov), or an image";
      }
    } catch (err) {
      log.warn("3D import failed", err);
      hud.textContent = `import failed: ${(err as Error).message}`;
    }
  }

  // Fetch a remote asset and wrap it as a File so a pasted link flows through the EXACT same import
  // pipeline as a local file. Name comes from the URL path; MIME from the response Content-Type (so a
  // gif/video whose URL has no extension still routes correctly). Needs the host to allow CORS.
  async function fetchAsFile(url: string): Promise<File> {
    const res = await fetch(url, { mode: "cors" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    const type = (res.headers.get("content-type") ?? blob.type ?? "").split(";")[0]!.trim();
    let name = "import";
    try {
      name = new URL(url).pathname.split("/").filter(Boolean).pop() || name;
    } catch {
      /* non-URL string → keep the fallback name; fetch will throw a clear error */
    }
    return new File([blob], name, { type: type || blob.type });
  }

  $<HTMLInputElement>("v3-import").addEventListener("change", (ev) => {
    void importFiles(Array.from((ev.target as HTMLInputElement).files ?? []));
  });

  // paste a link (the Dribbble GIF, a video, any CORS-friendly image) → fetched → same block pipeline
  const urlInput = $<HTMLInputElement>("v3-url");
  async function importUrl(): Promise<void> {
    const url = urlInput.value.trim();
    if (!url) return;
    hud.textContent = `fetching ${url}…`;
    try {
      await importFiles([await fetchAsFile(url)]);
    } catch (err) {
      log.warn("URL import failed", err);
      hud.textContent = `URL import failed: ${(err as Error).message} — the host may block cross-origin fetch (CORS)`;
    }
  }
  $<HTMLButtonElement>("v3-url-go").addEventListener("click", () => void importUrl());
  urlInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") void importUrl();
  });

  // Download a vanilla datapack that builds the 3D spin animation (fill-batched). The export carries
  // the on-screen arrangement: the build spawns at its dragged origin, and — when the video had audio
  // AND the note-block toggle is on — the note-block music area + sequencer at ITS dragged origin.
  $<HTMLButtonElement>("v3-download").addEventListener("click", () => {
    if (!current3d.length) return;
    // the viewer centers the build + the note-block row on their group positions; pass each object's
    // half-extent so the export lands them centered where they sit on screen (not corner-offset).
    const v0 = current3d[0];
    const distinctNotes = new Set(current3dMusic.map((n) => n.note)).size;
    const placement = planDatapackPlacement(current3dMusic, arrange, { x: 0, y: 64, z: 0 }, {
      buildHalf: v0 ? { x: v0.sx / 2, z: v0.sz / 2 } : undefined,
      musicHalf: { x: (distinctNotes - 1) / 2, z: 0 },
    });
    const pack = generateVoxelDatapack(current3d, resolveBlock, {
      namespace: "blockdream_3d",
      supportedFormats: JAVA_DATAPACK_SUPPORTED,
      optimize: (cells, r) => greedyBoxes(cells, r),
      origin: placement.origin,
      music: placement.music,
      musicOrigin: placement.musicOrigin,
    });
    const cmds = pack.totalCommands ?? pack.totalSetblocks;
    const musicNote = placement.music ? ` · ${placement.music.length} note-block notes` : "";
    $<HTMLDivElement>("v3-export").textContent =
      `3D datapack: ${pack.totalSetblocks} blocks → ${cmds} cmds · ${pack.frameCount} frames${musicNote} · /function blockdream_3d:setup`;
    downloadDatapack("blockdream-3d-datapack", pack.files);
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
}
void setup3dViewer();

// Scroll-reveal: sections fade + rise a little as they enter view (tha.jp — restrained motion
// modeled on natural deceleration; easing/duration live in style.css). The class is added by JS,
// so with no JS the content is simply visible; reduced-motion or no IntersectionObserver also
// leave everything visible. Hero + first section are left untouched so the fold paints instantly.
function setupReveal(): void {
  const targets = Array.from(document.querySelectorAll<HTMLElement>("[data-reveal]"));
  if (!targets.length) return;
  const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  if (reduce || !("IntersectionObserver" in window)) return; // leave fully visible
  for (const el of targets) el.classList.add("reveal");
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (e.isIntersecting) {
          e.target.classList.add("in");
          io.unobserve(e.target);
        }
      }
    },
    { rootMargin: "0px 0px -8% 0px", threshold: 0.08 },
  );
  for (const el of targets) io.observe(el);
}
setupReveal();
