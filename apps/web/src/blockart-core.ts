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
import { getSolidBlockMapPalette } from "@blockdream/palette/solid";
import { blockForBase, swatchDataUrl, localTextureUrl, hasLocalTextures, loadTextureManifest } from "./blocks";
import { decodeGif, isGif } from "./gif";
import { buildSchedule, frameAtElapsed, type FrameSchedule } from "./anim";
import { classifyImportFile } from "./import-files";

/** Count distinct byte values. Equivalent to `new Set(bytes).size` but a flat O(n) pass over a
 *  256-flag table - this runs per animated-GIF frame for the stats line, and Set construction
 *  over a whole frame's map-color bytes was the hot part. */
export function distinctByteCount(bytes: Uint8Array): number {
  const seen = new Uint8Array(256);
  let n = 0;
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]!;
    if (!seen[b]) {
      seen[b] = 1;
      n++;
    }
  }
  return n;
}

/** §02 drop-zone routing: null means "load it as block-art"; a string is the message to show
 *  instead of silently ignoring the drop. Classification is extension-first (classifyImportFile),
 *  so an OS drag whose File carries an empty MIME type still routes by its name. */
export function blockArtDropMessage(f: { name?: string; type?: string }): string | null {
  const kind = classifyImportFile(f);
  if (kind === "image" || kind === "gif") return null;
  const name = f.name || "that file";
  if (kind === "video") return `${name} is a video · the 3D voxel builder (section 03) plays videos as block animations`;
  if (kind === "glb" || kind === "gltf" || kind === "obj") return `${name} is a 3D model · import it in the 3D voxel builder (section 03)`;
  return `couldn't import ${name} · drop an image (.png/.jpg/.webp/.gif)`;
}

/** Shared drag & drop wiring for a block-art zone: highlight while a drag is over it, then route
 *  the dropped file extension-first (blockArtDropMessage) - images/GIFs load, everything else gets
 *  a helpful message instead of the browser navigating away to the raw file. ONE helper wires both
 *  the index §02 zone (showcase.ts) and the standalone tester (main.ts), byte-same behavior. */
export function wireBlockArtDrop(
  zone: HTMLElement,
  stats: { textContent: string | null },
  loadFile: (f: File) => Promise<void>,
): void {
  for (const e of ["dragenter", "dragover"]) {
    zone.addEventListener(e, (ev) => {
      ev.preventDefault();
      zone.classList.add("drag");
    });
  }
  for (const e of ["dragleave", "drop"]) {
    zone.addEventListener(e, () => zone.classList.remove("drag"));
  }
  zone.addEventListener("drop", (ev) => {
    ev.preventDefault();
    const f = (ev as DragEvent).dataTransfer?.files?.[0];
    if (!f) return;
    // extension-first routing (classifyImportFile): an OS drag with an empty MIME type still
    // loads by its name, and a non-image gets a helpful message instead of a silent no-op.
    const msg = blockArtDropMessage(f);
    if (msg) stats.textContent = msg;
    else void loadFile(f); // GIF → animated, else static
  });
}

/** Palette choices the block-art preview can quantize against: the 244-colour MAP palette
 *  (what a map item / the default preview shows) or the placeable SOLID-block gamut (every
 *  entry resolves to a real block - the palette the CLI's solid builds use). Prepared once
 *  per choice, module-memoized (preparePalette builds OKLab tables - not per-render work). */
export type BlockArtPaletteChoice = "map" | "block";
const PREPARED_PALETTES = new Map<BlockArtPaletteChoice, PreparedPalette>();
export function paletteForChoice(choice: BlockArtPaletteChoice): PreparedPalette {
  let pal = PREPARED_PALETTES.get(choice);
  if (!pal) {
    pal =
      choice === "block"
        ? preparePalette(getSolidBlockMapPalette().palette)
        : preparePalette(javaMapPalette as unknown as MapPalette);
    PREPARED_PALETTES.set(choice, pal);
  }
  return pal;
}

