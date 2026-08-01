import type { QuantizedFrame } from "@blockdream/color-core";
import type { BlockEntry } from "@blockdream/palette";
import { EMPTY, getVoxel, type VoxelVolume } from "@blockdream/voxel";
import {
  Compound,
  Int,
  IntList,
  List,
  Str,
  TAG,
  writeNbt,
  readNbt,
  type NbtValue,
  type NbtCompound,
} from "@blockdream/nbt";

/**
 * Bedrock block version int (packed [major,minor,patch,revision]). 1.21.0 here;
 * override per target. Bedrock upgrades older block versions on load, so this is
 * not load-critical, but pinning it avoids upgrade churn.
 */
export const DEFAULT_BLOCK_VERSION = 0x01_15_00_00; // 1.21.0

export interface BlockRef {
  /** e.g. "minecraft:white_concrete" */
  name: string;
  /** Bedrock block states (usually empty for the solid set). */
  states?: Record<string, string | number>;
}

export interface McStructureOptions {
  blockVersion?: number;
  /** Block placed where a pixel has no mapped block (default minecraft:air). */
  fill?: BlockRef;
  /** structure_world_origin stamped into the NBT - the coords the structure was captured at
   *  (a structure block re-places relative to where YOU stand; this is provenance). Default 0,0,0. */
  origin?: { x: number; y: number; z: number };
}

/** structure_world_origin NBT from an optional origin (default 0,0,0). */
function originList(origin?: { x: number; y: number; z: number }): NbtValue {
  return List(TAG.Int, [Int(origin?.x ?? 0), Int(origin?.y ?? 0), Int(origin?.z ?? 0)]);
}

function statesCompound(states: Record<string, string | number> = {}): NbtValue {
  const obj: NbtCompound = {};
  for (const [k, v] of Object.entries(states)) {
    obj[k] = typeof v === "number" ? Int(v) : Str(v);
  }
  return Compound(obj);
}

/**
 * Emit a flat block-build wall as a Bedrock `.mcstructure` (raw little-endian
 * NBT, not gzipped). The frame's `mapColorId` is resolved to a block via
 * `blockFor`; the wall stands in the X-Y plane, 1 block thick (+Z facing),
 * with image-row 0 at the top.
 */
export function buildMcStructure(
  frame: QuantizedFrame,
  blockFor: (mapColorId: number) => BlockRef | undefined,
  opts: McStructureOptions = {},
): Buffer {
  const W = frame.width;
  const H = frame.height;
  const D = 1;
  const fill = opts.fill ?? { name: "minecraft:air" };

  // Intern distinct blocks into the structure palette.
  const paletteIndex = new Map<string, number>();
  const blockPalette: NbtValue[] = [];
  const blockVersion = opts.blockVersion ?? DEFAULT_BLOCK_VERSION;
  const intern = (b: BlockRef): number => {
    const key = `${b.name}|${JSON.stringify(b.states ?? {})}`;
    let idx = paletteIndex.get(key);
    if (idx === undefined) {
      idx = blockPalette.length;
      paletteIndex.set(key, idx);
      blockPalette.push(
        Compound({
          name: Str(b.name),
          states: statesCompound(b.states),
          version: Int(blockVersion),
        }),
      );
    }
    return idx;
  };
  intern(fill); // ensure fill exists (commonly index 0)

  // Cache the palette index per raw mapColorId - the same goal-075 fix its 3D twin
  // buildVoxelMcStructure got: a repeated pixel skips both the blockFor resolve and the
  // per-cell `JSON.stringify(states)` intern key (the hot spot - a wall reuses a few
  // dozen distinct blocks across every pixel). `blockFor` is a pure id->block lookup,
  // so the first pixel using each id still interns in the unchanged x->y->z scan order:
  // every distinct block key lands at the same palette index as per-cell interning.
  // Byte-identical (locked against buildMcStructureReference in mcstructure-perf.test.ts).
  const idToPaletteIdx = new Map<number, number>();
  // Layer 0 = blocks, layer 1 = -1 (no second layer). Bedrock order: x outer, then y, then z.
  const layer0 = new Int32Array(W * H * D);
  const layer1 = new Int32Array(W * H * D);
  for (let x = 0; x < W; x++) {
    for (let y = 0; y < H; y++) {
      for (let z = 0; z < D; z++) {
        const idx = (x * H + y) * D + z;
        const py = H - 1 - y; // image row 0 at top of the wall
        const mapColorId = frame.mapColorId[py * W + x]!;
        let pi = idToPaletteIdx.get(mapColorId);
        if (pi === undefined) {
          pi = intern(blockFor(mapColorId) ?? fill);
          idToPaletteIdx.set(mapColorId, pi);
        }
        layer0[idx] = pi;
        layer1[idx] = -1;
      }
    }
  }

  const root = Compound({
    format_version: Int(1),
    size: List(TAG.Int, [Int(W), Int(H), Int(D)]),
    structure: Compound({
      block_indices: List(TAG.List, [IntList(layer0), IntList(layer1)]),
      entities: List(TAG.Compound, []),
      palette: Compound({
        default: Compound({
          block_palette: List(TAG.Compound, blockPalette),
          block_position_data: Compound({}),
        }),
      }),
    }),
    structure_world_origin: originList(opts.origin),
  });

  return writeNbt("", root, "little");
}

