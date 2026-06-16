import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  getJavaMapPalette,
  getBedrockMapPalette,
  getSolidBlockMapPalette,
  resolveMcVersion,
  JAVA_DATAPACK_SUPPORTED,
  BEDROCK_BLOCK_VERSION,
} from "@blockdream/palette";
import {
  preparePalette,
  quantizeFrame,
  quantizeVideo,
  buildRgbLut,
  type DitherMethod,
  type QuantizedFrame,
  type PreparedPalette,
} from "@blockdream/color-core";
import { extractFrames } from "@blockdream/video";
import { buildMapDat, splitIntoMaps, buildFramePool, MAP_DIM } from "@blockdream/emit-java";
import { buildMcStructure, buildVoxelMcStructure } from "@blockdream/emit-bedrock";
import { generateJavaDatapack, generateVoxelDatapack, greedyBoxes, packageJavaDatapack, packageMcpack, makeBlockResolver, resolveSolidBlockId, solidBlockByMapColorId } from "@blockdream/emit-commands";
import { framesToAnimated3d } from "@blockdream/voxel";
import {
  generateBedrockBehaviorPack,
  generateBedrockScriptAddon,
  writePack,
} from "@blockdream/emit-commands/node";

export type RenderTarget =
  | "map"
  | "mcstructure"
  | "mcstructure3d"
  | "datapack"
  | "behaviorpack"
  | "bedrock-script"
  | "mwframes"
  | "voxel3d";
export type Edition = "java" | "bedrock";

export interface RenderOptions {
  input: string;
  out: string;
  target: RenderTarget;
  width: number;
  height: number;
  edition?: Edition;
  fps?: number;
  maxFrames?: number;
  dither?: DitherMethod;
  temporalThreshold?: number;
  speedTicks?: number;
  paletteVersion?: string;
  depth?: number; // voxel3d: max build depth in blocks (default 8)
}

export interface RenderResult {
  target: RenderTarget;
  frameCount: number;
  width: number;
  height: number;
  filesWritten: string[];
  notes: string[];
}

function writeFile(path: string, data: Buffer | string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, data);
}

function quantizeAll(
  frames: import("@blockdream/color-core").RgbImage[],
  pal: PreparedPalette,
  dither: DitherMethod,
  temporalThreshold: number | undefined,
): QuantizedFrame[] {
  if (frames.length <= 1) {
    // single still → exact OKLab match (best quality)
    return frames.map((f) => quantizeFrame(f, pal, { method: dither }));
  }
  // video → prebuilt LUT for O(1)/pixel matching (≈20× faster, imperceptible penalty)
  const lut = buildRgbLut(pal);
  return quantizeVideo(frames, pal, { method: dither, temporalThreshold, lut });
}

/**
 * End-to-end render: decode input → quantize → emit artifacts for the chosen
 * target. Returns the list of files written. Pure enough to unit-test (writes
 * to `out`, no process state).
 */
