import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  getJavaMapPalette,
  getBedrockMapPalette,
  getSolidBlockMapPalette,
} from "@mineworld/palette";
import {
  preparePalette,
  quantizeFrame,
  quantizeVideo,
  buildRgbLut,
  type DitherMethod,
  type QuantizedFrame,
  type PreparedPalette,
} from "@mineworld/color-core";
import { extractFrames } from "@mineworld/video";
import { buildMapDat, splitIntoMaps, buildFramePool, MAP_DIM } from "@mineworld/emit-java";
import { buildMcStructure } from "@mineworld/emit-bedrock";
import { generateJavaDatapack, generateVoxelDatapack, greedyBoxes, packageJavaDatapack, packageMcpack } from "@mineworld/emit-commands";
import { framesToAnimated3d } from "@mineworld/voxel";
import {
  generateBedrockBehaviorPack,
  generateBedrockScriptAddon,
  writePack,
} from "@mineworld/emit-commands/node";

export type RenderTarget =
  | "map"
  | "mcstructure"
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
  frames: import("@mineworld/color-core").RgbImage[],
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
        writeFile(path, buildMapDat(t.frame));
        filesWritten.push(path);
      }
    });
    notes.push(`${edition} filled-map .dat (${frames.length} frame(s)); load with an NBT/world tool or the datapack item-frame wall.`);
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

  // block-based targets
  const { palette, blockByMapColorId } = getSolidBlockMapPalette(opts.paletteVersion);
  const pal = preparePalette(palette);
  const q = quantizeAll(frames, pal, dither, opts.temporalThreshold);
  const resolveBlock = (id: number) => blockByMapColorId.get(id)?.id;

  if (opts.target === "voxel3d") {
    // video → temporally-stable animated 3D block build → vanilla datapack (delta-encoded, fill-batched)
    const volumes = framesToAnimated3d(q, { maxDepth: opts.depth ?? 8 });
    const pack = generateVoxelDatapack(volumes, resolveBlock, {
      namespace: "mineworld_3d",
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
      const buf = buildMcStructure(frame, (id) => {
        const b = blockByMapColorId.get(id);
        return b ? { name: b.id, states: {} } : undefined;
      });
      const path = join(opts.out, q.length > 1 ? `frame_${fi}.mcstructure` : `art.mcstructure`);
      writeFile(path, buf);
      filesWritten.push(path);
    });
    notes.push(`Bedrock .mcstructure (${frames.length} frame(s)); import with a structure block or world tool.`);
    return { target: opts.target, frameCount: frames.length, width: opts.width, height: opts.height, filesWritten, notes };
  }

  if (opts.target === "bedrock-script") {
    const pack = generateBedrockScriptAddon(q, resolveBlock, { speedTicks: opts.speedTicks });
    writePack(pack, opts.out);
    filesWritten.push(...[...pack.files.keys()].map((k) => join(opts.out, k)));
    const mcpack = join(opts.out, "mineworld-script.mcpack");
    writeFile(mcpack, Buffer.from(packageMcpack(pack.files, { stripPrefix: "behavior_pack/" })));
    filesWritten.push(mcpack);
    notes.push(`Bedrock Script-API addon: double-click mineworld-script.mcpack to import, then in chat: !mw start.`);
    return { target: opts.target, frameCount: frames.length, width: opts.width, height: opts.height, filesWritten, notes };
  }

  if (opts.target === "datapack") {
    const pack = generateJavaDatapack(q, resolveBlock, { speedTicks: opts.speedTicks });
    writePack(pack, opts.out);
    filesWritten.push(...[...pack.files.keys()].map((k) => join(opts.out, k)));
    const zip = join(opts.out, `${pack.namespace}.zip`);
    writeFile(zip, Buffer.from(packageJavaDatapack(pack)));
    filesWritten.push(zip);
    notes.push(`Vanilla Java datapack: drop ${pack.namespace}.zip (or the folder) into world/datapacks/, run /function ${pack.namespace}:setup then /function ${pack.namespace}:start.`);
    return { target: opts.target, frameCount: frames.length, width: opts.width, height: opts.height, filesWritten, notes };
  }

  // behaviorpack
  const pack = generateBedrockBehaviorPack(q, resolveBlock, { speedTicks: opts.speedTicks });
  writePack(pack, opts.out);
  filesWritten.push(...[...pack.files.keys()].map((k) => join(opts.out, k)));
  const mcpack = join(opts.out, "mineworld.mcpack");
  writeFile(mcpack, Buffer.from(packageMcpack(pack.files)));
  filesWritten.push(mcpack);
  notes.push(`Vanilla Bedrock behavior pack: double-click mineworld.mcpack to import (or copy the folder to behavior_packs/), /function ${pack.namespace}/setup then /function ${pack.namespace}/start.`);
  return { target: opts.target, frameCount: frames.length, width: opts.width, height: opts.height, filesWritten, notes };
}