/**
 * Deliberately-simple REFERENCE implementation of {@link buildMcStructure}, kept
 * verbatim (algorithm and emitted bytes) from before the mapColorId->palette-index
 * memo: interns via the `${name}|${JSON.stringify(states)}` string key PER CELL.
 * Exported only so mcstructure-perf.test.ts can assert the optimized path is
 * byte-for-byte identical and faster. Do not optimize.
 */
export function buildMcStructureReference(
  frame: QuantizedFrame,
  blockFor: (mapColorId: number) => BlockRef | undefined,
  opts: McStructureOptions = {},
): Buffer {
  const W = frame.width;
  const H = frame.height;
  const D = 1;
  const fill = opts.fill ?? { name: "minecraft:air" };

  // Intern distinct blocks into the structure palette.
  const paletteIndex = new Map<string, number>();
  const blockPalette: NbtValue[] = [];
  const blockVersion = opts.blockVersion ?? DEFAULT_BLOCK_VERSION;
  const intern = (b: BlockRef): number => {
    const key = `${b.name}|${JSON.stringify(b.states ?? {})}`;
    let idx = paletteIndex.get(key);
    if (idx === undefined) {
      idx = blockPalette.length;
      paletteIndex.set(key, idx);
      blockPalette.push(
        Compound({
          name: Str(b.name),
          states: statesCompound(b.states),
          version: Int(blockVersion),
        }),
      );
    }
    return idx;
  };
  intern(fill); // ensure fill exists (commonly index 0)

  // Layer 0 = blocks, layer 1 = -1 (no second layer). Bedrock order: x outer, then y, then z.
  const layer0 = new Int32Array(W * H * D);
  const layer1 = new Int32Array(W * H * D);
  for (let x = 0; x < W; x++) {
    for (let y = 0; y < H; y++) {
      for (let z = 0; z < D; z++) {
        const idx = (x * H + y) * D + z;
        const py = H - 1 - y; // image row 0 at top of the wall
        const mapColorId = frame.mapColorId[py * W + x]!;
        const block = blockFor(mapColorId) ?? fill;
        layer0[idx] = intern(block);
        layer1[idx] = -1;
      }
    }
  }

  const root = Compound({
    format_version: Int(1),
    size: List(TAG.Int, [Int(W), Int(H), Int(D)]),
    structure: Compound({
      block_indices: List(TAG.List, [IntList(layer0), IntList(layer1)]),
      entities: List(TAG.Compound, []),
      palette: Compound({
        default: Compound({
          block_palette: List(TAG.Compound, blockPalette),
          block_position_data: Compound({}),
        }),
      }),
    }),
    structure_world_origin: originList(opts.origin),
  });

  return writeNbt("", root, "little");
}

/**
 * Emit a REAL 3D Bedrock `.mcstructure` from a VoxelVolume (depth = volume.sz, not the
 * flat 1-thick wall). Air voxels become the fill block. Bedrock index order is
 * x outer → y → z; Y is taken as-is (the voxel engine already orients Y up).
 */
