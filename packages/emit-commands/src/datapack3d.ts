// 3D voxel datapack emitter - the command-block builder for 3D block builds and 3D
// animations (e.g. a spin). Same 100%-vanilla playback machinery as the 2D wall
// (tick-driven scoreboard counter + macro dispatch), but each frame is a VoxelVolume
// and cells carry a Z. The build region's air-clear /fill lives at the TOP of frames/0
// (clear then paint, same tick), then later frames place only changed voxels (air
// transitions included) - so every LOOP WRAP back to frame 0 re-clears the box. A
// setup-only clear left voxels solid in the last frame but air in frame 0 uncleared
// forever: a looping spin degraded to the union of all poses after the first pass.

import { EMPTY, getVoxel, type VoxelVolume } from "@blockdream/voxel";
import type { NoteEvent } from "@blockdream/audio";
import { DEFAULT_MAX_COMMANDS, writeSplitFunction } from "./chunk";
import { fillLines, greedyBoxes } from "./fill";
import { noteSequencer, type Vec3 } from "./note-sequencer";
import { redstoneSequencer } from "./redstone-sequencer";
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
  const n = sx * sy * sz;
  const sxsy = sx * sy;
  const out: VoxelFrameDelta[] = [];
  // voxelIndex is x + sx*(y + sy*z), so backing-array index i ascends in exact z→y→x order:
  // a flat data[i] walk visits the same voxels as the nested loop but skips the per-voxel
  // inBounds + voxelIndex that getVoxel pays (every voxel here is provably in bounds). x/y/z
  // are reconstructed only for the voxels actually emitted (sparse for delta frames).
  for (let f = 0; f < volumes.length; f++) {
    const cur = volumes[f]!;
    if (cur.sx !== sx || cur.sy !== sy || cur.sz !== sz) {
      throw new Error(`frame ${f} is ${cur.sx}x${cur.sy}x${cur.sz}, expected ${sx}x${sy}x${sz}`);
    }
    const cd = cur.data;
    const cells: VoxelCell[] = [];
    if (f === 0) {
      for (let i = 0; i < n; i++) {
        const id = cd[i]!;
        if (id !== EMPTY) cells.push({ x: i % sx, y: ((i / sx) | 0) % sy, z: (i / sxsy) | 0, mapColorId: id });
      }
    } else {
      const pd = volumes[f - 1]!.data;
      for (let i = 0; i < n; i++) {
        const id = cd[i]!;
        if (pd[i] !== id) cells.push({ x: i % sx, y: ((i / sx) | 0) % sy, z: (i / sxsy) | 0, mapColorId: id });
      }
    }
    out.push({ index: f, keyframe: f === 0, cells });
  }
  return out;
}

export interface VoxelDatapackOptions extends DatapackOptions {
  /** optional fill optimizer applied to each frame's cells (see fill.ts). */
  optimize?: (cells: VoxelCell[], resolve: (id: number) => string) => string[];
  /**
   * Optional note-block music: an analyzed audio timeline (@blockdream/audio).
   * When present and non-empty, the pack gains a physical tuned note-block "music
   * area" and a tick-driven `playsound` sequencer that shares the build's #play
   * clock. Absent or empty ⇒ the pack is byte-identical to a music-less build.
   */
  music?: NoteEvent[];
  /** World position of the music area. Default: just past the build along +X. */
  musicOrigin?: Vec3;
  /**
   * How the note blocks are driven. "playsound" (default) plays the melody from a
   * tick-driven `/playsound` clock beside a decorative tuned keyboard — frame-accurate.
   * "redstone" instead builds a physical repeater delay-line that powers the note
   * blocks themselves in onset order, so the blocks play the song. The default is
   * byte-identical to a build with no `musicEngine` set.
   */
  musicEngine?: "playsound" | "redstone";
  /** Cap on emitted music notes (defaults: 1500 playsound / 800 redstone). Raise it for a
   *  full-length song — the playsound sequencer is one `execute if score` line per note. */
  musicMaxNotes?: number;
  /**
   * Place an invisible always-lit glow layer (`minecraft:light[level=15]`) one block outside
   * the named face of the build box, so the wall reads like a lit LED screen at night. Placed
   * once in setup with fill mode `keep` (never overwrites existing blocks); stop does NOT
   * remove it (the lights are invisible and non-colliding).
   */
  ledPlane?: "north" | "south" | "east" | "west";
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
 * {@link generateVoxelDatapack}. By construction it is byte-identical to the PAINT portion of that
 * datapack's frame-0 keyframe function body (same `computeVoxelDeltas` cells, same world offset,
 * same `greedyBoxes` merge) - the datapack's frames/0 additionally leads with the box-clear `fill`
 * lines, which the live CLI folds in the same way (buildBoxSetupCommands, same fillLines). So
 * casting a static build live over RCON places exactly what baking + loading would. No
 * scoreboard/macro wrapper, no `forceload`: just the block commands. An all-air volume yields `[]`.
 * Orient the build before calling (e.g. `rotateYQuarterTurns` for `--facing`); this paints as given.
 */
