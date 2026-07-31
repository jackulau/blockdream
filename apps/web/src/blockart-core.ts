// Reusable block-art preview: drop an image → quantize to the Minecraft map palette,
// hover any cell to identify its block, and show a materials bill-of-materials with
// icons + counts. Shared by the standalone tester (main.ts) and the unified showcase.

import {
  preparePalette,
  quantizeFrame,
  type RgbImage,
  type DitherMethod,
  type PreparedPalette,
  type QuantizedFrame,
} from "@blockdream/color-core";
import javaMapPalette from "@blockdream/palette/data/java-map-colors-1.21.9.json";
import type { MapPalette } from "@blockdream/palette";
import { blockForBase, swatchDataUrl, localTextureUrl, hasLocalTextures, loadTextureManifest } from "./blocks";
import { decodeGif, isGif } from "./gif";
import { buildSchedule, frameAtElapsed, type FrameSchedule } from "./anim";

type Source = HTMLImageElement | HTMLCanvasElement;
const srcW = (s: Source) => (s instanceof HTMLImageElement ? s.naturalWidth : s.width);
const srcH = (s: Source) => (s instanceof HTMLImageElement ? s.naturalHeight : s.height);

export interface BlockArtEls {
  file: HTMLInputElement;
  grid: HTMLInputElement;
  gridVal: HTMLElement;
  dither: HTMLSelectElement;
  stats: HTMLElement;
  src: HTMLCanvasElement;
  out: HTMLCanvasElement;
  bom: HTMLElement;
  tooltip: HTMLElement;
}

export interface BlockArtOpts {
  onRender?: (q: QuantizedFrame) => void; // fired after each (re)quantize - e.g. enable export / rebuild 3D
}

