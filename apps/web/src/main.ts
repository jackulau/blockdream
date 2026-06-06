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
import { blockForBase, swatchDataUrl, textureUrl } from "./blocks";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const fileInput = $<HTMLInputElement>("file");
const gridInput = $<HTMLInputElement>("grid");
const gridVal = $<HTMLSpanElement>("gridVal");
const ditherSel = $<HTMLSelectElement>("dither");
const stats = $<HTMLDivElement>("stats");
const srcCanvas = $<HTMLCanvasElement>("src");
const outCanvas = $<HTMLCanvasElement>("out");
const bomList = $<HTMLUListElement>("bom");
const tooltip = $<HTMLDivElement>("tooltip");
const useTextures = $<HTMLInputElement>("useTextures");

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
  const ctx = srcCanvas.getContext("2d")!;
  const scale = Math.min(256 / img.naturalWidth, 256 / img.naturalHeight, 1);
  srcCanvas.width = Math.round(img.naturalWidth * scale);
  srcCanvas.height = Math.round(img.naturalHeight * scale);
  ctx.drawImage(img, 0, 0, srcCanvas.width, srcCanvas.height);
}

function render(): void {
  if (!lastImage) return;
  const gridW = Number(gridInput.value);
  const method = ditherSel.value as DitherMethod;
  const t0 = performance.now();
  const rgb = toRgbImage(lastImage, gridW);
  const q = quantizeFrame(rgb, pal, { method });
  lastQ = q;
  const dt = performance.now() - t0;

  outCanvas.width = q.width;
  outCanvas.height = q.height;
  const ctx = outCanvas.getContext("2d")!;
  const imgData = ctx.createImageData(q.width, q.height);
  const counts = new Map<number, number>(); // baseId -> cell count (the bill of materials)
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
  outCanvas.style.width = `${Math.min(512, q.width * 4)}px`;

  const distinct = new Set(q.mapColorId).size;
  stats.textContent = `${q.width}×${q.height} · ${counts.size} blocks · ${distinct} colors · ${dt.toFixed(1)} ms`;
  renderBom(counts, q.width * q.height);
}

function renderBom(counts: Map<number, number>, total: number): void {
  const rows = [...counts.entries()]
    .map(([baseId, n]) => ({ info: blockForBase(baseId), n }))
    .filter((r): r is { info: NonNullable<ReturnType<typeof blockForBase>>; n: number } => !!r.info)
    .sort((a, b) => b.n - a.n);
  const useTex = useTextures.checked;
  bomList.innerHTML = "";
  for (const { info, n } of rows) {
    const li = document.createElement("li");
    const ic = document.createElement("img");
    ic.className = "ic";
    ic.alt = info.name;
    const swatch = swatchDataUrl(info);
    if (useTex) {
      ic.src = textureUrl(info.id);
      ic.onerror = () => {
        ic.onerror = null;
        ic.src = swatch; // graceful offline / missing-texture fallback
      };
    } else {
      ic.src = swatch;
    }
    const nm = document.createElement("div");
    nm.className = "nm";
    nm.innerHTML = `${info.name}<br><small>${info.id}</small>`;
    const ct = document.createElement("div");
    ct.className = "ct";
    ct.innerHTML = `${n}<small>${((100 * n) / total).toFixed(1)}%</small>`;
    li.append(ic, nm, ct);
    bomList.appendChild(li);
  }
}

// hover any cell of the block-art → identify the exact Minecraft block
outCanvas.addEventListener("mousemove", (e) => {
  if (!lastQ) return;
  const rect = outCanvas.getBoundingClientRect();
  const x = Math.floor(((e.clientX - rect.left) / rect.width) * lastQ.width);
  const y = Math.floor(((e.clientY - rect.top) / rect.height) * lastQ.height);
  if (x < 0 || y < 0 || x >= lastQ.width || y >= lastQ.height) {
    tooltip.style.display = "none";
    return;
  }
  const color = pal.entries[lastQ.paletteIndex[y * lastQ.width + x]!]!.color;
  const info = blockForBase(color.baseId);
  if (!info) {
    tooltip.style.display = "none";
    return;
  }
  tooltip.innerHTML =
    `<span class="sw" style="background:rgb(${color.r},${color.g},${color.b})"></span>` +
    `${info.name} <span class="id">${info.id}</span><br>` +
    `shade ${color.shadeIndex} · rgb(${color.r}, ${color.g}, ${color.b})`;
  tooltip.style.display = "block";
  tooltip.style.left = `${e.clientX + 14}px`;
  tooltip.style.top = `${e.clientY + 14}px`;
});
outCanvas.addEventListener("mouseleave", () => {
  tooltip.style.display = "none";
});

fileInput.addEventListener("change", () => {
  const file = fileInput.files?.[0];
  if (!file) return;
  const img = new Image();
  img.onload = () => {
    lastImage = img;
    drawSource(img);
    render();
    URL.revokeObjectURL(img.src);
  };
  img.src = URL.createObjectURL(file);
});

gridInput.addEventListener("input", () => {
  gridVal.textContent = `${gridInput.value} px`;
  render();
});
ditherSel.addEventListener("change", render);
useTextures.addEventListener("change", render);

gridVal.textContent = `${gridInput.value} px`;
