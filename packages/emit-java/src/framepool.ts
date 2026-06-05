import type { QuantizedFrame } from "@mineworld/color-core";
import { splitIntoMaps, MAP_AREA, MAP_DIM } from "./map";

/**
 * Binary frame pool consumed by the Fabric map-wall mod (`mods/java-fabric`).
 *
 * Big-endian layout:
 *   magic 'MWMW' | int version=1 | int cols | int rows | int frames | int speed
 *   then frames × cols·rows × 16384 bytes (per-tile map color arrays, tile order
 *   row-major, full keyframes so the mod can loop/seek in O(1)).
 */
export interface FramePoolResult {
  bin: Buffer;
  cols: number;
  rows: number;
  frameCount: number;
  /** placeholder maps.txt content — one map id per tile, operator fills real ids */
  mapsTxtTemplate: string;
}

export function buildFramePool(frames: QuantizedFrame[], speedTicks = 2): FramePoolResult {
  if (frames.length === 0) throw new Error("no frames");
  const { width, height } = frames[0]!;
  if (width % MAP_DIM !== 0 || height % MAP_DIM !== 0) {
    throw new Error(`frame ${width}×${height} must be a multiple of ${MAP_DIM}`);
  }
  const cols = width / MAP_DIM;
  const rows = height / MAP_DIM;
  const tiles = cols * rows;
  const speed = Math.max(1, Math.floor(speedTicks));

  const header = Buffer.alloc(4 + 4 * 5);
  header.write("MWMW", 0, "ascii");
  header.writeInt32BE(1, 4);
  header.writeInt32BE(cols, 8);
  header.writeInt32BE(rows, 12);
  header.writeInt32BE(frames.length, 16);
  header.writeInt32BE(speed, 20);

  const chunks: Buffer[] = [header];
  for (const frame of frames) {
    if (frame.width !== width || frame.height !== height) {
      throw new Error("all frames must share dimensions");
    }
    const tileList = splitIntoMaps(frame); // row-major
    for (const t of tileList) {
      const buf = Buffer.allocUnsafe(MAP_AREA);
      buf.set(t.frame.mapColorId.subarray(0, MAP_AREA));
      chunks.push(buf);
    }
  }

  const mapsTxtTemplate =
    `# one map id per tile (row-major, ${tiles} tiles). Replace with real ids.\n` +
    Array.from({ length: tiles }, (_, i) => i + 1).join(" ") +
    "\n";

  return { bin: Buffer.concat(chunks), cols, rows, frameCount: frames.length, mapsTxtTemplate };
}