export function voxelToLiveCommands(
  volume: VoxelVolume,
  origin: { x: number; y: number; z: number },
  resolveBlock: (id: number) => string | undefined,
  opts: VoxelLiveOptions = {},
): string[] {
  return voxelFramesToLiveCommands([volume], origin, resolveBlock, opts)[0] ?? [];
}

/**
 * The per-frame LIVE counterpart of {@link generateVoxelDatapack}: delta-encode a sequence of equal-
 * sized volumes ({@link computeVoxelDeltas} - frame 0 is the full keyframe, later frames only the
 * changed voxels incl. solid→air) and emit each frame's `setblock`/`fill` commands at `origin`. Frame
 * f's list is byte-identical to the datapack's `frames/f` function body (same cells, offset, and
 * `greedyBoxes` merge; frames/0 additionally leads with the datapack's box-clear fills, which the
 * live CLI folds into its own frame 0), so streaming these over RCON in order IS the 3D animation
 * the datapack bakes.
 * One list per input volume; a single volume yields one keyframe list (== {@link voxelToLiveCommands}).
 */
export function voxelFramesToLiveCommands(
  volumes: VoxelVolume[],
  origin: { x: number; y: number; z: number },
  resolveBlock: (id: number) => string | undefined,
  opts: VoxelLiveOptions = {},
): string[][] {
  const fallback = opts.fallbackBlock ?? "minecraft:air";
  const air = "minecraft:air";
  const resolve = (id: number) => blockOf(id, resolveBlock, fallback, air);
  return computeVoxelDeltas(volumes).map((d) =>
    greedyBoxes(
      d.cells.map((c) => ({ x: origin.x + c.x, y: origin.y + c.y, z: origin.z + c.z, mapColorId: c.mapColorId })),
      resolve,
    ),
  );
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

  const x0 = origin.x;
  const y0 = origin.y;
  const z0 = origin.z;
  const x1 = origin.x + sx - 1;
  const y1 = origin.y + sy - 1;
  const z1 = origin.z + sz - 1;
  // Box clear, folded into the TOP of frames/0 (NOT setup): the driver wraps #f to 0 and
  // re-runs frames/0, so the clear runs on EVERY loop wrap. Frames after 0 only place
  // changed voxels, so a voxel solid in the LAST frame but air in frame 0 is otherwise
  // never cleared - a looping animation degraded to the union of all poses after the
  // first pass. Clear + paint execute in the same tick (one function), so no flicker;
  // the live RCON path (rcon-bridge-cli --build --setup) folds the identical clear the
  // same way. Split at the 32768 /fill cap.
  const clearLines = fillLines(x0, y0, z0, x1, y1, z1, air, "replace");

  let totalSetblocks = 0;
  let totalCommands = 0;
  for (const d of deltas) {
    const resolve = (id: number) => blockOf(id, resolveBlock, fallback, air);
    let lines: string[];
    if (opts.optimize) {
      // Explicit field construction (NOT `{ ...c, x: … }`): a VoxelCell is exactly
      // {x,y,z,mapColorId}, so this builds an identical object but skips the object-spread's
      // runtime key enumeration — ~5x faster on this 1-per-cell map (65→13ms at 256px / 1.47M
      // cells). Matches voxelToLiveCommands above (line ~130) which already does this.
      lines = opts.optimize(
        d.cells.map((c) => ({ x: origin.x + c.x, y: origin.y + c.y, z: origin.z + c.z, mapColorId: c.mapColorId })),
        resolve,
      );
    } else {
      lines = d.cells.map(
        (c) => `setblock ${origin.x + c.x} ${origin.y + c.y} ${origin.z + c.z} ${resolve(c.mapColorId)} replace`,
      );
    }
    totalSetblocks += d.cells.length;
    totalCommands += lines.length;
    // frame 0 leads with the wrap-safe box clear (totalCommands stays content-only,
    // matching the old setup-clear accounting)
    if (d.keyframe) lines = [...clearLines, ...lines];
    const header = `# frame ${d.index}${d.keyframe ? " (keyframe)" : ` (Δ ${d.cells.length})`}`;
    writeSplitFunction(files, `${fnDir}/frames/${d.index}`, lines, limit, (k) => `function ${ns}:frames/${d.index}/part${k}`, header);
  }

  files.set(`${fnDir}/play.mcfunction`, `$function ${ns}:frames/$(idx)\n`);

  // Optional note-block music. Additive by construction: when there are no notes,
  // `seq` is undefined and every music-conditioned spread below is empty, so the
  // emitted pack is byte-identical to a music-less build.
  const music = opts.music && opts.music.length ? opts.music : undefined;
  const musicOrigin = opts.musicOrigin ?? { x: origin.x + sx + 2, y: origin.y, z: origin.z };
  // Unified shape over both engines: `physical` is placed in setup (outside the build
  // box, which frames/0 force-clears every wrap), `musicLines` becomes music.mcfunction,
  // and `setupScores` seeds the shared #mt/#mtcount clock. The playsound branch calls
  // noteSequencer with the identical musicOrigin → byte-identical to before.
  // Animation + music: lock the music loop to the animation loop (frames × speed) on
  // BOTH engines. Unequal loop lengths re-phase on every wrap and drift more each cycle.
  const loopTicksOverride = volumes.length > 1 ? volumes.length * speed : undefined;
  // `bounds` is the physical music area's XZ footprint: setblock into an unloaded chunk
  // fails and redstone only ticks in loaded chunks, so the forceload rect must cover it
  // (the repro: a 199-cell delay line built past the build-box forceload silently died).
  const seqBuilt = !music
    ? undefined
    : (opts.musicEngine ?? "playsound") === "redstone"
      ? (() => {
          const r = redstoneSequencer(music, { musicOrigin, maxNotes: opts.musicMaxNotes, loopTicksOverride });
          return {
            physical: r.blocks,
            musicLines: r.musicLines,
            setupScores: r.setupScores,
            noteCount: r.noteCount,
            loopTicks: r.loopTicks,
            // input cell at x-1; spine spans `length` cells; note-block tap row at z+1
            bounds: r.noteCount
              ? { x0: r.inputPos.x, x1: musicOrigin.x + r.length - 1, z0: musicOrigin.z, z1: musicOrigin.z + 1 }
              : undefined,
          };
        })()
      : (() => {
          const n = noteSequencer(music, {
            musicOrigin,
            maxNotes: opts.musicMaxNotes,
            loopTicksOverride,
          });
          return {
            physical: n.keyboard,
            musicLines: n.musicLines,
            setupScores: n.setupScores,
            noteCount: n.noteCount,
            loopTicks: n.loopTicks,
            // one keyboard cell per distinct (instrument, note) along +X
            bounds: n.keyboardNotes
              ? { x0: musicOrigin.x, x1: musicOrigin.x + n.keyboardNotes - 1, z0: musicOrigin.z, z1: musicOrigin.z }
              : undefined,
          };
        })();
  // Zero SURVIVING notes (the loop trim / note cap emptied the melody) = NO music
  // machinery at all: no music.mcfunction, no tick.json registration, no #mt/#mtcount
  // scores. Otherwise the pack ticked #mt forever against a never-created #mtcount
  // while playing nothing. Byte-identical to a music-less build, per the contract above.
  const seq = seqBuilt && seqBuilt.noteCount > 0 ? seqBuilt : undefined;

  // Optional LED glow layer: an invisible light plane one block outside the chosen face.
  const ledBox = opts.ledPlane
    ? {
        x0: opts.ledPlane === "east" ? x1 + 1 : opts.ledPlane === "west" ? x0 - 1 : x0,
        x1: opts.ledPlane === "east" ? x1 + 1 : opts.ledPlane === "west" ? x0 - 1 : x1,
        z0: opts.ledPlane === "south" ? z1 + 1 : opts.ledPlane === "north" ? z0 - 1 : z0,
        z1: opts.ledPlane === "south" ? z1 + 1 : opts.ledPlane === "north" ? z0 - 1 : z1,
      }
    : undefined;
  // forceload must cover the LED plane (it can cross into the next chunk row) AND the
  // physical music area (keyboard or redstone delay line - both live outside the build box)
  const flx0 = Math.min(x0, ledBox?.x0 ?? x0, seq?.bounds?.x0 ?? x0);
  const flx1 = Math.max(x1, ledBox?.x1 ?? x1, seq?.bounds?.x1 ?? x1);
  const flz0 = Math.min(z0, ledBox?.z0 ?? z0, seq?.bounds?.z0 ?? z0);
  const flz1 = Math.max(z1, ledBox?.z1 ?? z1, seq?.bounds?.z1 ?? z1);

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
      ...(seq ? seq.setupScores : []),
      `forceload add ${flx0} ${flz0} ${flx1} ${flz1}`,
      // build-box clear lives at the top of frames/0 (called below) so loop wraps re-clear
      // LED glow layer: invisible full-bright light plane fronting the wall ("keep" never clobbers)
      ...(ledBox ? fillLines(ledBox.x0, y0, ledBox.z0, ledBox.x1, y1, ledBox.z1, "minecraft:light[level=15]", "keep") : []),
      ...(seq ? seq.physical : []), // place the physical music area (tuned keyboard or redstone track)
      `function ${ns}:frames/0`,
      "",
    ].join("\n"),
  );
  if (seq) files.set(`${fnDir}/music.mcfunction`, seq.musicLines.join("\n"));

  // start re-acquires the forceload that stop releases - stop fully frees the chunks
  // (server-friendly: a paused animation keeps nothing loaded), start gets them back.
  files.set(
    `${fnDir}/start.mcfunction`,
    [`forceload add ${flx0} ${flz0} ${flx1} ${flz1}`, `scoreboard players set #play ma 1`, ""].join("\n"),
  );
  files.set(
    `${fnDir}/stop.mcfunction`,
    [`scoreboard players set #play ma 0`, `forceload remove ${flx0} ${flz0} ${flx1} ${flz1}`, ""].join("\n"),
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
  files.set(
    `data/minecraft/tags/function/tick.json`,
    JSON.stringify({ values: seq ? [`${ns}:driver`, `${ns}:music`] : [`${ns}:driver`] }, null, 2) + "\n",
  );
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

  return {
    files,
    namespace: ns,
    frameCount: volumes.length,
    width: sx,
    height: sy,
    totalSetblocks,
    totalCommands,
    // honest music reporting: what the pack actually plays, not the input timeline length
    musicNoteCount: seq ? seq.noteCount : 0,
    musicLoopTicks: seq ? seq.loopTicks : 0,
  };
}
