// Standalone block-art tester - thin wrapper over the shared block-art core.
import { createBlockArt, wireBlockArtDrop } from "./blockart-core";

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
});
ba.loadUrl("/test-assets/pixelart.png"); // preload sample so the page is alive on load (like §02)

// drag & drop an image onto the canvases - the SAME shared wiring as the index §02 zone
// (without it the browser navigates away to the raw dropped file).
wireBlockArtDrop($<HTMLDivElement>("drop"), $<HTMLDivElement>("stats"), (f) => ba.loadFile(f));
