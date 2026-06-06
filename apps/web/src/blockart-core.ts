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
} from "@mineworld/color-core";
import javaMapPalette from "@mineworld/palette/data/java-map-colors-1.21.9.json";
import type { MapPalette } from "@mineworld/palette";
import { blockForBase, swatchDataUrl, localTextureUrl, loadTextureManifest } from "./blocks";

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
  useTextures: HTMLInputElement;
}

export function createBlockArt(els: BlockArtEls): { loadUrl: (url: string) => void } {
  const pal: PreparedPalette = preparePalette(javaMapPalette as unknown as MapPalette);
  let lastImage: HTMLImageElement | null = null;
  let lastQ: QuantizedFrame | null = null;

  function toRgbImage(img: HTMLImageElement, gridW: number): RgbImage {
    const aspect = img.naturalHeight / img.naturalWidth || 1;
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

  function drawSource(img: HTMLImageElement): void {
    const ctx = els.src.getContext("2d")!;
    const scale = Math.min(256 / img.naturalWidth, 256 / img.naturalHeight, 1);
    els.src.width = Math.round(img.naturalWidth * scale);
    els.src.height = Math.round(img.naturalHeight * scale);
    ctx.drawImage(img, 0, 0, els.src.width, els.src.height);
  }

  function renderBom(counts: Map<number, number>, total: number): void {
    const rows = [...counts.entries()]
      .map(([baseId, n]) => ({ info: blockForBase(baseId), n }))
      .filter((r): r is { info: NonNullable<ReturnType<typeof blockForBase>>; n: number } => !!r.info)
      .sort((a, b) => b.n - a.n);
    const useTex = els.useTextures.checked;
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
    if (!lastImage) return;
    const gridW = Number(els.grid.value);
    const method = els.dither.value as DitherMethod;
    const t0 = performance.now();
    const rgb = toRgbImage(lastImage, gridW);
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
    els.stats.textContent = `${q.width}×${q.height} · ${counts.size} blocks · ${distinct} colors · ${dt.toFixed(1)} ms`;
    renderBom(counts, q.width * q.height);
  }

  function loadImage(img: HTMLImageElement): void {
    lastImage = img;
    drawSource(img);
    render();
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
    if (!file) return;
    const img = new Image();
    img.onload = () => {
      loadImage(img);
      URL.revokeObjectURL(img.src);
    };
    img.src = URL.createObjectURL(file);
  });
  els.grid.addEventListener("input", () => {
    els.gridVal.textContent = `${els.grid.value} px`;
    render();
  });
  els.dither.addEventListener("change", render);
  els.useTextures.addEventListener("change", render);
  els.gridVal.textContent = `${els.grid.value} px`;

  // load the local real-texture manifest; default the toggle ON when textures are present,
  // and re-render so the BOM swaps swatches for real block textures.
  els.useTextures.checked = true;
  loadTextureManifest().then((ok) => {
    if (!ok) els.useTextures.checked = false; // no textures fetched yet → swatches
    if (lastImage) render();
  });

  // let callers seed an image (e.g. the showcase preloads sample pixel art)
  function loadUrl(url: string): void {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => loadImage(img);
    img.src = url;
  }
  return { loadUrl };
}
