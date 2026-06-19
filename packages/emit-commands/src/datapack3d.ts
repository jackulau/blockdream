// 3D voxel datapack emitter - the command-block builder for 3D block builds and 3D
// animations (e.g. a spin). Same 100%-vanilla playback machinery as the 2D wall
// (tick-driven scoreboard counter + macro dispatch), but each frame is a VoxelVolume
// and cells carry a Z. The build region is cleared once with /fill, then keyframe 0
// places the solids and later frames place only changed voxels (air transitions included).

import { EMPTY, getVoxel, type VoxelVolume } from "@blockdream/voxel";
import { DEFAULT_MAX_COMMANDS, writeSplitFunction } from "./chunk";
import { fillLines, greedyBoxes } from "./fill";
import type { DatapackOptions, GeneratedPack } from "./datapack";

const RESERVED = new Set(["minecraft"]);

function assertNamespace(ns: string): void {
  if (!/^[a-z0-9_-]+$/.test(ns) || RESERVED.has(ns)) {
    throw new Error(`invalid datapack namespace: ${ns}`);
  }
}

export interface VoxelCell {
  x: number;
  y: number;
  z: number;
  mapColorId: number; // EMPTY means "becomes air"
}

export interface VoxelFrameDelta {
  index: number;
  keyframe: boolean;
  cells: VoxelCell[];
}

/** Delta-encode a sequence of equal-sized volumes. Frame 0 = every solid voxel; later
 *  frames = only voxels that changed (including solid→air and air→solid transitions). */
export function computeVoxelDeltas(volumes: VoxelVolume[]): VoxelFrameDelta[] {
  if (volumes.length === 0) return [];
  const { sx, sy, sz } = volumes[0]!;
  const out: VoxelFrameDelta[] = [];
  for (let f = 0; f < volumes.length; f++) {
    const cur = volumes[f]!;
    if (cur.sx !== sx || cur.sy !== sy || cur.sz !== sz) {
      throw new Error(`frame ${f} is ${cur.sx}x${cur.sy}x${cur.sz}, expected ${sx}x${sy}x${sz}`);
    }
    const prev = f === 0 ? undefined : volumes[f - 1]!;
    const cells: VoxelCell[] = [];
    for (let z = 0; z < sz; z++) {
      for (let y = 0; y < sy; y++) {
        for (let x = 0; x < sx; x++) {
          const id = getVoxel(cur, x, y, z);
          if (f === 0) {
            if (id !== EMPTY) cells.push({ x, y, z, mapColorId: id });
          } else if (getVoxel(prev!, x, y, z) !== id) {
            cells.push({ x, y, z, mapColorId: id });
          }
        }
      }
    }
    out.push({ index: f, keyframe: f === 0, cells });
  }
  return out;
}

export interface VoxelDatapackOptions extends DatapackOptions {
  /** optional fill optimizer applied to each frame's cells (see fill.ts). */
  optimize?: (cells: VoxelCell[], resolve: (id: number) => string) => string[];
}

function blockOf(id: number, resolveBlock: (id: number) => string | undefined, fallback: string, air: string): string {
  return id === EMPTY ? air : (resolveBlock(id) ?? fallback);
}

export interface VoxelLiveOptions {
  /** Block placed where a solid voxel has no mapped block. Default minecraft:air. */
  fallbackBlock?: string;
}

/**
 * A 3D build's blocks as standalone `setblock`/`fill` commands at `origin` - the LIVE counterpart of
 * {@link generateVoxelDatapack}. By construction it is byte-identical to that datapack's frame-0
 * keyframe function body (same `computeVoxelDeltas` cells, same world offset, same `greedyBoxes`
 * merge), so casting a static build live over RCON places exactly what baking + loading would. No
 * scoreboard/macro wrapper, no `forceload`: just the block commands. An all-air volume yields `[]`.
 * Orient the build before calling (e.g. `rotateYQuarterTurns` for `--facing`); this paints as given.
 */
export function voxelToLiveCommands(
  volume: VoxelVolume,
  origin: { x: number; y: number; z: number },
  resolveBlock: (id: number) => string | undefined,
  opts: VoxelLiveOptions = {},
): string[] {
  const fallback = opts.fallbackBlock ?? "minecraft:air";
  const air = "minecraft:air";
  const resolve = (id: number) => blockOf(id, resolveBlock, fallback, air);
  const cells = computeVoxelDeltas([volume])[0]!.cells.map((c) => ({
    x: origin.x + c.x,
    y: origin.y + c.y,
    z: origin.z + c.z,
    mapColorId: c.mapColorId,
  }));
  return greedyBoxes(cells, resolve);
}

