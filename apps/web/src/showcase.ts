// One-page showcase: both neural world models (auto-connecting, decoupled-smooth) and
// the block-art tester, on a single page. Each canvas captures keys only while focused
// so the two worlds don't fight over the keyboard.

import "./style.css"; // design system: tokens (sumi/washi palette, type/space/motion scale) + base layer
import { Viewer } from "./viewer";
import { actionFromKeys } from "./action";
import { controlFromKeys } from "./driveAction";
import { createBlockArt, wireBlockArtDrop } from "./blockart-core";
import { planGifExport, gifExportPacing, tickPlanDurations, packingHudText, reportPngDownload } from "./export-plan";
import { preparePalette, quantizeFrame, nearestSrgbHue, type RgbImage, type DitherMethod } from "@blockdream/color-core";
import { quantizeForDatapack } from "./blockart-export";
import { getSolidBlockMapPalette } from "@blockdream/palette/solid";
// Pure-data subpath (no node:fs/url) so the browser bundle never pulls in the fs-based palette loaders.
import { JAVA_DATAPACK_SUPPORTED } from "@blockdream/palette/versions";
import {
  imageToSolid,
  imageToFlat,
  objToVolume,
  objSequenceToFrames,
  gltfToFrames,
  glbToFrames,
  generateSequence,
  generateSequenceOverFrames,
  spinSequence,
  EMPTY,
  type SequenceAnimName,
  type VoxelVolume,
} from "@blockdream/voxel";
import { animSourceFor, isTransformAnim, spinExportVolume } from "./anim-source";
import { classifyImportFile } from "./import-files";
import { rgbFramesToFlat3d, rgbFramesToAnimated3d } from "./video3d";
import { decodeVideo } from "./video";
import { ClipAudio, type ClipAudioMode } from "./clip-audio";
import { analyzeFileAudio } from "./audio";
import { NotePreview, previewTickWindow } from "./note-preview";
import type { NoteEvent } from "@blockdream/audio";
import { initialArrangeState, arrangeReducer, planDatapackPlacement, musicKeyboardHalf } from "./canvas-mod";
import {
  SECTION3_CONTROL_IDS,
  IMPORT_TRIGGER_IDS,
  importBusyText,
  IMPORT_CANCELLED_TEXT,
  gifCapNote,
  audioAnalysisFailedText,
  viewer3dUnavailableText,
  VIEWER3D_CONTEXT_LOST_TEXT,
  VIEWER3D_CONTEXT_RESTORED_TEXT,
  AUDIO_BLOCKED_TEXT,
  settingsChangeNote,
  blockArtExportText,
  resetDisabled,
} from "./ui-feedback";
import { log } from "./log";
import { generateJavaDatapack, generateVoxelDatapack, greedyBoxes } from "@blockdream/emit-commands";
import { Viewer3D } from "./viewer3d";
import { localTextureUrl, faceTextureUrl, loadTextureManifest, hasLocalTextures, swatchDataUrl } from "./blocks";
import { resolveBlock, safeBlockInfo } from "./resolve-block";
import { volumeBom } from "./bom3d";
import { downloadDatapack, planExportBudget, planTickPlayback, type TickPlan } from "./datapack-export";
import {
  quantizedToRaster,
  flatVolumeToRaster,
  upscaleNearest,
  padRaster,
  fitScale,
  downloadPng,
  downloadGif,
  type GifFrame,
} from "./pixel-export";
import { decodeGif } from "./gif";
import { buildHexTable, rgbFromFlatVol as rgbFromFlatVolTable } from "./render-tables";

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
  onStatus: (t, cls) => {
    pill(mcStatus, cls === "ok" ? `live · ${mcSkill.value}` : t, cls);
    // reset only does anything while connected - follow the same transitions as the pill
    $<HTMLButtonElement>("mc-reset").disabled = resetDisabled(cls);
  },
});
$<HTMLButtonElement>("mc-reset").addEventListener("click", () => mcViewer.reset());
// retry affordance: without local servers the auto-connect fails once and the section used to be
// a dead end - reconnect re-runs the same connect the page does on load (Connect-button pattern
// from the standalone driving.html / world-model.html testers).
$<HTMLButtonElement>("mc-connect").addEventListener("click", () => mcViewer.connect());
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
  onStatus: (t, cls) => {
    pill(drStatus, cls === "ok" ? "live" : t, cls);
    $<HTMLButtonElement>("dr-reset").disabled = resetDisabled(cls);
  },
});
$<HTMLButtonElement>("dr-reset").addEventListener("click", () => drViewer.reset());
$<HTMLButtonElement>("dr-connect").addEventListener("click", () => drViewer.connect());

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
    // both exports need a frame: enable them together (PNG used to ship enabled and silently
    // no-op when clicked before the first render)
    $<HTMLButtonElement>("ba-download").disabled = false;
    $<HTMLButtonElement>("ba-png").disabled = false;
    // an animated GIF exports its CURRENT frame here - the status says so instead of "1 frame"
    $<HTMLDivElement>("ba-export").textContent = blockArtExportText(q.width, q.height, ba.getFrameCount());
  },
});
ba.loadUrl("/test-assets/pixelart.png"); // preload sample so the section is alive on load

// drag & drop an image onto the block-art canvases - shared wiring (same helper as blockart.html)
wireBlockArtDrop($<HTMLDivElement>("ba-drop"), $<HTMLDivElement>("ba-stats"), (f) => ba.loadFile(f));

// Download a vanilla datapack that builds the current image as a block-wall. Export parity:
// the pack RE-QUANTIZES the source against the placeable solid-block palette (the preview's
// map-palette frame resolved through the solid resolver left air holes + collapsed blocks),
// so every emitted cell places a real block - the wall is exactly a solid-palette preview.
$<HTMLButtonElement>("ba-download").addEventListener("click", () => {
  const rgb = ba.getSourceRgb(Number($<HTMLInputElement>("ba-grid").value) || 128);
  if (!rgb) return;
  const q = quantizeForDatapack(rgb, $<HTMLSelectElement>("ba-dither").value as DitherMethod);
  const pack = generateJavaDatapack([q], resolveBlock, {
    namespace: "blockdream",
    supportedFormats: JAVA_DATAPACK_SUPPORTED,
  });
  const animatedNote =
    ba.getFrameCount() > 1 ? " · animated GIF: current frame only - use section 03 for the full animation" : "";
  $<HTMLDivElement>("ba-export").textContent = `datapack: ${pack.totalSetblocks} setblocks · ${pack.frameCount} frame · load /function blockdream:setup${animatedNote}`;
  downloadDatapack("blockdream-blockart-datapack", pack.files);
});