export function buildVoxelMcStructure(
  volume: VoxelVolume,
  blockFor: (mapColorId: number) => BlockRef | undefined,
  opts: McStructureOptions = {},
): Buffer {
  const W = volume.sx;
  const H = volume.sy;
  const D = volume.sz;
  const fill = opts.fill ?? { name: "minecraft:air" };
  const blockVersion = opts.blockVersion ?? DEFAULT_BLOCK_VERSION;

  const paletteIndex = new Map<string, number>();
  const blockPalette: NbtValue[] = [];
  const intern = (b: BlockRef): number => {
    const key = `${b.name}|${JSON.stringify(b.states ?? {})}`;
    let idx = paletteIndex.get(key);
    if (idx === undefined) {
      idx = blockPalette.length;
      paletteIndex.set(key, idx);
      blockPalette.push(Compound({ name: Str(b.name), states: statesCompound(b.states), version: Int(blockVersion) }));
    }
    return idx;
  };
  intern(fill);

  // Cache the palette index per raw mapColorId so a repeated voxel skips the resolve + the
  // per-cell `JSON.stringify(states)` string key (the hot spot: at 256px/4.2M cells the intern
  // loop was ~96% of build time, since a build reuses only a few dozen distinct blocks across
  // millions of cells). `blockFor` is a pure id->block lookup and EMPTY always maps to `fill`, so
  // the first cell using each id still interns in the same x->y->z scan order: every distinct
  // block key lands at the same palette index it would under per-cell interning. Byte-identical.
  const idToPaletteIdx = new Map<number, number>();
  const layer0 = new Int32Array(W * H * D);
  const layer1 = new Int32Array(W * H * D);
  for (let x = 0; x < W; x++) {
    for (let y = 0; y < H; y++) {
      for (let z = 0; z < D; z++) {
        const idx = (x * H + y) * D + z;
        const id = getVoxel(volume, x, y, z);
        let pi = idToPaletteIdx.get(id);
        if (pi === undefined) {
          const block = id === EMPTY ? fill : (blockFor(id) ?? fill);
          pi = intern(block);
          idToPaletteIdx.set(id, pi);
        }
        layer0[idx] = pi;
        layer1[idx] = -1;
      }
    }
  }

  const root = Compound({
    format_version: Int(1),
    size: List(TAG.Int, [Int(W), Int(H), Int(D)]),
    structure: Compound({
      block_indices: List(TAG.List, [IntList(layer0), IntList(layer1)]),
      entities: List(TAG.Compound, []),
      palette: Compound({
        default: Compound({ block_palette: List(TAG.Compound, blockPalette), block_position_data: Compound({}) }),
      }),
    }),
    structure_world_origin: originList(opts.origin),
  });
  return writeNbt("", root, "little");
}

/** Convenience for the cross-edition solid set: resolve via a BlockEntry map. */
export function blockRefFromEntry(e: BlockEntry): BlockRef {
  return { name: e.id, states: {} };
}

export interface ParsedMcStructure {
  size: [number, number, number];
  blockNames: string[];
  /** layer-0 palette index per cell, in Bedrock x→y→z order. */
  indices: number[];
  /** structure_world_origin stamped into the NBT. */
  origin: [number, number, number];
}

/** Parse back a `.mcstructure` (for tests/tools). */
export function readMcStructure(buf: Buffer): ParsedMcStructure {
  const { root } = readNbt(buf, "little");
  if (root.type !== TAG.Compound) throw new Error("bad mcstructure root");
  const sizeTag = root.value["size"];
  const structure = root.value["structure"];
  if (sizeTag?.type !== TAG.List || structure?.type !== TAG.Compound) throw new Error("bad mcstructure");
  const size = sizeTag.value.map((v) => (v.type === TAG.Int ? v.value : 0)) as [number, number, number];

  const palette = structure.value["palette"];
  if (palette?.type !== TAG.Compound) throw new Error("no palette");
  const def = palette.value["default"];
  if (def?.type !== TAG.Compound) throw new Error("no default palette");
  const bp = def.value["block_palette"];
  const blockNames: string[] = [];
  if (bp?.type === TAG.List) {
    for (const entry of bp.value) {
      if (entry.type === TAG.Compound) {
        const name = entry.value["name"];
        blockNames.push(name?.type === TAG.String ? name.value : "?");
      }
    }
  }

  const bi = structure.value["block_indices"];
  const indices: number[] = [];
  if (bi?.type === TAG.List && bi.value[0]?.type === TAG.List) {
    for (const v of bi.value[0].value) if (v.type === TAG.Int) indices.push(v.value);
  }

  const swo = root.value["structure_world_origin"];
  const origin = (swo?.type === TAG.List ? swo.value.map((v) => (v.type === TAG.Int ? v.value : 0)) : [0, 0, 0]) as [number, number, number];

  return { size, blockNames, indices, origin };
}