/** Generate a vanilla Java datapack that builds (and animates) a 3D voxel volume. */
export function generateVoxelDatapack(
  volumes: VoxelVolume[],
  resolveBlock: (mapColorId: number) => string | undefined,
  opts: VoxelDatapackOptions = {},
): GeneratedPack {
  if (volumes.length === 0) throw new Error("no frames");
  const ns = opts.namespace ?? "blockdream";
  assertNamespace(ns);
  const packFormat = opts.packFormat ?? 48;
  const origin = opts.origin ?? { x: 0, y: 64, z: 0 };
  const speed = Math.max(1, Math.floor(opts.speedTicks ?? 2));
  const fallback = opts.fallbackBlock ?? "minecraft:air";
  const air = "minecraft:air";
  const { sx, sy, sz } = volumes[0]!;
  const limit = Math.max(1, Math.floor(opts.maxCommandsPerFunction ?? DEFAULT_MAX_COMMANDS));

  const deltas = computeVoxelDeltas(volumes);
  const files = new Map<string, string>();
  const fnDir = `data/${ns}/function`;

  let totalSetblocks = 0;
  let totalCommands = 0;
  for (const d of deltas) {
    const resolve = (id: number) => blockOf(id, resolveBlock, fallback, air);
    let lines: string[];
    if (opts.optimize) {
      lines = opts.optimize(
        d.cells.map((c) => ({ ...c, x: origin.x + c.x, y: origin.y + c.y, z: origin.z + c.z })),
        resolve,
      );
    } else {
      lines = d.cells.map(
        (c) => `setblock ${origin.x + c.x} ${origin.y + c.y} ${origin.z + c.z} ${resolve(c.mapColorId)} replace`,
      );
    }
    totalSetblocks += d.cells.length;
    totalCommands += lines.length;
    const header = `# frame ${d.index}${d.keyframe ? " (keyframe)" : ` (Δ ${d.cells.length})`}`;
    writeSplitFunction(files, `${fnDir}/frames/${d.index}`, lines, limit, (k) => `function ${ns}:frames/${d.index}/part${k}`, header);
  }

  files.set(`${fnDir}/play.mcfunction`, `$function ${ns}:frames/$(idx)\n`);

  const x0 = origin.x;
  const y0 = origin.y;
  const z0 = origin.z;
  const x1 = origin.x + sx - 1;
  const y1 = origin.y + sy - 1;
  const z1 = origin.z + sz - 1;
  files.set(
    `${fnDir}/setup.mcfunction`,
    [
      `# one-time setup: load via /function ${ns}:setup`,
      `scoreboard objectives add ma dummy`,
      `scoreboard players set #play ma ${opts.autoplay ? 1 : 0}`,
      `scoreboard players set #t ma 0`,
      `scoreboard players set #f ma 0`,
      `scoreboard players set #speed ma ${speed}`,
      `scoreboard players set #count ma ${volumes.length}`,
      `forceload add ${x0} ${z0} ${x1} ${z1}`,
      ...fillLines(x0, y0, z0, x1, y1, z1, air, "replace"), // clear the build box (split at the 32768 /fill cap)
      `function ${ns}:frames/0`,
      "",
    ].join("\n"),
  );

  // start re-acquires the forceload that stop releases - stop fully frees the chunks
  // (server-friendly: a paused animation keeps nothing loaded), start gets them back.
  files.set(
    `${fnDir}/start.mcfunction`,
    [`forceload add ${x0} ${z0} ${x1} ${z1}`, `scoreboard players set #play ma 1`, ""].join("\n"),
  );
  files.set(
    `${fnDir}/stop.mcfunction`,
    [`scoreboard players set #play ma 0`, `forceload remove ${x0} ${z0} ${x1} ${z1}`, ""].join("\n"),
  );
  files.set(
    `${fnDir}/driver.mcfunction`,
    [
      `# advance + dispatch, runs every tick from #minecraft:tick`,
      `execute unless score #play ma matches 1 run return 0`,
      `scoreboard players add #t ma 1`,
      `execute if score #t ma < #speed ma run return 0`,
      `scoreboard players set #t ma 0`,
      `scoreboard players add #f ma 1`,
      `execute if score #f ma >= #count ma run scoreboard players set #f ma 0`,
      `execute store result storage ${ns}:anim idx int 1 run scoreboard players get #f ma`,
      `function ${ns}:play with storage ${ns}:anim`,
      "",
    ].join("\n"),
  );
  files.set(`data/minecraft/tags/function/tick.json`, JSON.stringify({ values: [`${ns}:driver`] }, null, 2) + "\n");
  const packMeta: {
    pack_format: number;
    description: string;
    supported_formats?: { min_inclusive: number; max_inclusive: number };
  } = {
    pack_format: packFormat,
    description: opts.description ?? `blockdream 3D voxel build (${sx}x${sy}x${sz}, ${volumes.length} frames)`,
  };
  if (opts.supportedFormats) packMeta.supported_formats = opts.supportedFormats;
  files.set("pack.mcmeta", JSON.stringify({ pack: packMeta }, null, 2) + "\n");

  return { files, namespace: ns, frameCount: volumes.length, width: sx, height: sy, totalSetblocks, totalCommands };
}
