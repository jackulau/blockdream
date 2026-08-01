// Standalone block-art tester - thin wrapper over the shared block-art core, plus the SAME
// export pair the index §02 has (datapack .zip + crisp PNG), wired through the shared
// helpers: quantizeForDatapack (solid-palette re-quantize - the §02 air-hole fix),
// downloadDatapack, pixel-export's raster pipeline, and reportPngDownload's honest status.
import { createBlockArt, wireBlockArtDrop } from "./blockart-core";
import { quantizeForDatapack } from "./blockart-export";
import { generateJavaDatapack } from "@blockdream/emit-commands";
import { resolveBlock } from "./resolve-block";
import { JAVA_DATAPACK_SUPPORTED } from "@blockdream/palette/versions";
import { downloadDatapack } from "./datapack-export";
import { quantizedToRaster, upscaleNearest, fitScale, downloadPng } from "./pixel-export";
import { reportPngDownload } from "./export-plan";
import { blockArtExportText, DATAPACK_PALETTE_NOTE } from "./ui-feedback";
import type { DitherMethod } from "@blockdream/color-core";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const ba = createBlockArt({
  file: $<HTMLInputElement>("file"),
  grid: $<HTMLInputElement>("grid"),
  gridVal: $<HTMLSpanElement>("gridVal"),
  dither: $<HTMLSelectElement>("dither"),
  stats: $<HTMLDivElement>("stats"),
  src: $<HTMLCanvasElement>("src"),
  out: $<HTMLCanvasElement>("out"),
  bom: $<HTMLUListElement>("bom"),
  tooltip: $<HTMLDivElement>("tooltip"),
  palette: $<HTMLSelectElement>("palette"),
}, {
  onRender: (q) => {
    // both exports need a rendered frame - enable them together (the §02 pattern: PNG must
    // never ship enabled and silently no-op before the first render)
    $<HTMLButtonElement>("download").disabled = false;
    $<HTMLButtonElement>("png").disabled = false;
    $<HTMLDivElement>("export").textContent = blockArtExportText(q.width, q.height, ba.getFrameCount());
  },
});
ba.loadUrl("/test-assets/pixelart.png"); // preload sample so the page is alive on load (like §02)

// drag & drop an image onto the canvases - the SAME shared wiring as the index §02 zone
// (without it the browser navigates away to the raw dropped file).
wireBlockArtDrop($<HTMLDivElement>("drop"), $<HTMLDivElement>("stats"), (f) => ba.loadFile(f));

// Download a vanilla datapack that builds the current image as a block-wall. Export parity
// with §02: the pack RE-QUANTIZES the source against the placeable solid-block palette
// (whatever the preview palette shows) so every emitted cell places a real block - and the
// status line SAYS which palette the pack builds with.
$<HTMLButtonElement>("download").addEventListener("click", () => {
  const rgb = ba.getSourceRgb(Number($<HTMLInputElement>("grid").value) || 128);
  if (!rgb) return;
  const q = quantizeForDatapack(rgb, $<HTMLSelectElement>("dither").value as DitherMethod);
  const pack = generateJavaDatapack([q], resolveBlock, {
    namespace: "blockdream",
    supportedFormats: JAVA_DATAPACK_SUPPORTED,
  });
  const animatedNote =
    ba.getFrameCount() > 1 ? " · animated GIF: current frame only - the index page's section 03 plays the full animation" : "";
  $<HTMLDivElement>("export").textContent =
    `datapack: ${pack.totalSetblocks} setblocks · ${pack.frameCount} frame · ${DATAPACK_PALETTE_NOTE} · load /function blockdream:setup${animatedNote}`;
  downloadDatapack("blockdream-blockart-datapack", pack.files);
});

// Download the block-art as a crisp PNG (the preview frame in the SELECTED palette,
// integer-upscaled so it never blurs) - honest status only after the encode resolves.
$<HTMLButtonElement>("png").addEventListener("click", () => {
  const q = ba.getFrame();
  if (!q) return;
  const raster = upscaleNearest(quantizedToRaster(q), fitScale(q.width, q.height, 512));
  void reportPngDownload(
    downloadPng("blockdream-blockart.png", raster),
    $<HTMLDivElement>("export"),
    `PNG: ${raster.width}×${raster.height} px`,
  );
});