/** Incremental bill-of-materials renderer. The markup per row is byte-identical to a full
 *  rebuild (li > img.ic + div.nm + div.ct, same classes, same innerHTML), but across frames of
 *  an animated GIF the keyed <li> nodes are kept: count text updates only when it changes, rows
 *  are re-appended only when the sort order changes, and a full rebuild happens only when the
 *  block SET (or the texture mode) changes - so per-frame BOM work stops being DOM churn. */
export function createBomRenderer(bomEl: HTMLElement): (counts: Map<number, number>, total: number) => void {
  interface RowNode {
    li: HTMLLIElement;
    ct: HTMLDivElement;
    ctHtml: string;
  }
  const nodes = new Map<number, RowNode>();
  let lastUseTex: boolean | null = null;
  return (counts, total) => {
    const rows = [...counts.entries()]
      .map(([baseId, n]) => ({ info: blockForBase(baseId), n }))
      .filter((r): r is { info: NonNullable<ReturnType<typeof blockForBase>>; n: number } => !!r.info)
      .sort((a, b) => b.n - a.n);
    const useTex = hasLocalTextures(); // always use real block textures when present (no toggle)
    const sameSet =
      useTex === lastUseTex && nodes.size === rows.length && rows.every((r) => nodes.has(r.info.baseId));
    if (!sameSet) {
      nodes.clear();
      bomEl.innerHTML = "";
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
        const ctHtml = `${n}<small>${((100 * n) / total).toFixed(1)}%</small>`;
        ct.innerHTML = ctHtml;
        li.append(ic, nm, ct);
        bomEl.appendChild(li);
        nodes.set(info.baseId, { li, ct, ctHtml });
      }
      lastUseTex = useTex;
      return;
    }
    // same block set: re-append the kept nodes only if the count-sorted order actually changed
    let orderChanged = false;
    for (let i = 0; i < rows.length; i++) {
      if (bomEl.children[i] !== nodes.get(rows[i]!.info.baseId)!.li) {
        orderChanged = true;
        break;
      }
    }
    if (orderChanged) for (const r of rows) bomEl.appendChild(nodes.get(r.info.baseId)!.li);
    for (const { info, n } of rows) {
      const rec = nodes.get(info.baseId)!;
      const ctHtml = `${n}<small>${((100 * n) / total).toFixed(1)}%</small>`;
      if (ctHtml !== rec.ctHtml) {
        rec.ct.innerHTML = ctHtml;
        rec.ctHtml = ctHtml;
      }
    }
  };
}

/** Flat, cache-friendly view of a prepared palette for the per-pixel paint loop: separate
 *  r/g/b bytes + baseId per entry, built ONCE per palette (WeakMap-memoized by identity).
 *  The paint loop runs per animated-GIF frame on the rAF thread (65k px × up to 50 fps); the
 *  old loop's per-pixel `pal.entries[idx]!.color` two-level deref + counts-Map get/set per
 *  pixel was the hot part. */
interface FlatPalette {
  r: Uint8Array;
  g: Uint8Array;
  b: Uint8Array;
  baseId: Int32Array;
  maxBase: number;
}
const FLAT_PALETTES = new WeakMap<PreparedPalette, FlatPalette>();
function flatPalette(pal: PreparedPalette): FlatPalette {
  let fp = FLAT_PALETTES.get(pal);
  if (!fp) {
    const n = pal.entries.length;
    fp = { r: new Uint8Array(n), g: new Uint8Array(n), b: new Uint8Array(n), baseId: new Int32Array(n), maxBase: 0 };
    for (let i = 0; i < n; i++) {
      const c = pal.entries[i]!.color;
      fp.r[i] = c.r;
      fp.g[i] = c.g;
      fp.b[i] = c.b;
      fp.baseId[i] = c.baseId;
      if (c.baseId > fp.maxBase) fp.maxBase = c.baseId;
    }
    FLAT_PALETTES.set(pal, fp);
  }
  return fp;
}

