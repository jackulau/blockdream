import { gzipSync, gunzipSync } from "node:zlib";
import type { QuantizedFrame } from "@blockdream/color-core";
import {
  Byte,
  ByteArray,
  Compound,
  Int,
  Str,
  TAG,
  writeNbt,
  readNbt,
  type NbtValue,
} from "./nbt";

export const MAP_DIM = 128;
export const MAP_AREA = MAP_DIM * MAP_DIM; // 16384

/** DataVersion is version-pinned; this is the value for 1.21.x. Override per target. */
export const DEFAULT_DATA_VERSION = 4435;

export interface MapDatOptions {
  dataVersion?: number;
  dimension?: string;
  scale?: number;
  locked?: boolean;
  xCenter?: number;
  zCenter?: number;
  /** gzip output (real map_<n>.dat files are gzipped). Default true. */
  gzip?: boolean;
}

/** Extract the 16384-byte `colors` array from a 128×128 quantized frame. */
export function toMapColors(frame: QuantizedFrame): Uint8Array {
  if (frame.width !== MAP_DIM || frame.height !== MAP_DIM) {
    throw new Error(
      `a single map is ${MAP_DIM}×${MAP_DIM}; got ${frame.width}×${frame.height}. Use splitIntoMaps() for larger frames.`,
    );
  }
  // mapColorId is already the byte written verbatim into the colors array.
  return Uint8Array.from(frame.mapColorId);
}

/** Build the NBT tree for a filled map item (`map_<n>.dat`). */
export function buildMapNbt(colors: Uint8Array, opts: MapDatOptions = {}): NbtValue {
  if (colors.length !== MAP_AREA) throw new Error(`colors must be ${MAP_AREA} bytes`);
  const data = Compound({
    scale: Byte(opts.scale ?? 0),
    dimension: Str(opts.dimension ?? "minecraft:overworld"),
    locked: Byte(opts.locked === false ? 0 : 1),
    trackingPosition: Byte(0),
    unlimitedTracking: Byte(0),
    xCenter: Int(opts.xCenter ?? 0),
    zCenter: Int(opts.zCenter ?? 0),
    colors: ByteArray(colors),
  });
  return Compound({
    DataVersion: Int(opts.dataVersion ?? DEFAULT_DATA_VERSION),
    data,
  });
}

/** Serialize a 128×128 quantized frame to a `map_<n>.dat` byte buffer. */
export function buildMapDat(frame: QuantizedFrame, opts: MapDatOptions = {}): Buffer {
  const nbt = buildMapNbt(toMapColors(frame), opts);
  const raw = writeNbt("", nbt);
  return opts.gzip === false ? raw : gzipSync(raw);
}

/** Read back the colors array from a (possibly gzipped) map_<n>.dat — used by tests/tools. */
export function readMapColors(datBytes: Buffer): Uint8Array {
  const isGzip = datBytes[0] === 0x1f && datBytes[1] === 0x8b;
  const raw = isGzip ? gunzipSync(datBytes) : datBytes;
  const { root } = readNbt(raw);
  if (root.type !== TAG.Compound) throw new Error("bad map.dat root");
  const data = root.value["data"];
  if (!data || data.type !== TAG.Compound) throw new Error("map.dat missing data compound");
  const colors = data.value["colors"];
  if (!colors || colors.type !== TAG.ByteArray) throw new Error("map.dat missing colors");
  return colors.value;
}

export interface MapTile {
  col: number;
  row: number;
  frame: QuantizedFrame;
}

/**
 * Split a (cols·128)×(rows·128) quantized frame into a grid of 128×128 map tiles
 * for a map wall. Throws if dimensions are not exact multiples of 128.
 */
export function splitIntoMaps(frame: QuantizedFrame): MapTile[] {
  if (frame.width % MAP_DIM !== 0 || frame.height % MAP_DIM !== 0) {
    throw new Error(`frame ${frame.width}×${frame.height} is not a multiple of ${MAP_DIM}`);
  }
  const cols = frame.width / MAP_DIM;
  const rows = frame.height / MAP_DIM;
  const tiles: MapTile[] = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const idx = new Int32Array(MAP_AREA);
      const ids = new Uint8Array(MAP_AREA);
      for (let y = 0; y < MAP_DIM; y++) {
        const srcY = row * MAP_DIM + y;
        for (let x = 0; x < MAP_DIM; x++) {
          const srcX = col * MAP_DIM + x;
          const sp = srcY * frame.width + srcX;
          const dp = y * MAP_DIM + x;
          idx[dp] = frame.paletteIndex[sp]!;
          ids[dp] = frame.mapColorId[sp]!;
        }
      }
      tiles.push({
        col,
        row,
        frame: { width: MAP_DIM, height: MAP_DIM, paletteIndex: idx, mapColorId: ids },
      });
    }
  }
  return tiles;
}
