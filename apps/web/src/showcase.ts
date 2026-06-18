// One-page showcase: both neural world models (auto-connecting, decoupled-smooth) and
// the block-art tester, on a single page. Each canvas captures keys only while focused
// so the two worlds don't fight over the keyboard.

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
import { rgbFramesToAnimated3d } from "./video3d";
import { isVideoFile, decodeVideo } from "./video";
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
  let baseVolume: VoxelVolume | null = null; // the single built solid (source for block-motion anims)
  let lastSource: ReturnType<typeof quantizeFrame> | null = null;
  let depthMap: Float32Array | null = null; // optional per-pixel depth for the current source
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
    const maxDepth = Math.max(4, Number(depth.value));
    const depthOf =
      depthMap && depthMap.length === q.width * q.height
        ? (x: number, y: number) => depthMap![y * q.width + x]!
        : undefined;
    const vol = log.time("imageToSolid", () => imageToSolid(q, { maxDepth, depthOf }));
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

  // initial source = the preloaded sample image (higher res than the old 28px for a sharper solid)
  const img = new Image();
  img.onload = () => setSource(quantizeFrame(rgbImageFromImg(img, 40), pal3d, QUANT3D_STILL));
  img.src = "/test-assets/pixelart.png";

  // "build 3D from image" re-quantizes the SOURCE colors in the 3D palette - not a nearest
  // subsample of the already-dithered 2D map-palette frame (which compounds two quantizers)
  $<HTMLButtonElement>("v3-rebuild").addEventListener("click", () => {
    const rgb = ba.getSourceRgb(40);
    setSource(rgb ? quantizeFrame(rgb, pal3d, QUANT3D_STILL) : lastSource ?? quantizeFrame(rgbImageFromImg(img, 40), pal3d, QUANT3D_STILL));
  });
  depth.addEventListener("input", () => rebuildVolume());

  // animation selector: live transform anims (spin/bob/rock/tumble/pulse/orbit/none) apply instantly;
  // block-motion anims (explode/wave/buildup) regenerate a frame sequence from the built solid.
  animSel.addEventListener("change", () => {
    const sel = animSel.value;
    if (isTransformAnim(sel)) {
      if (current3d.length > 1) rebuildVolume(); // back to a single solid from a sequence
      viewer.setAnim(sel);
      if (lastSource) hud.textContent = `${sel} · drag to orbit`;
    } else if (baseVolume) {
      const frames = generateSequence(sel as SequenceAnimName, baseVolume, 24);
      showFrames(frames, sel);
    }
  });

  function showFrames(frames: VoxelVolume[], label: string, durationsMs?: Array<number | undefined>): void {
    current3d = frames;
    if (frames[0]) renderBom3d(frames[0]);
    viewer.setFrames(frames, { durationsMs }); // multi-frame → live transform anim defaults off
    scrub.max = String(frames.length - 1);
    $<HTMLButtonElement>("v3-download").disabled = false;
    viewer.play();
    playBtn.textContent = "pause";
    hud.textContent = `${label} · ${frames.length} frame${frames.length > 1 ? "s" : ""} · drag to orbit`;
  }

  // import a real animation → block animation: a Blender glTF/.glb (node-TRS animation sampled to
  // frames), an .obj-per-frame sequence (select multiple), a single .obj model, an animated .gif,
  // or a VIDEO file (.mp4/.webm/.mov — decoded natively in the browser, no ffmpeg).
  $<HTMLInputElement>("v3-import").addEventListener("change", async (ev) => {
    const files = Array.from((ev.target as HTMLInputElement).files ?? []);
    if (!files.length) return;
    viewer.pause(); // stop the render loop overwriting the status line
    playBtn.textContent = "play";
    hud.textContent = `importing ${files.length > 1 ? `${files.length} files` : files[0]!.name}…`;
    try {
      const objs = files.filter((f) => /\.obj$/i.test(f.name));
      const glb = files.find((f) => /\.glb$/i.test(f.name));
      const gltf = files.find((f) => /\.gltf$/i.test(f.name));
      const gif = files.find((f) => /\.gif$/i.test(f.name) || f.type === "image/gif");
      const video = files.find((f) => isVideoFile(f));
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
        // animated GIF → temporally-stable 3D block animation (subject-isolated solids, not flat slabs)
        const { canvases, durationsMs } = await decodeGif(gif);
        const rgb = canvases.map((c) => rgbImageFromCanvas(c, 40));
        const frames = rgbFramesToAnimated3d(rgb, pal3d, { maxDepth: 10 });
        showFrames(frames, `gif ${gif.name} · 3D`, durationsMs);
      } else if (video) {
        // VIDEO → frames decoded natively in the browser → same temporally-stable 3D block animation
        const { canvases, durationsMs } = await decodeVideo(video, { fps: 12, maxFrames: 48 });
        if (!canvases.length) throw new Error("no frames decoded from video");
        const rgb = canvases.map((c) => rgbImageFromCanvas(c, 40));
        const frames = rgbFramesToAnimated3d(rgb, pal3d, { maxDepth: 10 });
        showFrames(frames, `video ${video.name} · 3D`, durationsMs);
      } else {
        hud.textContent = "unsupported file · use .gltf/.glb, .obj (one or many), .gif, or a video (.mp4/.webm/.mov)";
      }
    } catch (err) {
      log.warn("3D import failed", err);
      hud.textContent = `import failed: ${(err as Error).message}`;
    }
  });

  // Download a vanilla datapack that builds the 3D spin animation (fill-batched)
  $<HTMLButtonElement>("v3-download").addEventListener("click", () => {
    if (!current3d.length) return;
    const pack = generateVoxelDatapack(current3d, resolveBlock, {
      namespace: "blockdream_3d",
      supportedFormats: JAVA_DATAPACK_SUPPORTED,
      optimize: (cells, r) => greedyBoxes(cells, r),
    });
    const cmds = pack.totalCommands ?? pack.totalSetblocks;
    $<HTMLDivElement>("v3-export").textContent =
      `3D datapack: ${pack.totalSetblocks} blocks → ${cmds} cmds · ${pack.frameCount} frames · /function blockdream_3d:setup`;
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