// Download the block-art as a crisp PNG (the pixel/block image itself, integer-upscaled so it never
// blurs) - the "save it as an image" companion to the Minecraft datapack export.
$<HTMLButtonElement>("ba-png").addEventListener("click", () => {
  const q = ba.getFrame();
  if (!q) return;
  const raster = upscaleNearest(quantizedToRaster(q), fitScale(q.width, q.height, 512));
  // honest status: success text only once the encode resolved; a rejection ("PNG encode
  // failed") lands in the same line instead of an unhandled rejection under a success claim.
  void reportPngDownload(
    downloadPng("blockdream-blockart.png", raster),
    $<HTMLDivElement>("ba-export"),
    `PNG: ${raster.width}×${raster.height} px`,
  );
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
// Quantization for any 3D SOLID build (a flat GIF/video subject OR an imported still image). A solid is
// isolated by detectBackgroundMask, which flood-fills cells matching the EXACT dominant border block id;
// nearest (no dither) keeps a flat background ONE block so the flood can sweep it away and lift the
// subject, and keeps the solid itself speckle-free. Floyd–Steinberg would scatter the flat field into
// dithered islands that block the flood, leaving the whole rectangle a slab (the mint box around the
// Snorlax). So 3D-solid builds use this; only the §02 / init flat stills keep QUANT3D_STILL's dither.
const QUANT3D_SOLID = { method: "none", gamutMap: 0.8 } as const;
// Flat clips (GIF/video walls) quantize with position-deterministic bayer at low amplitude - the
// same default rgbFramesToFlat3d uses - so the streaming per-frame path matches the batch path.
const QUANT_FLAT = { method: "bayer", gamutMap: 0.8, bayerAmplitude: 0.035 } as const;
// Memory budget (bytes ≈ voxels) for a whole clip's frame volumes. Bounds resolution, wall depth,
// and dome depth together: frames × w × h × depth must stay under it or the browser tab dies.
const CLIP_VOXEL_BUDGET = 360e6;
// Grid width for an imported still image's 3D solid. Well above the old 40px (which made the subject
// tiny + blocky) - a single still has no per-frame temporal cost, so it can afford detail; bounded so
// the inflated solid's block count + datapack stay sane. rgbImageFromCanvas clamps to the source width,
// so a small sprite is never upscaled past its native pixels.
const STILL_SOLID_GRID = 96;
// single-color OKLab match for 3D model imports (vertex colors / material colors → blocks)
const match3d = (r: number, g: number, b: number) => nearestSrgbHue(r, g, b, pal3d, 0.8).color.mapColorId;
// Dense 256-slot hex table (module init) replacing the old per-pixel Map lookup. Serves BOTH
// call sites: the viewer's colorFor and rgbFromFlatVol's whole-clip double loop - the hot
// loop itself lives in render-tables.ts (byte-locked + perf-gated in render-tables-perf).
const hexByMap = buildHexTable(pal3d.entries);

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
// cap - both far above the old fixed 64. Bayer keeps flat regions merged, so this budget tracks geometry.
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
  const notePreview = new NotePreview(); // browser-audible note blocks, synced by onFrame below
  const clipAudio = new ClipAudio(); // the imported clip's ORIGINAL soundtrack, synced by onFrame below
  const fpsSel = $<HTMLSelectElement>("v3-fps");
  const resSel = $<HTMLSelectElement>("v3-res");
  const audioModeSel = $<HTMLSelectElement>("v3-audio-mode");
  // autoplay-policy rejections used to be swallowed - both audio paths now surface one message
  clipAudio.onAutoplayBlocked = notePreview.onAutoplayBlocked = () => {
    hud.textContent = AUDIO_BLOCKED_TEXT;
  };
  // GIF/PNG ship disabled like the datapack button (index.html) - all three need frames;
  // every path that produces frames enables them together.
  function enable3dExports(): void {
    for (const id of ["v3-download", "v3-gif", "v3-png"]) $<HTMLButtonElement>(id).disabled = false;
  }
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
    colorFor: (id) => hexByMap[id & 255]!,
    onFrame: (i, n) => {
      scrub.value = String(i);
      hud.textContent = `frame ${i + 1}/${n} · drag to orbit`;
      // audio, per the audio-mode select. "original": the clip's own soundtrack follows the frame
      // clock (only when the shown frames carry the clip's real timing - an effect sequence has its
      // own uniform clock, so the soundtrack pauses rather than desync). "note blocks": the synth
      // preview of the in-game datapack sound, frame-windowed. Scrubbing while paused stays silent.
      clipAudio.frameShown(i, viewer.isPlaying && !!current3dDurations);
      if (viewer.isPlaying && current3dDurations && audioModeSel.value === "noteblocks") {
        // Preview pacing == pack pacing: the SAME tick plan the datapack export uses decides
        // each frame's tick window (uniform speedTicks dwell + the loop trim at kept-frames ×
        // speedTicks). The old per-frame round(rawDuration/50) let a 30 fps import preview the
        // whole melody while the pack's locked music loop dropped everything past its trim.
        if (previewPlan === null || previewPlanFor !== current3dDurations) {
          previewPlan = planTickPlayback(current3d.length, tickPlanDurations(current3dDurations));
          previewPlanFor = current3dDurations;
        }
        const w = previewTickWindow(previewPlan, i);
        notePreview.windowShown(w.t0, w.t1);
      }
    },
    // GPU reset mid-session: the renderer used to keep rAF-ing into the dead context - a frozen
    // black canvas with every control still live. Now the section pauses, disables, and explains
    // (same disable-and-explain surface as the construction-failure catch below).
    onContextLost: () => {
      playBtn.textContent = "play";
      clipAudio.pause();
      hud.textContent = VIEWER3D_CONTEXT_LOST_TEXT;
      for (const id of SECTION3_CONTROL_IDS) $<HTMLButtonElement>(id).disabled = true;
    },
    onContextRestored: () => {
      for (const id of SECTION3_CONTROL_IDS) $<HTMLButtonElement>(id).disabled = false;
      // re-enabling everything must not over-promise: exports need frames, the note-block
      // toggle needs a transcription, and an in-flight import keeps its triggers locked.
      if (!current3d.length) for (const id of ["v3-download", "v3-gif", "v3-png"]) $<HTMLButtonElement>(id).disabled = true;
      musicToggle.disabled = current3dMusic.length === 0;
      setImportBusy(importing);
      hud.textContent = VIEWER3D_CONTEXT_RESTORED_TEXT;
    },
  });

  const depth = $<HTMLInputElement>("v3-depth");
  let current3d: VoxelVolume[] = [];
  // per-frame dwell (ms) of the frames currently shown - the real GIF/video timing, so a pixel-format
  // GIF export replays at the source's speed. null ⇒ uniform (a baked spin / block-motion sequence).
  let current3dDurations: Array<number | undefined> | null = null;
  let flatDurationsMs: Array<number | undefined> | null = null; // the active flat clip's timing (for restore)
  // memoized tick plan for the note-block preview (recomputed when the shown timing changes) -
  // the preview windows come from the SAME plan the datapack export builds, never a per-frame guess
  let previewPlan: TickPlan | null = null;
  let previewPlanFor: unknown = null;
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
  // the note-block SYNTH previews the in-game datapack sound: audible only in "note blocks" audio
  // mode AND with the note-block area toggled on (the toggle also hides the area in the scene).
  const noteSynthOn = (): boolean => audioModeSel.value === "noteblocks" && musicToggle.checked;
  musicToggle.addEventListener("change", () => {
    viewer.setShowMusic(musicToggle.checked);
    notePreview.setEnabled(noteSynthOn());
    arrange = arrangeReducer(arrange, { type: "setShowMusic", show: musicToggle.checked });
  });
  audioModeSel.addEventListener("change", () => {
    clipAudio.setMode(audioModeSel.value as ClipAudioMode);
    notePreview.setEnabled(noteSynthOn());
  });
  clipAudio.setMode(audioModeSel.value as ClipAudioMode);
  notePreview.setEnabled(noteSynthOn()); // default mode is "original" → synth starts silent
  let lastSource: ReturnType<typeof quantizeFrame> | null = null;
  let depthMap: Float32Array | null = null; // optional per-pixel depth for the current source
  // The active FLAT import (GIF/video): per-frame RGB, or null when we're showing a single solid /
  // model / sequence. Non-null ⇒ "build 3D from image" solidifies the imported subject (current frame)
  // and the animation dropdown rides a transform on top of the playing frames instead of discarding them.
  let flatFramesRgb: RgbImage[] | null = null;
  let flatLabel = ""; // hud label for the active flat import (e.g. "gif snorlax.gif")
  // The imported clip's plain FLAT VoxelVolume frames (un-effected). Kept so a block-motion anim
  // (wave/explode/buildup) can play OVER the animation (content keeps advancing + the effect rides on
  // top), and so switching back to a transform anim restores the plain clip. Cleared when flat mode exits.
  let flatVolFrames: VoxelVolume[] | null = null;
  // True only while current3d is a sequence GENERATED from baseVolume (explode/wave/buildup) - i.e. one
  // that reverts cleanly to the single solid. Distinguishes a generated sequence from an IMPORTED
  // multi-frame animation (GIF/video/glb/obj-seq), which must NOT be discarded when a transform is picked.
  let seqFromBase = false;
  // The plain frames of an active MODEL import (glb/glTF/obj-seq/single obj). Kept so a block-motion
  // anim (wave/explode/buildup) generates OVER the import instead of falling back to the stale
  // baseVolume (which still points at the previously built solid) and silently discarding it.
  let importedFrames: VoxelVolume[] | null = null;

  // Build a genuine 3D SOLID from the current source. imageToSolid isolates the subject from the
  // background, inflates thickness by silhouette shape (a rounded dome, not a brightness emboss),
  // and centers it on the mid-plane so it reads from EVERY angle. A real per-pixel depth map
  // (depthMap, from a depth model or a Blender depth pass) overrides the heuristic when present.
  // One volume → the viewer spins it LIVE, so there are no baked, nearest-neighbour-aliased frames
  // (the old `spin()` 24-frame turntable was the source of the "bad spin").
  function rebuildVolume(): void {
    const q = lastSource;
    if (!q) return;
    flatFramesRgb = null; // a single solid is not a flat import, nor a base-derived sequence,
    flatVolFrames = null; // nor an imported clip or model
    importedFrames = null;
    seqFromBase = false;
    const maxDepth = Math.max(4, Number(depth.value));
    const depthOf =
      depthMap && depthMap.length === q.width * q.height
        ? (x: number, y: number) => depthMap![y * q.width + x]!
        : undefined;
    // shape-from-shading: per-pixel OKLab lightness of the matched block carves internal relief into
    // the dome (a bright cheek bulges, a dark socket recedes) - ignored when a real depthOf is present.
    const shadingOf = (x: number, y: number) => pal3d.entries[q.paletteIndex[y * q.width + x]!]!.lab.L;
    const vol = log.time("imageToSolid", () => imageToSolid(q, { maxDepth, depthOf, shadingOf, shadingGain: 0.5 }));
    log.debug("build3d", { dims: [vol.sx, vol.sy, vol.sz], depthMapped: !!depthOf });
    baseVolume = vol;
    current3d = [vol];
    current3dDurations = null; // a single solid spins live; a GIF export bakes the spin at uniform timing
    renderBom3d(vol);
    viewer.setFrames(current3d); // single solid → live transform animation (no baked frames)
    // re-apply the chosen live animation (setFrames defaults a single volume to "spin")
    if (isTransformAnim(animSel.value)) viewer.setAnim(animSel.value);
    scrub.max = "0";
    enable3dExports();
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

  // Reconstruct an RGB image from a flat wall frame's FRONT layer (palette colour per block).
  // Whole-video clips are too long to keep their raw decoded RGB in memory; the wall itself is the
  // compact record, and its palette colours are exactly what any re-quantize would land on anyway.
  // The per-pixel hot loop lives in render-tables.ts, fed by the module-init dense hex table.
  const rgbFromFlatVol = (v: VoxelVolume): RgbImage => rgbFromFlatVolTable(v, hexByMap);

  // The image "build 3D from image" should solidify: the SUBJECT the user imported (the currently
  // displayed frame of an active GIF/video) when one is loaded, else the §02 block-art source. This is
  // the fix for "build 3D from image builds an unrelated image" - it now follows the §03 import.
  function build3dSource(): RgbImage | null {
    const clip = flatFramesRgb ?? flatVolFrames;
    if (clip && clip.length) {
      const i = Math.round(Number(scrub.value));
      const idx = Math.min(clip.length - 1, Math.max(0, Number.isFinite(i) ? i : 0));
      return flatFramesRgb ? flatFramesRgb[idx] ?? flatFramesRgb[0]! : rgbFromFlatVol(flatVolFrames![idx] ?? flatVolFrames![0]!);
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
  img.onerror = () => {
    // 404 / undecodable sample used to leave the section at "building…" forever - say what
    // happened and how to proceed (pattern from blockart-core's loadUrl onerror).
    hud.textContent = "couldn't load the sample /test-assets/pixelart.png · import an image, GIF, or video to build";
  };
  img.src = "/test-assets/pixelart.png";

  // Re-extrude a flat wall frame to a new thickness: copy the front layer (z=0) into every layer of
  // a fresh volume. Pure array work - no re-decode, no re-quantize - so the depth slider is instant
  // even on a whole-video clip.
  function reExtrudeFlat(v: VoxelVolume, depthN: number): VoxelVolume {
    const { sx, sy } = v;
    const layer = sx * sy;
    const data = new Uint8Array(layer * depthN).fill(EMPTY);
    for (let i = 0; i < layer; i++) {
      const c = v.data[i]!;
      if (c === EMPTY) continue;
      for (let z = 0; z < depthN; z++) data[i + z * layer] = c;
    }
    return { sx, sy, sz: depthN, data };
  }

  // Largest per-frame depth the clip can afford under the voxel budget (≥1).
  function clipDepthBudget(frames: VoxelVolume[]): number {
    const v0 = frames[0]!;
    return Math.max(1, Math.floor(CLIP_VOXEL_BUDGET / (frames.length * v0.sx * v0.sy)));
  }

  // "build 3D from image" re-quantizes the SOURCE colors in the 3D palette - not a nearest
  // subsample of the already-dithered 2D map-palette frame (which compounds two quantizers).
  // With a multi-frame clip imported it builds the WHOLE ANIMATION in 3D (subject-isolated dome
  // per frame, temporally stabilized) - not the old behaviour of freezing a single frame. With a
  // still (or the §02 source) it builds the single spinning solid as before.
  $<HTMLButtonElement>("v3-rebuild").addEventListener("click", () => {
    if (flatVolFrames && flatVolFrames.length > 1) {
      const clip = flatVolFrames;
      const n = clip.length;
      // dome volumes are dense (w×h×maxDepth bytes per frame): the affordable depth shrinks with
      // clip length. Below a useful dome, keep the flat wall and say so instead of a fake build.
      const maxDepth = Math.min(Math.max(4, Number(depth.value)), clipDepthBudget(clip));
      if (maxDepth < 4) {
        hud.textContent = `${flatLabel} · clip too long for a 3D dome build - use the depth slider to thicken the wall`;
        return;
      }
      hud.textContent = `building 3D animation: ${n} frames at depth ${maxDepth}…`;
      setTimeout(() => {
        // (timeout lets the HUD paint before the synchronous per-frame build)
        const rgbFrames = flatFramesRgb ?? clip.map(rgbFromFlatVol);
        const domed = rgbFramesToAnimated3d(rgbFrames, pal3d, { maxDepth });
        current3d = domed;
        current3dDurations = flatDurationsMs;
        if (domed[0]) renderBom3d(domed[0]);
        animSel.value = "none"; // the frames are the motion; 3/4 view makes the new depth read
        viewer.setFrames(domed, { durationsMs: flatDurationsMs ?? undefined, faceOn: false });
        scrub.max = String(domed.length - 1);
        enable3dExports();
        viewer.play();
        playBtn.textContent = "pause";
        hud.textContent = `${flatLabel} · 3D · ${n} frames · drag to orbit`;
      }, 30);
      return;
    }
    if (flatVolFrames) animSel.value = "spin"; // a flat clip parks the dropdown at "still" for head-on
    // playback; a freshly built solid should turntable-spin like the section copy promises.
    buildSolidFrom(build3dSource(), flatVolFrames ? QUANT3D_SOLID : QUANT3D_STILL);
  });
  depth.addEventListener("input", () => {
    if (flatVolFrames && flatVolFrames.length) {
      // clip active: the slider re-extrudes the WALL thickness per frame. (It used to rebuild the
      // default still solid - discarding the playing animation - the "resets to default" bug.)
      const d = Math.max(1, Math.min(Math.round(Number(depth.value) / 3), clipDepthBudget(flatVolFrames)));
      if (d === flatVolFrames[0]!.sz) return;
      const playing = viewer.isPlaying;
      const thick = flatVolFrames.map((v) => reExtrudeFlat(v, d));
      flatVolFrames = thick;
      current3d = thick;
      current3dDurations = flatDurationsMs;
      if (thick[0]) renderBom3d(thick[0]);
      viewer.setFrames(thick, { durationsMs: flatDurationsMs ?? undefined, faceOn: animSel.value === "none" });
      scrub.max = String(thick.length - 1);
      if (isTransformAnim(animSel.value)) viewer.setAnim(animSel.value);
      if (playing) {
        viewer.play();
        playBtn.textContent = "pause";
      }
      hud.textContent = `${flatLabel} · wall ${d} block${d > 1 ? "s" : ""} thick`;
      return;
    }
    rebuildVolume();
  });

  // animation selector: live transform anims (spin/bob/rock/tumble/pulse/orbit/none) apply instantly;
  // block-motion anims (explode/wave/buildup) regenerate a frame sequence from the RIGHT source.
  // WHICH content each choice must use is the pure decision in anim-source.ts (unit-tested there):
  // a flat GIF/video clip rides/effects the clip, a model import effects the IMPORT (not the stale
  // built solid), a still build effects baseVolume, and transforms apply to whatever is shown.
  animSel.addEventListener("change", () => {
    const sel = animSel.value;
    const src = animSourceFor(sel, { flatVolFrames, importedFrames, baseVolume, seqFromBase, current3d });
    switch (src.kind) {
      case "clip-transform": {
        // a block-motion effect (wave/explode/buildup) may have replaced the plain clip; restore it so
        // the transform rides on the ACTUAL animation frames, not a frozen effected sequence.
        if (src.restore) {
          current3d = src.frames;
          current3dDurations = flatDurationsMs; // restoring the clip restores its real timing
          if (src.frames[0]) renderBom3d(src.frames[0]);
          viewer.setFrames(src.frames, { faceOn: sel === "none" });
          scrub.max = String(src.frames.length - 1);
          enable3dExports();
          playBtn.textContent = viewer.isPlaying ? "pause" : "play";
        }
        viewer.reframe(sel === "none"); // none → head-on; any motion → 3/4 so it reads in depth
        viewer.setAnim(sel);
        hud.textContent = `${flatLabel} · ${sel === "none" ? "head-on" : sel} · drag to orbit`;
        break;
      }
      case "clip-sequence": {
        // block-motion effect (wave/explode/buildup) applied OVER the playing clip: the animation keeps
        // advancing (frame f uses clip[f % N]) while the effect displaces it, instead of the old
        // behaviour that froze one frame, solidified it, and animated only that (losing the animation).
        const combined = generateSequenceOverFrames(sel as SequenceAnimName, src.frames);
        current3d = combined;
        current3dDurations = null; // the effect resamples to its own frame count → uniform playback
        if (combined[0]) renderBom3d(combined[0]);
        viewer.setFrames(combined, { faceOn: false }); // 3/4 view so the displacement reads; frames carry the motion
        scrub.max = String(combined.length - 1);
        enable3dExports();
        viewer.play();
        playBtn.textContent = "pause";
        hud.textContent = `${flatLabel} · ${sel} · playing · drag to orbit`;
        break;
      }
      case "shown-transform": {
        if (src.revertToBase) rebuildVolume(); // revert a GENERATED sequence to its solid (imports are left intact)
        viewer.setAnim(sel);
        if (lastSource) hud.textContent = `${sel} · drag to orbit`;
        break;
      }
      case "import-sequence": {
        // the effect rides OVER the imported model's plain frames (frame f displaces import[f % N]),
        // NOT the stale baseVolume - which still points at the previously built solid and would
        // silently discard the import. showFrames leaves importedFrames set, so re-picking another
        // effect starts again from the PLAIN import (no effect-on-effect compounding).
        showFrames(generateSequenceOverFrames(sel as SequenceAnimName, src.frames), sel);
        break;
      }
      case "base-sequence": {
        showFrames(generateSequence(sel as SequenceAnimName, src.volume, 24), sel);
        seqFromBase = true;
        break;
      }
      case "none":
        break;
    }
  });

  function showFrames(frames: VoxelVolume[], label: string, durationsMs?: Array<number | undefined>, faceOn = false): void {
    current3d = frames;
    current3dDurations = durationsMs && durationsMs.length ? durationsMs : null;
    if (!faceOn) {
      flatFramesRgb = null;
      flatVolFrames = null;
    } // a model / sequence / solid is not a flat import…
    seqFromBase = false; // …and is not a base-derived sequence unless the caller re-sets this after
    if (frames[0]) renderBom3d(frames[0]);
    if (faceOn) animSel.value = "none"; // reflect the head-on, no-transform default in the dropdown
    viewer.setFrames(frames, { durationsMs, faceOn }); // faceOn (flat GIF/video) → head-on, no transform
    scrub.max = String(frames.length - 1);
    enable3dExports();
    viewer.play();
    playBtn.textContent = "pause";
    hud.textContent = `${label} · ${frames.length} frame${frames.length > 1 ? "s" : ""} · drag to orbit`;
  }

  // A MODEL import (glb/glTF/obj-seq/single obj): show it and remember its plain frames so the
  // animation selector can generate a block-motion effect over the IMPORT (see anim-source.ts).
  function showImported(frames: VoxelVolume[], label: string): void {
    showFrames(frames, label);
    importedFrames = frames;
  }

  // Re-entrancy guard + cancel for the import pipeline. All three entry points (picker, drop,
  // URL) are fire-and-forget; two interleaved imports would race the state reset above the try
  // against the other's post-decode writes and corrupt the flatVolFrames/flatDurationsMs
  // pairing. While one runs: the triggers are disabled, a second request is refused with a
  // clear HUD line, and the visible cancel button aborts the decode cleanly (no state write).
  let importing = false;
  let importAbort: AbortController | null = null;
  const cancelBtn = $<HTMLButtonElement>("v3-cancel");
  function setImportBusy(busy: boolean): void {
    for (const id of IMPORT_TRIGGER_IDS) $<HTMLButtonElement>(id).disabled = busy;
    cancelBtn.hidden = !busy;
  }
  cancelBtn.addEventListener("click", () => importAbort?.abort());

  // import a real animation → block animation: a Blender glTF/.glb (node-TRS animation sampled to
  // frames), an .obj-per-frame sequence (select multiple), a single .obj model, an animated .gif,
  // a VIDEO file (.mp4/.webm/.mov - decoded natively in the browser, no ffmpeg), or a still image
  // (→ a 3D solid the viewer spins). Files arrive from the picker, a drag-drop, OR a pasted URL -
  // all three funnel through importFiles so every source gets the identical pipeline.
  async function importFiles(files: File[]): Promise<void> {
    if (!files.length) return;
    if (importing) {
      hud.textContent = importBusyText(files[0]!.name || "that file");
      return;
    }
    importing = true;
    importAbort = new AbortController();
    const signal = importAbort.signal;
    setImportBusy(true);
    viewer.pause(); // stop the render loop overwriting the status line
    flatFramesRgb = null; // a fresh import invalidates the prior flat import (re-set below on success)
    flatVolFrames = null;
    importedFrames = null; // …and the prior model import (re-set below when this one is a model)
    current3dMusic = []; // a fresh import drops any prior video's note-block music
    notePreview.setEvents([]);
    clipAudio.dispose(); // …and its original soundtrack (re-loaded below when the new file has one)
    viewer.setMusicArea([]);
    musicToggle.disabled = true;
    playBtn.textContent = "play";
    hud.textContent = `importing ${files.length > 1 ? `${files.length} files` : files[0]!.name}…`;
    try {
      // ONE pure classifier (import-files.ts, unit-tested) decides what each file is - the picker,
      // the canvas drag & drop, and the URL box all reach this dispatch, so every entry point
      // accepts exactly the same set.
      const objs = files.filter((f) => classifyImportFile(f) === "obj");
      const glb = files.find((f) => classifyImportFile(f) === "glb");
      const gltf = files.find((f) => classifyImportFile(f) === "gltf");
      const gif = files.find((f) => classifyImportFile(f) === "gif");
      const video = files.find((f) => classifyImportFile(f) === "video");
      const image = files.find((f) => classifyImportFile(f) === "image"); // any still image (gif handled above)
      if (glb) {
        showImported(glbToFrames(await glb.arrayBuffer(), { frames: 24, resolution: 40, mapColorId: grayId, matchColor: match3d }), `glb ${glb.name}`);
      } else if (gltf) {
        showImported(gltfToFrames(await gltf.text(), { frames: 24, resolution: 40, mapColorId: grayId, matchColor: match3d }), `glTF ${gltf.name}`);
      } else if (objs.length > 1) {
        const texts = await Promise.all(objs.sort((a, b) => a.name.localeCompare(b.name)).map((f) => f.text()));
        showImported(objSequenceToFrames(texts, { resolution: 40, mapColorId: grayId, matchColor: match3d }), `obj-seq ×${texts.length}`);
      } else if (objs.length === 1) {
        showImported([objToVolume(await objs[0]!.text(), { resolution: 40, mapColorId: grayId, solid: true, matchColor: match3d })], `model ${objs[0]!.name}`);
      } else if (gif) {
        // animated GIF → FLAT, faithful per-frame block animation. A 2D motion graphic has no "subject"
        // to lift off a "background"; the OLD dome-inflation path turned it into a boiling blob. Here the
        // front face of each thin slab IS the source frame, block-for-block - the frames ARE the motion,
        // played at the GIF's real per-frame timing. Transparent pixels (canvas alpha) map to air.
        const { canvases, durationsMs, capped } = await decodeGif(gif, { signal });
        // a 0-frame decode (ImageDecoder reports frameCount 0 for a truncated/corrupt GIF) would
        // dereference canvases[0] below - fail with a clean message instead of a TypeError.
        if (!canvases.length) throw new Error(`couldn't decode ${gif.name} (the GIF has no frames)`);
        const gw = flatGridWidth(canvases.length, (canvases[0]!.height || 3) / (canvases[0]!.width || 4));
        const decoded = canvases.map((c) => rgbAndAirFromCanvas(c, gw));
        const rgb = decoded.map((d) => d.rgb);
        const frames = rgbFramesToFlat3d(rgb, pal3d, {
          depth: 2,
          isAirForFrame: (f, x, y) => decoded[f]!.air[y * rgb[f]!.width + x] === 1,
        });
        // an over-budget GIF keeps its first N frames - the label says so (video path's pattern)
        showFrames(frames, `gif ${gif.name} · flat${gifCapNote(capped)}`, durationsMs, true);
        flatFramesRgb = rgb; // remember the imported frames so build-from-image / transforms follow them
        flatVolFrames = frames; // and the plain flat frames, so a block-motion effect can play over them
        flatDurationsMs = durationsMs; // and its real per-frame timing, for a faithful GIF export
        flatLabel = `gif ${gif.name}`;
      } else if (video) {
        // VIDEO → FLAT faithful per-frame block animation at the CHOSEN fps + resolution, decoded
        // natively in the browser and STREAMED: each decoded frame is quantized to its compact
        // one-byte-per-voxel wall slice immediately and its pixels dropped, so a whole multi-minute
        // clip at 30/60 fps (10k+ frames) fits in memory. Playback runs at the clip's real timing;
        // the datapack export samples down to Minecraft's 20 fps ceiling (1 frame per game tick).
        const fps = Number(fpsSel.value) || 20;
        const resChoice = resSel.value; // "auto" or an explicit wall width in blocks
        const decodeW = resChoice === "auto" ? 160 : Math.max(32, Number(resChoice) || 160);
        const volFrames: VoxelVolume[] = [];
        let rgbKeep: RgbImage[] | null = [];
        let gw = 96;
        let wallDepth = 2;
        let resNote = "";
        const { durationsMs } = await decodeVideo(video, {
          fps,
          maxFrames: Math.ceil(fps * 660), // 11-minute ceiling at ANY fps - the count scales with fps
          targetWidth: decodeW,
          signal, // the cancel button aborts between seeks - no state below is written
          onFrame: (c, i, total) => {
            if (i === 0) {
              const aspect = (c.height || 9) / (c.width || 16);
              gw =
                resChoice === "auto"
                  ? Math.max(Math.min(96, c.width || 96), flatGridWidth(total, aspect))
                  : Math.min(decodeW, c.width || decodeW);
              wallDepth = total > 1200 ? 1 : 2; // long clip: thin wall halves memory, reads the same head-on
              // memory guard: frames × w × h × depth bytes must stay browser-sane. Step the wall down
              // BEFORE allocating thousands of frames, and say so, instead of dying mid-decode.
              const gh = (w: number): number => Math.max(1, Math.round(w * aspect));
              while (gw > 64 && total * gw * gh(gw) * wallDepth > CLIP_VOXEL_BUDGET) {
                gw = gw > 160 ? 160 : gw > 128 ? 128 : gw > 96 ? 96 : 64;
                resNote = ` · resolution capped at ${gw} (memory)`;
              }
            }
            const { rgb, air } = rgbAndAirFromCanvas(c, gw);
            const q = quantizeFrame(rgb, pal3d, QUANT_FLAT);
            let hasAir = false;
            for (let k = 0; k < air.length; k++)
              if (air[k]) {
                hasAir = true;
                break;
              }
            volFrames.push(imageToFlat(q, { depth: wallDepth, isAir: hasAir ? (x, y) => air[y * rgb.width + x] === 1 : undefined }));
            // keep the raw RGB frames (for build-3D / re-quantizing) only while the clip is short
            // enough to afford them; long clips reconstruct RGB from the wall's palette on demand.
            if (rgbKeep) {
              if (total <= 1500) rgbKeep.push(rgb);
              else rgbKeep = null;
            }
            if (i % 25 === 0 || i + 1 === total) hud.textContent = `decoding ${video.name} @ ${fps} fps: frame ${i + 1}/${total}…`;
          },
        });
        if (!volFrames.length) throw new Error("no frames decoded from video");
        showFrames(volFrames, `video ${video.name} · flat · ${fps} fps${resNote}`, durationsMs, true);
        flatFramesRgb = rgbKeep; // may be null for very long clips (memory); synthesized on demand
        flatVolFrames = volFrames; // the plain flat frames, so effects/depth/3D rebuilds follow the clip
        flatDurationsMs = durationsMs; // and its real per-frame timing, for a faithful GIF export
        clipAudio.load(video, durationsMs); // ORIGINAL soundtrack, synced to the frame clock
        clipAudio.setMode(audioModeSel.value as ClipAudioMode);
        flatLabel = `video ${video.name}`;
        // If the clip carries audio, transcribe it to a note-block music timeline + a draggable music
        // area beside the build (kept on builder state for the toggle + datapack export). Audio never
        // blocks the visual import.
        try {
          current3dMusic = await analyzeFileAudio(video);
          notePreview.setEvents(current3dMusic);
          if (current3dMusic.length) {
            const v0 = volFrames[0];
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
          // the toggle stays disabled (nothing to toggle) - but the REASON must be visible:
          // "Note blocks" greyed forever beside an audio-mode select still offering silent
          // "note blocks" was a dead end. The visual import above already succeeded.
          hud.textContent = audioAnalysisFailedText(video.name, (err as Error).message);
        }
      } else if (image) {
        // still image → a single subject-isolated 3D solid the viewer spins live (its own animation).
        // Build it the SAME clean way as the flat-import build: NEAREST quant (QUANT3D_SOLID) so
        // detectBackgroundMask can flood a flat background away and isolate the subject - floyd-steinberg
        // dither scattered the flat field into a non-isolatable speckled slab (the old "looks bad") - at
        // STILL_SOLID_GRID (well above the old 40px) so the subject has real detail, not a blocky blob.
        const bmp = await createImageBitmap(image);
        const c = document.createElement("canvas");
        c.width = bmp.width;
        c.height = bmp.height;
        c.getContext("2d")!.drawImage(bmp, 0, 0);
        bmp.close();
        animSel.value = "spin"; // a fresh solid turntable-spins; keep the dropdown honest
        buildSolidFrom(rgbImageFromCanvas(c, STILL_SOLID_GRID), QUANT3D_SOLID);
        hud.textContent = `image ${image.name} · 3D solid · spin · drag to orbit`;
      } else {
        hud.textContent = "unsupported file · use .gltf/.glb, .obj (one or many), .gif, a video (.mp4/.webm/.mov), or an image";
      }
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        // user-driven cancel: the decode threw BEFORE any state write, so the section keeps
        // whatever it was showing - say so honestly instead of a scary "import failed"
        hud.textContent = IMPORT_CANCELLED_TEXT;
      } else {
        log.warn("3D import failed", err);
        hud.textContent = `import failed: ${(err as Error).message}`;
      }
    } finally {
      importing = false;
      importAbort = null;
      setImportBusy(false);
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
    const input = ev.target as HTMLInputElement;
    void importFiles(Array.from(input.files ?? []));
    input.value = ""; // allow re-selecting the SAME file (e.g. retry after a failed import) to re-fire "change"
  });

  // drag & drop any importable asset (model / GIF / video / image) onto the 3D canvas area - the
  // same affordance §02 trains, funneled through the SAME importFiles pipeline as the picker + URL.
  const v3Drop = $<HTMLDivElement>("v3-drop");
  for (const e of ["dragenter", "dragover"]) {
    v3Drop.addEventListener(e, (ev) => {
      ev.preventDefault();
      v3Drop.classList.add("drag");
    });
  }
  for (const e of ["dragleave", "drop"]) {
    v3Drop.addEventListener(e, () => v3Drop.classList.remove("drag"));
  }
  v3Drop.addEventListener("drop", (ev) => {
    ev.preventDefault();
    const files = Array.from((ev as DragEvent).dataTransfer?.files ?? []);
    if (files.length) void importFiles(files); // multiple files supported (an .obj-per-frame sequence)
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
      hud.textContent = `URL import failed: ${(err as Error).message} - the host may block cross-origin fetch (CORS)`;
    }
  }
  $<HTMLButtonElement>("v3-url-go").addEventListener("click", () => void importUrl());
  urlInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") void importUrl();
  });

  // fps/resolution are read once at import time - changing them mid-clip used to be a silent
  // no-op; the HUD now says when the new value takes effect.
  for (const sel of [fpsSel, resSel]) {
    sel.addEventListener("change", () => {
      const note = settingsChangeNote(!!flatVolFrames);
      if (note) hud.textContent = note;
    });
  }

  // ?src=<url> opens the page WITH an asset already playing (e.g. ?src=/test-assets/badapple.mp4)
  const autoSrc = new URLSearchParams(location.search).get("src");
  if (autoSrc) {
    urlInput.value = autoSrc;
    document.getElementById("v3-canvas")?.scrollIntoView({ block: "center" });
    void importUrl();
  }

  // The frames to EXPORT (datapack + pixel GIF). A multi-frame clip / block-motion sequence exports
  // as-is. A single solid showing the live turntable bakes spinSequence, so the export actually SPINS -
  // the live viewer spin is otherwise not in the frames (this is the "export our animations" fix). Any
  // other live transform (bob/rock/tumble/pulse/orbit) can't bake to discrete blocks, so it exports as
  // the single still. Returns the timing to replay at (null ⇒ uniform, for a baked spin / sequence).
  function exportFrames(): { frames: VoxelVolume[]; durationsMs: Array<number | undefined> | null } {
    if (current3d.length > 1) return { frames: current3d, durationsMs: current3dDurations };
    if (animSel.value === "spin") {
      // bake the turntable of the volume the user is actually looking at: an active import beats
      // the stale baseVolume (same source preference as anim-source.ts - after a model import,
      // baseVolume still points at the PREVIOUSLY built solid; spinning it exported stale content).
      const v = spinExportVolume({ flatVolFrames, importedFrames, baseVolume });
      if (v) return { frames: spinSequence(v, 24), durationsMs: null };
    }
    return { frames: current3d, durationsMs: current3dDurations };
  }

  // Download a vanilla datapack that builds the 3D animation (fill-batched). The export carries the
  // on-screen arrangement: the build spawns at its dragged origin, and - when the video had audio AND
  // the note-block toggle is on - the note-block music area + sequencer at ITS dragged origin.
  $<HTMLButtonElement>("v3-download").addEventListener("click", () => {
    const { frames: allFrames, durationsMs } = exportFrames();
    if (!allFrames.length) return;
    // HONEST in-game pacing: Minecraft plays one animation step per game tick - 20 fps is the
    // ceiling. A clip decoded above that is resampled EVENLY so the in-game duration matches the
    // source; at/below 20 fps every frame keeps its nearest whole-tick dwell. The plan input is
    // sanitized but NOT per-frame floored (tickPlanDurations): the viewer's MIN_FRAME_MS display
    // floor inflated every >100 fps source (120 fps 1 s → a 1.20 s pack; the CLI emits 1.00 s).
    const plan = planTickPlayback(allFrames.length, tickPlanDurations(durationsMs));
    const frames = plan.resampled ? plan.indices.map((i) => allFrames[i]!) : allFrames;
    // Export-budget guard: one .mcfunction per frame; warn (do not block) past the tested budget.
    // The warning + "packing…" go to the HUD BEFORE the synchronous generate+zip (which can take
    // seconds on a long clip), not only into the after-text of a freeze the user already sat through.
    const budget = planExportBudget(frames.length);
    if (budget.warn) console.warn(`blockdream export: ${budget.message}`);
    hud.textContent = packingHudText(budget, frames.length);
    setTimeout(() => {
      // (timeout lets the HUD paint before the synchronous per-frame generation)
      // the viewer centers the build + the note-block row on their group positions; pass each object's
      // half-extent so the export lands them centered where they sit on screen (not corner-offset).
      const v0 = frames[0];
      // center the dragged music row on the keyboard the pack will ACTUALLY place (distinct
      // (instrument, note) pairs after the loop trim), not a note-only Set-size guess.
      const placement = planDatapackPlacement(current3dMusic, arrange, { x: 0, y: 64, z: 0 }, {
        buildHalf: v0 ? { x: v0.sx / 2, z: v0.sz / 2 } : undefined,
        musicHalf: musicKeyboardHalf(current3dMusic, frames.length, plan.speedTicks),
      });
      const pack = generateVoxelDatapack(frames, resolveBlock, {
        namespace: "blockdream_3d",
        supportedFormats: JAVA_DATAPACK_SUPPORTED,
        optimize: (cells, r) => greedyBoxes(cells, r),
        origin: placement.origin,
        music: placement.music,
        musicOrigin: placement.musicOrigin,
        speedTicks: plan.speedTicks,
      });
      const cmds = pack.totalCommands ?? pack.totalSetblocks;
      const musicNote = placement.music ? ` · ${placement.music.length} note-block notes` : "";
      const paceNote = plan.resampled
        ? ` · in-game 20 fps (Minecraft's 1-frame-per-tick ceiling; ${allFrames.length} → ${frames.length} frames, same duration)`
        : ` · in-game ${plan.fps} fps`;
      const budgetNote = budget.warn ? ` · WARNING: ${budget.message}` : "";
      $<HTMLDivElement>("v3-export").textContent =
        `3D datapack: ${pack.totalSetblocks} blocks → ${cmds} cmds · ${pack.frameCount} frames${musicNote}${paceNote}${budgetNote} · /function blockdream_3d:setup`;
      hud.textContent = `datapack packed · ${pack.frameCount} frames`;
      downloadDatapack("blockdream-3d-datapack", pack.files, placement.origin);
    }, 30);
  });

  // Download the animation as an animated GIF in PIXEL/BLOCK format: each frame's front block face,
  // rendered crisp (integer-upscaled), at the source's real per-frame timing. A video / imported GIF
  // exports its frames; a single spun solid bakes the turntable so the GIF genuinely rotates.
  $<HTMLButtonElement>("v3-gif").addEventListener("click", () => {
    const { frames: allFrames, durationsMs } = exportFrames();
    if (!allFrames.length) return;
    // GIF pacing == pack pacing: emit the SAME frames the datapack plays (the tick plan's
    // list - resampled above Minecraft's 20 fps ceiling) with each frame held its uniform
    // tick dwell, so GIF and in-game animation run the same wall-clock timeline. The old
    // export kept the unresampled frames at per-frame source delays: [40,40,40] played
    // 120 ms as a GIF but 100 ms in game. Pack bytes are unchanged by this.
    const pacing = gifExportPacing(allFrames.length, durationsMs);
    const frames = pacing.indices.map((i) => allFrames[i]!);
    // Memory-budget guard BEFORE any per-frame raster is allocated: a long high-fps clip
    // (up to 13200 frames) padded + upscaled to RGBA is gigabytes - that synchronous path
    // froze or killed the tab with no warning. Hard cap with the honest math in the HUD.
    const plan = planGifExport(frames.map((f) => ({ sx: f.sx, sy: f.sy })));
    if (!plan.ok) {
      hud.textContent = plan.message;
      return;
    }
    hud.textContent =
      frames.length < 2
        ? // one still frame - a GIF would not animate; steer the user to PNG (and still emit a 1-frame GIF).
          "single still · exporting a 1-frame GIF (use Download PNG for a still image)"
        : plan.message; // "encoding N GIF frames at WxH…"
    setTimeout(() => {
      // (timeout lets the HUD paint before the synchronous rasterize + encode)
      const W = Math.max(...frames.map((f) => f.sx));
      const H = Math.max(...frames.map((f) => f.sy));
      const scale = fitScale(W, H, 384);
      // uniform delay = the pack's tick dwell (speedTicks × 50 ms) over the pack's frame list
      const gif: GifFrame[] = frames.map((f) => ({
        raster: upscaleNearest(padRaster(flatVolumeToRaster(f), W, H), scale),
        delayMs: pacing.delayMs,
      }));
      try {
        downloadGif("blockdream-animation.gif", gif);
        $<HTMLDivElement>("v3-export").textContent =
          `GIF: ${W * scale}×${H * scale} px · ${gif.length} frame${gif.length > 1 ? "s" : ""}`;
        hud.textContent = `GIF ready · ${gif.length} frame${gif.length > 1 ? "s" : ""}`;
      } catch (err) {
        log.warn("GIF export failed", err);
        $<HTMLDivElement>("v3-export").textContent = `GIF export failed: ${(err as Error).message}`;
        hud.textContent = `GIF export failed: ${(err as Error).message}`;
      }
    }, 30);
  });

  // Download the currently-shown frame as a crisp PNG (the block/pixel image).
  $<HTMLButtonElement>("v3-png").addEventListener("click", () => {
    const frames = current3d.length ? current3d : baseVolume ? [baseVolume] : [];
    if (!frames.length) return;
    const i = Math.min(frames.length - 1, Math.max(0, Math.round(Number(scrub.value)) || 0));
    const f = frames[i]!;
    // honest status: report success only after the encode resolves, failure into the same line
    void reportPngDownload(
      downloadPng("blockdream-frame.png", upscaleNearest(flatVolumeToRaster(f), fitScale(f.sx, f.sy, 512))),
      $<HTMLDivElement>("v3-export"),
      `PNG: frame ${i + 1}/${frames.length}`,
    );
  });

  playBtn.addEventListener("click", () => {
    if (viewer.isPlaying) {
      viewer.pause();
      clipAudio.pause(); // no onFrame fires while paused - stop the soundtrack explicitly
      playBtn.textContent = "play";
    } else {
      viewer.play();
      playBtn.textContent = "pause";
    }
  });
  scrub.addEventListener("input", () => {
    viewer.pause();
    clipAudio.pause();
    playBtn.textContent = "play";
    viewer.setFrame(Number(scrub.value));
  });
}
setup3dViewer().catch((err: unknown) => {
  // WebGL unavailable (Viewer3D's WebGLRenderer throws) used to leave section 03 at
  // "building…" forever with every control silently dead - say so and disable them all.
  $<HTMLDivElement>("v3-hud").textContent = viewer3dUnavailableText((err as Error).message ?? String(err));
  for (const id of SECTION3_CONTROL_IDS) {
    const el = document.getElementById(id) as HTMLButtonElement | null;
    if (el) el.disabled = true;
  }
});

// Scroll-reveal: sections fade + rise a little as they enter view (tha.jp - restrained motion
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