export function createBlockArt(
  els: BlockArtEls,
  opts: BlockArtOpts = {},
): {
  loadUrl: (url: string) => void;
  loadFile: (file: File) => Promise<void>;
  getFrame: () => QuantizedFrame | null;
  /** Current SOURCE image as RGB at ≤maxW - lets the 3D builder re-quantize the original
   *  colors in its own palette instead of inheriting this path's dithered map-palette ids. */
  getSourceRgb: (maxW: number) => RgbImage | null;
} {
  const pal: PreparedPalette = preparePalette(javaMapPalette as unknown as MapPalette);
  let lastImage: Source | null = null;
  let lastQ: QuantizedFrame | null = null;
  // animated-GIF playback (single-image path is unchanged when frames is empty)
  let frames: HTMLCanvasElement[] = [];
  let schedule: FrameSchedule | null = null;
  let curFrame = 0;
  let animStart = 0;
  let animRaf = 0;
  const currentSource = (): Source | null => (frames.length ? frames[curFrame]! : lastImage);

  function toRgbImage(img: Source, gridW: number): RgbImage {
    const aspect = srcH(img) / srcW(img) || 1;
    const w = gridW;
    const h = Math.max(1, Math.round(gridW * aspect));
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const ctx = c.getContext("2d", { willReadFrequently: true })!;
    ctx.imageSmoothingEnabled = true;
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

  function drawSource(img: Source): void {
    const ctx = els.src.getContext("2d")!;
    const scale = Math.min(256 / srcW(img), 256 / srcH(img), 1);
    els.src.width = Math.round(srcW(img) * scale);
    els.src.height = Math.round(srcH(img) * scale);
    ctx.drawImage(img, 0, 0, els.src.width, els.src.height);
  }

  function renderBom(counts: Map<number, number>, total: number): void {
    const rows = [...counts.entries()]
      .map(([baseId, n]) => ({ info: blockForBase(baseId), n }))
      .filter((r): r is { info: NonNullable<ReturnType<typeof blockForBase>>; n: number } => !!r.info)
      .sort((a, b) => b.n - a.n);
    const useTex = hasLocalTextures(); // always use real block textures when present (no toggle)
    els.bom.innerHTML = "";
    for (const { info, n } of rows) {
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
          ic.src = swatch; // graceful fallback if a texture file is missing
        };
      } else {
        ic.src = swatch; // no local texture (or toggle off) → generated swatch
      }
      const nm = document.createElement("div");
      nm.className = "nm";
      nm.innerHTML = `${info.name}<br><small>${info.id}</small>`;
      const ct = document.createElement("div");
      ct.className = "ct";
      ct.innerHTML = `${n}<small>${((100 * n) / total).toFixed(1)}%</small>`;
      li.append(ic, nm, ct);
      els.bom.appendChild(li);
    }
  }

  function render(): void {
    const src = currentSource();
    if (!src) return;
    drawSource(src); // keep the source preview in sync (also shows the animated frame)
    const gridW = Number(els.grid.value);
    const method = els.dither.value as DitherMethod;
    const t0 = performance.now();
    const rgb = toRgbImage(src, gridW);
    const q = quantizeFrame(rgb, pal, { method });
    lastQ = q;
    const dt = performance.now() - t0;

    els.out.width = q.width;
    els.out.height = q.height;
    const ctx = els.out.getContext("2d")!;
    const imgData = ctx.createImageData(q.width, q.height);
    const counts = new Map<number, number>();
    for (let p = 0; p < q.width * q.height; p++) {
      const c = pal.entries[q.paletteIndex[p]!]!.color;
      const o = p * 4;
      imgData.data[o] = c.r;
      imgData.data[o + 1] = c.g;
      imgData.data[o + 2] = c.b;
      imgData.data[o + 3] = 255;
      counts.set(c.baseId, (counts.get(c.baseId) ?? 0) + 1);
    }
    ctx.putImageData(imgData, 0, 0);
    els.out.style.width = `${Math.min(512, q.width * 4)}px`;

    const distinct = new Set(q.mapColorId).size;
    const anim = frames.length > 1 ? ` · frame ${curFrame + 1}/${frames.length}` : "";
    els.stats.textContent = `${q.width}×${q.height} · ${counts.size} blocks · ${distinct} colors · ${dt.toFixed(1)} ms${anim}`;
    renderBom(counts, q.width * q.height);
    opts.onRender?.(q);
  }

  function stopAnim(): void {
    if (animRaf) cancelAnimationFrame(animRaf);
    animRaf = 0;
  }

  function loadImage(img: Source): void {
    stopAnim();
    frames = [];
    schedule = null;
    curFrame = 0;
    lastImage = img;
    render();
  }

  // Animated block-art: quantize each GIF frame and play them back on the same canvas at
  // the GIF's REAL cadence (per-frame durations), looping. Hover + BOM track the live frame.
  function loadFrames(canvases: HTMLCanvasElement[], durationsMs: Array<number | undefined>): void {
    stopAnim();
    lastImage = null;
    frames = canvases;
    schedule = buildSchedule(durationsMs);
    curFrame = 0;
    render();
    if (frames.length > 1) {
      animStart = performance.now();
      const tick = (): void => {
        const idx = frameAtElapsed(schedule!, performance.now() - animStart, true);
        if (idx !== curFrame) {
          curFrame = idx;
          render();
        }
        animRaf = requestAnimationFrame(tick);
      };
      animRaf = requestAnimationFrame(tick);
    }
  }

  // Route a dropped/selected file: animated GIF → frame-by-frame; otherwise a still image.
  async function loadFile(file: File): Promise<void> {
    if (isGif(file)) {
      try {
        const { canvases, durationsMs } = await decodeGif(file);
        if (canvases.length > 1) {
          loadFrames(canvases, durationsMs);
          return;
        }
      } catch {
        // ImageDecoder unsupported or decode failed → fall back to the static path below
      }
    }
    const img = new Image();
    img.onload = () => {
      loadImage(img);
      URL.revokeObjectURL(img.src);
    };
    img.src = URL.createObjectURL(file);
  }

  els.out.addEventListener("mousemove", (e) => {
    if (!lastQ) return;
    const rect = els.out.getBoundingClientRect();
    const x = Math.floor(((e.clientX - rect.left) / rect.width) * lastQ.width);
    const y = Math.floor(((e.clientY - rect.top) / rect.height) * lastQ.height);
    if (x < 0 || y < 0 || x >= lastQ.width || y >= lastQ.height) {
      els.tooltip.style.display = "none";
      return;
    }
    const color = pal.entries[lastQ.paletteIndex[y * lastQ.width + x]!]!.color;
    const info = blockForBase(color.baseId);
    if (!info) {
      els.tooltip.style.display = "none";
      return;
    }
    els.tooltip.innerHTML =
      `<span class="sw" style="background:rgb(${color.r},${color.g},${color.b})"></span>` +
      `${info.name} <span class="id">${info.id}</span><br>` +
      `shade ${color.shadeIndex} · rgb(${color.r}, ${color.g}, ${color.b})`;
    els.tooltip.style.display = "block";
    els.tooltip.style.left = `${e.clientX + 14}px`;
    els.tooltip.style.top = `${e.clientY + 14}px`;
  });
  els.out.addEventListener("mouseleave", () => {
    els.tooltip.style.display = "none";
  });

  els.file.addEventListener("change", () => {
    const file = els.file.files?.[0];
    if (file) void loadFile(file);
    els.file.value = ""; // allow re-selecting the SAME file (e.g. retry after a failed import) to re-fire "change"
  });
  els.grid.addEventListener("input", () => {
    els.gridVal.textContent = `${els.grid.value} px`;
    render();
  });
  els.dither.addEventListener("change", render);
  els.gridVal.textContent = `${els.grid.value} px`;

  // always use real block textures when present (auto-falls back to generated swatches only if the
  // local texture manifest hasn't been fetched). Re-render once the manifest loads.
  loadTextureManifest().then(() => {
    if (currentSource()) render();
  });

  // let callers seed an image (e.g. the showcase preloads sample pixel art)
  function loadUrl(url: string): void {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => loadImage(img);
    img.src = url;
  }
  return {
    loadUrl,
    loadFile,
    getFrame: () => lastQ,
    getSourceRgb: (maxW: number) => {
      const src = currentSource();
      return src ? toRgbImage(src, Math.min(maxW, Number(els.grid.value) || maxW)) : null;
    },
  };
}
