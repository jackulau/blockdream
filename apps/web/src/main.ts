// Standalone block-art tester - thin wrapper over the shared block-art core.
import { createBlockArt } from "./blockart-core";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

createBlockArt({
  file: $<HTMLInputElement>("file"),
  grid: $<HTMLInputElement>("grid"),
  gridVal: $<HTMLSpanElement>("gridVal"),
  dither: $<HTMLSelectElement>("dither"),
  stats: $<HTMLDivElement>("stats"),
  src: $<HTMLCanvasElement>("src"),
  out: $<HTMLCanvasElement>("out"),
  bom: $<HTMLUListElement>("bom"),
  tooltip: $<HTMLDivElement>("tooltip"),
});
