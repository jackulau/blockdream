// §02 datapack-export parity (goal 088 D12). The on-screen block-art preview quantizes against
// the 244-colour MAP palette, but the datapack places blocks through the SOLID resolver
// (resolve-block folds any shade to its base and returns air for bases with no placeable
// block) - so exporting the preview frame directly punched air holes into the wall and
// collapsed distinct map colours onto the same block. The export therefore RE-QUANTIZES the
// source pixels against the placeable solid-block palette (the same palette the 3D path and
// the CLI's solid builds use), so every emitted cell resolves to a real block: zero air for
// full-gamut input, and the pack equals what a solid-palette preview would show.

import { quantizeFrame, type RgbImage, type DitherMethod, type QuantizedFrame } from "@blockdream/color-core";
import { paletteForChoice } from "./blockart-core";

/** Quantize a source frame for the §02 datapack export: solid-block palette end to end. */
export function quantizeForDatapack(rgb: RgbImage, method: DitherMethod): QuantizedFrame {
  return quantizeFrame(rgb, paletteForChoice("block"), { method });
}