export function render(opts: RenderOptions): RenderResult {
  const edition: Edition = opts.edition ?? "java";
  // Resolve the target MC version once → format stamps for every emitted artifact.
  // Throws a helpful error for an unsupported version (vs. a deep ENOENT later).
  const mc = resolveMcVersion(opts.paletteVersion);
  const notes: string[] = [];
  const filesWritten: string[] = [];

  const frames = extractFrames(opts.input, {
    width: opts.width,
    height: opts.height,
    fps: opts.fps,
    maxFrames: opts.maxFrames,
  });
  if (frames.length === 0) throw new Error("no frames decoded from input");
  const isVideo = frames.length > 1;
  // default dither: video → bayer (temporally stable), still → floyd-steinberg
  const dither: DitherMethod = opts.dither ?? (isVideo ? "bayer" : "floyd-steinberg");

  if (opts.target === "map") {
    const mapPal =
      edition === "bedrock"
        ? getBedrockMapPalette(opts.paletteVersion)
        : getJavaMapPalette(opts.paletteVersion);
    const pal = preparePalette(mapPal);
    const q = quantizeAll(frames, pal, dither, opts.temporalThreshold);
    if (opts.width % MAP_DIM !== 0 || opts.height % MAP_DIM !== 0) {
      throw new Error(`map target requires grid sizes that are multiples of ${MAP_DIM} (got ${opts.width}×${opts.height})`);
    }
    q.forEach((frame, fi) => {
      const tiles = splitIntoMaps(frame);
      for (const t of tiles) {
        const name = tiles.length > 1 ? `map_${fi}_c${t.col}_r${t.row}.dat` : `map_${fi}.dat`;
        const path = join(opts.out, name);
        writeFile(path, buildMapDat(t.frame, { dataVersion: mc.dataVersion }));
        filesWritten.push(path);
      }
    });
    notes.push(`${edition} filled-map .dat (${frames.length} frame(s), DataVersion ${mc.dataVersion}; older stamps auto-upgrade on load); load with an NBT/world tool or the datapack item-frame wall.`);
    return { target: opts.target, frameCount: frames.length, width: opts.width, height: opts.height, filesWritten, notes };
  }

  if (opts.target === "mwframes") {
    const mapPal =
      edition === "bedrock"
        ? getBedrockMapPalette(opts.paletteVersion)
        : getJavaMapPalette(opts.paletteVersion);
    const pal = preparePalette(mapPal);
    const q = quantizeAll(frames, pal, dither, opts.temporalThreshold);
    if (opts.width % MAP_DIM !== 0 || opts.height % MAP_DIM !== 0) {
      throw new Error(`mwframes target requires grid sizes that are multiples of ${MAP_DIM}`);
    }
    const pool = buildFramePool(q, opts.speedTicks);
    const binPath = join(opts.out, "frames.bin");
    const mapsPath = join(opts.out, "maps.txt");
    writeFile(binPath, pool.bin);
    writeFile(mapsPath, pool.mapsTxtTemplate);
    filesWritten.push(binPath, mapsPath);
    notes.push(`Fabric map-wall pool (${pool.cols}×${pool.rows} maps, ${frames.length} frames). Edit maps.txt with real map ids; the mods/java-fabric mod plays it.`);
    return { target: opts.target, frameCount: frames.length, width: opts.width, height: opts.height, filesWritten, notes };
  }

  // block-based targets. Use the canonical shade-tolerant + air-aware resolver (block-resolver.ts) so
  // the CLI can't drift from the library and a non-+2 shade (4-shade palette / model import) never
  // silently drops to air. `solidIds` backs the mcstructure closures that need {name, states}.
  const { palette } = getSolidBlockMapPalette(opts.paletteVersion);
  const pal = preparePalette(palette);
  const q = quantizeAll(frames, pal, dither, opts.temporalThreshold);
  const resolveBlock = makeBlockResolver(opts.paletteVersion);
  const solidIds = solidBlockByMapColorId();
  const resolveMcStructureBlock = (id: number) => {
    const name = resolveSolidBlockId(solidIds, id);
    return name ? { name, states: {} } : undefined;
  };

  if (opts.target === "voxel3d") {
    // video → temporally-stable animated 3D block build → vanilla datapack (delta-encoded, fill-batched)
    const volumes = framesToAnimated3d(q, { maxDepth: opts.depth ?? 8 });
    const pack = generateVoxelDatapack(volumes, resolveBlock, {
      namespace: "blockdream_3d",
      packFormat: mc.packFormat,
      supportedFormats: JAVA_DATAPACK_SUPPORTED,
      optimize: (cells, r) => greedyBoxes(cells, r),
    });
    writePack(pack, opts.out);
    filesWritten.push(...[...pack.files.keys()].map((k) => join(opts.out, k)));
    const zip = join(opts.out, `${pack.namespace}.zip`);
    writeFile(zip, Buffer.from(packageJavaDatapack(pack)));
    filesWritten.push(zip);
    notes.push(
      `3D voxel datapack (${volumes.length} frame(s), ${pack.totalCommands ?? pack.totalSetblocks} cmds): drop ${pack.namespace}.zip into world/datapacks/, /function ${pack.namespace}:setup then :start.`,
    );
    return { target: opts.target, frameCount: frames.length, width: opts.width, height: opts.height, filesWritten, notes };
  }

  if (opts.target === "mcstructure") {
    q.forEach((frame, fi) => {
      const buf = buildMcStructure(frame, resolveMcStructureBlock, { blockVersion: BEDROCK_BLOCK_VERSION });
      const path = join(opts.out, q.length > 1 ? `frame_${fi}.mcstructure` : `art.mcstructure`);
      writeFile(path, buf);
      filesWritten.push(path);
    });
    notes.push(`Bedrock .mcstructure (${frames.length} frame(s)); import with a structure block or world tool.`);
    return { target: opts.target, frameCount: frames.length, width: opts.width, height: opts.height, filesWritten, notes };
  }

  if (opts.target === "mcstructure3d") {
    // image/video → temporally-stable 3D volumes (same pipeline as voxel3d) → a TRUE 3D Bedrock
    // .mcstructure per frame (depth = volume depth, not the 1-thick wall of `mcstructure`)
    const volumes = framesToAnimated3d(q, { maxDepth: opts.depth ?? 8 });
    volumes.forEach((vol, fi) => {
      const buf = buildVoxelMcStructure(vol, resolveMcStructureBlock, { blockVersion: BEDROCK_BLOCK_VERSION });
      const path = join(opts.out, volumes.length > 1 ? `frame_${fi}.mcstructure` : `model3d.mcstructure`);
      writeFile(path, buf);
      filesWritten.push(path);
    });
    const v0 = volumes[0]!;
    notes.push(
      `TRUE 3D Bedrock .mcstructure (${volumes.length} frame(s), ${v0.sx}×${v0.sy}×${v0.sz}); place with a structure block or import via a world tool.`,
    );
    return { target: opts.target, frameCount: frames.length, width: opts.width, height: opts.height, filesWritten, notes };
  }

  if (opts.target === "bedrock-script") {
    const pack = generateBedrockScriptAddon(q, resolveBlock, { speedTicks: opts.speedTicks });
    writePack(pack, opts.out);
    filesWritten.push(...[...pack.files.keys()].map((k) => join(opts.out, k)));
    const mcpack = join(opts.out, "blockdream-script.mcpack");
    writeFile(mcpack, Buffer.from(packageMcpack(pack.files, { stripPrefix: "behavior_pack/" })));
    filesWritten.push(mcpack);
    notes.push(`Bedrock Script-API addon: double-click blockdream-script.mcpack to import, then in chat: !mw start.`);
    return { target: opts.target, frameCount: frames.length, width: opts.width, height: opts.height, filesWritten, notes };
  }

  if (opts.target === "datapack") {
    const pack = generateJavaDatapack(q, resolveBlock, {
      speedTicks: opts.speedTicks,
      packFormat: mc.packFormat,
      supportedFormats: JAVA_DATAPACK_SUPPORTED,
    });
    writePack(pack, opts.out);
    filesWritten.push(...[...pack.files.keys()].map((k) => join(opts.out, k)));
    const zip = join(opts.out, `${pack.namespace}.zip`);
    writeFile(zip, Buffer.from(packageJavaDatapack(pack)));
    filesWritten.push(zip);
    notes.push(`Vanilla Java datapack (pack_format ${mc.packFormat}; loads on MC ${JAVA_DATAPACK_SUPPORTED.min_inclusive}..${JAVA_DATAPACK_SUPPORTED.max_inclusive} via supported_formats): drop ${pack.namespace}.zip (or the folder) into world/datapacks/, run /function ${pack.namespace}:setup then /function ${pack.namespace}:start.`);
    return { target: opts.target, frameCount: frames.length, width: opts.width, height: opts.height, filesWritten, notes };
  }

  // behaviorpack
  const pack = generateBedrockBehaviorPack(q, resolveBlock, { speedTicks: opts.speedTicks });
  writePack(pack, opts.out);
  filesWritten.push(...[...pack.files.keys()].map((k) => join(opts.out, k)));
  const mcpack = join(opts.out, "blockdream.mcpack");
  writeFile(mcpack, Buffer.from(packageMcpack(pack.files)));
  filesWritten.push(mcpack);
  notes.push(`Vanilla Bedrock behavior pack: double-click blockdream.mcpack to import (or copy the folder to behavior_packs/), /function ${pack.namespace}/setup then /function ${pack.namespace}/start.`);
  return { target: opts.target, frameCount: frames.length, width: opts.width, height: opts.height, filesWritten, notes };
}
