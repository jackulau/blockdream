/** Tightly-packed 8-bit RGB image (no alpha, row-major). */
export interface RgbImage {
  width: number;
  height: number;
  /** length = width * height * 3 */
  data: Uint8Array;
}

/** A frame after quantization to a Minecraft map palette. */
export interface QuantizedFrame {
  width: number;
  height: number;
  /** Per-pixel index into the PreparedPalette.entries array. */
  paletteIndex: Int32Array;
  /** Per-pixel map color id to write into a map's `colors` byte array. */
  mapColorId: Uint8Array;
}

export function createRgbImage(width: number, height: number): RgbImage {
  return { width, height, data: new Uint8Array(width * height * 3) };
}

export function setPixel(img: RgbImage, x: number, y: number, r: number, g: number, b: number): void {
  const i = (y * img.width + x) * 3;
  img.data[i] = r;
  img.data[i + 1] = g;
  img.data[i + 2] = b;
}