/** Paint a quantized frame into an RGBA buffer and tally per-base block counts. Byte-identical
 *  to the naive per-pixel `pal.entries[...]` loop: same RGBA bytes, and the counts Map is
 *  materialized AFTER the loop in the SAME first-seen insertion order (createBomRenderer's
 *  stable count sort keeps tied rows in insertion order, so BOM markup stays byte-identical;
 *  the stats line only reads counts.size). The loop itself reads flat typed arrays and tallies
 *  into an Int32Array + a first-seen order list - no Map ops per pixel. */
export function paintQuantized(q: QuantizedFrame, pal: PreparedPalette, out: Uint8ClampedArray): Map<number, number> {
  const fp = flatPalette(pal);
  const { r, g, b, baseId } = fp;
  const idx = q.paletteIndex;
  const n = q.width * q.height;
  const tally = new Int32Array(fp.maxBase + 1);
  const order: number[] = [];
  for (let p = 0, o = 0; p < n; p++, o += 4) {
    const i = idx[p]!;
    out[o] = r[i]!;
    out[o + 1] = g[i]!;
    out[o + 2] = b[i]!;
    out[o + 3] = 255;
    const base = baseId[i]!;
    if (tally[base]!++ === 0) order.push(base);
  }
  const counts = new Map<number, number>();
  for (const base of order) counts.set(base, tally[base]!);
  return counts;
}

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
  /** Optional palette select ("map" | "block") - re-quantizes on change (standalone tester). */
  palette?: HTMLSelectElement;
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
  /** Frames in the loaded clip: 0 = nothing loaded, 1 = still image, >1 = animated GIF. */
  getFrameCount: () => number;
  /** Current SOURCE image as RGB at ≤maxW - lets the 3D builder re-quantize the original
   *  colors in its own palette instead of inheriting this path's dithered map-palette ids. */
  getSourceRgb: (maxW: number) => RgbImage | null;
} {
  const paletteChoice = (): BlockArtPaletteChoice => (els.palette?.value === "block" ? "block" : "map");
  let pal: PreparedPalette = paletteForChoice(paletteChoice());
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

  // keyed incremental BOM (markup byte-identical to a full rebuild; see createBomRenderer)
  const renderBom = createBomRenderer(els.bom);

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
    // flat-typed-array paint + post-loop counts materialization (byte-identical to the old
    // per-pixel entries[]/Map loop - locked in blockart-render-perf.test.ts)
    const counts = paintQuantized(q, pal, imgData.data);
    ctx.putImageData(imgData, 0, 0);
    els.out.style.width = `${Math.min(512, q.width * 4)}px`;

    const distinct = distinctByteCount(q.mapColorId);
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
    const url = URL.createObjectURL(file);
    img.onload = () => {
      loadImage(img);
      URL.revokeObjectURL(url);
    };
    img.onerror = () => {
      // a corrupt/undecodable file used to be a TOTAL silent no-op (stale image + stats kept,
      // object URL leaked) - say what happened and free the URL so a retry starts clean.
      URL.revokeObjectURL(url);
      els.stats.textContent = `couldn't decode ${file.name} · is it a valid image?`;
    };
    img.src = url;
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
  // palette select (standalone tester): switch the quantization palette and re-render. The
  // hover tooltip + BOM read the live `pal`, so they track the switch automatically.
  els.palette?.addEventListener("change", () => {
    pal = paletteForChoice(paletteChoice());
    render();
  });
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
    img.onerror = () => {
      // 404 / undecodable sample: message instead of a silently empty section
      els.stats.textContent = `couldn't load ${url}`;
    };
    img.src = url;
  }
  return {
    loadUrl,
    loadFile,
    getFrame: () => lastQ,
    getFrameCount: () => (frames.length ? frames.length : lastImage ? 1 : 0),
    getSourceRgb: (maxW: number) => {
      const src = currentSource();
      return src ? toRgbImage(src, Math.min(maxW, Number(els.grid.value) || maxW)) : null;
    },
  };
}
