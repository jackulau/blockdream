import {
  preparePalette,
  quantizeFrame,
  type RgbImage,
  type DitherMethod,
  type PreparedPalette,
} from "@mineworld/color-core";
import javaMapPalette from "@mineworld/palette/data/java-map-colors-1.21.9.json";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const fileInput = $<HTMLInputElement>("file");
const gridInput = $<HTMLInputElement>("grid");
const gridVal = $<HTMLSpanElement>("gridVal");
const ditherSel = $<HTMLSelectElement>("dither");
const stats = $<HTMLDivElement>("stats");
const srcCanvas = $<HTMLCanvasElement>("src");
const outCanvas = $<HTMLCanvasElement>("out");

const pal: PreparedPalette = preparePalette(javaMapPalette);
let lastImage: HTMLImageElement | null = null;

/** Draw an image into an offscreen canvas at gridW×gridH and read RGB pixels. */
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
  const dt = performance.now() - t0;

  // render quantized result, scaled up with crisp pixels
  outCanvas.width = q.width;
  outCanvas.height = q.height;
  const ctx = outCanvas.getContext("2d")!;
  const imgData = ctx.createImageData(q.width, q.height);
  for (let p = 0; p < q.width * q.height; p++) {
    const c = pal.entries[q.paletteIndex[p]!]!.color;
    const o = p * 4;
    imgData.data[o] = c.r;
    imgData.data[o + 1] = c.g;
    imgData.data[o + 2] = c.b;
    imgData.data[o + 3] = 255;
  }
  ctx.putImageData(imgData, 0, 0);
  outCanvas.style.width = `${Math.min(512, q.width * 4)}px`;

  const distinct = new Set(q.mapColorId).size;
  stats.textContent = `${q.width}×${q.height} · ${distinct} colors used · ${dt.toFixed(1)} ms`;
}

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

gridVal.textContent = `${gridInput.value} px`;
