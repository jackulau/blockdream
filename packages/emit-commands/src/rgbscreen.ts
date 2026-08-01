// TRUE-RGB screen emitter - 16.7M colors in UNMODDED Minecraft. Vanilla has no RGB
// *block* (verified against every 2026 drop: 26.1 Tiny Takeover, 26.2 Chaos Cubed,
// the 26.3 snapshots - all fixed-color palettes), but a `text_display` entity's
// `background` is a full ARGB int. A grid of one-per-pixel text_displays therefore
// IS an exact-color screen: no palette quantization, no dither, per-pixel updates by
// `data merge entity <uuid> {background:<argb>}`. `brightness:{sky:15,block:15}`
// makes every pixel full-bright - the screen is inherently an LED wall.
//
// Same 100%-vanilla playback machinery as the block datapacks (tick-driven scoreboard
// counter + `$function` macro dispatch), so this composes with the note-block music
// sequencers unchanged. Pure string-building; no node/DOM imports.
//
// Frame encoding: setup summons every pixel with frame 0's color baked in, so
// frames/0 is the WRAP delta (last frame → frame 0), not a keyframe - the loop
// re-enters frame 0 with exactly the pixels that differ from the final frame.

import type { RgbImage } from "@blockdream/color-core";
import type { NoteEvent } from "@blockdream/audio";
import { DEFAULT_MAX_COMMANDS, writeSplitFunction } from "./chunk";
import { forceloadLines } from "./fill";
import { noteSequencer, type Vec3 } from "./note-sequencer";
import { redstoneSequencer } from "./redstone-sequencer";
import type { GeneratedPack } from "./datapack";

/** One screen frame: packed signed ARGB ints (0xAARRGGBB, alpha always 0xff). */
export interface RgbScreenFrame {
  width: number;
  height: number;
  argb: Int32Array;
}

/** Pack (r,g,b) into the signed 32-bit ARGB int NBT expects (alpha 255). */
export function argbInt(r: number, g: number, b: number): number {
  return ((255 << 24) | ((r & 0xff) << 16) | ((g & 0xff) << 8) | (b & 0xff)) | 0;
}

/**
 * RgbImage → screen frame, optionally posterized to `levels` values per channel.
 * Posterizing (e.g. 32) is how video survives delta encoding: raw decoder output has
 * per-frame sensor/codec noise on nearly every pixel, which would make every frame a
 * full-screen delta. 0/1 = keep exact 8-bit values.
 */
export function rgbImageToScreenFrame(img: RgbImage, levels = 32): RgbScreenFrame {
  const n = img.width * img.height;
  const argb = new Int32Array(n);
  const L = Math.floor(levels);
  const q =
    L >= 2 && L < 256
      ? (v: number) => Math.round((Math.round((v * (L - 1)) / 255) * 255) / (L - 1))
      : (v: number) => v;
  for (let i = 0; i < n; i++) {
    const j = i * 3;
    argb[i] = argbInt(q(img.data[j]!), q(img.data[j + 1]!), q(img.data[j + 2]!));
  }
  return { width: img.width, height: img.height, argb };
}

export type ScreenFacing = "north" | "south" | "east" | "west";

export interface RgbScreenOptions {
  /** datapack namespace (a..z0-9_-). Default "blockdream_rgb". */
  namespace?: string;
  /** pack_format for pack.mcmeta. Default 48 (MC 1.21.0). */
  packFormat?: number;
  /** supported_formats range for pack.mcmeta (see datapack.ts). */
  supportedFormats?: { min_inclusive: number; max_inclusive: number };
  /** Java NBT DataVersion of the TARGET version - selects the text-component NBT
   *  syntax (1.21.5 / DataVersion 4325 moved entity text from JSON-in-string to SNBT). */
  dataVersion?: number;
  description?: string;
  /** World position of the screen's bottom-left pixel. Default {x:0,y:64,z:0}. */
  origin?: Vec3;
  /** Which way the screen faces (viewer side). Default "south" (+Z). */
  facing?: ScreenFacing;
  /** ticks between frames (20 tps; 2 → 10 fps). Default 2. */
  speedTicks?: number;
  /** start playing immediately on load (else call <ns>:start). Default false. */
  autoplay?: boolean;
  /** max commands per function before splitting into sub-functions. */
  maxCommandsPerFunction?: number;
  /**
   * Per-pixel quad scale [x, y] of the text_display transformation. The default is
   * calibrated so the background quad of a single-space text fills ~1×1 block
   * (a space's background is ≈0.15 wide × 0.25 tall at scale 1). If your client
   * shows gaps or overlap (font/pack dependent), tune with --px-scale.
   */
  pxScale?: { x: number; y: number };
  /** Optional note-block music (see datapack3d.ts - identical wiring). */
  music?: NoteEvent[];
  musicOrigin?: Vec3;
  musicEngine?: "playsound" | "redstone";
  musicMaxNotes?: number;
}

const RESERVED = new Set(["minecraft"]);

/** Default quad scale: 1 block ≈ 6.667 × background-width, 4 × line-height. */
export const DEFAULT_PX_SCALE = { x: 6.667, y: 4.0 } as const;

/**
 * Deterministic, collision-free UUID for pixel `index` of screen `ns`.
 * splitmix32 stream seeded by index ⊕ hash(ns): the first output word alone is a
 * bijection of the seed, so two distinct pixel indexes can never share a UUID.
 * Deterministic on purpose - frame functions address entities by literal UUID
 * (O(1) lookup, no selector scan), so the ids must be reproducible at emit time.
 */
export function pixelUuid(ns: string, index: number): readonly [number, number, number, number] {
  let nsHash = 0;
  for (let i = 0; i < ns.length; i++) nsHash = Math.imul(nsHash ^ ns.charCodeAt(i), 0x85ebca6b) | 0;
  let h = (index ^ nsHash) | 0;
  const next = () => {
    h = (h + 0x9e3779b9) | 0;
    let z = h;
    z = Math.imul(z ^ (z >>> 16), 0x21f0aaad);
    z = Math.imul(z ^ (z >>> 15), 0x735a2d97);
    return (z ^ (z >>> 15)) | 0;
  };
  const a = next();
  const b = (next() & ~0xf000) | 0x4000; // RFC-4122 version 4 nibble
  const c = (next() & 0x3fffffff) | (0x80000000 | 0); // variant 10xx
  const d = next();
  return [a, b, c, d] as const;
}

/** Canonical 8-4-4-4-12 string form (what `data merge entity <uuid>` takes). */
export function uuidString(u: readonly [number, number, number, number]): string {
  const hex = (n: number) => (n >>> 0).toString(16).padStart(8, "0");
  const s = hex(u[0]) + hex(u[1]) + hex(u[2]) + hex(u[3]);
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

/** Yaw (deg) that turns the quad's front toward the viewer side. */
const FACING_YAW: Record<ScreenFacing, number> = { south: 0, west: 90, north: 180, east: -90 };

/** DataVersion where entity text components became SNBT (1.21.5). */
const SNBT_TEXT_DATA_VERSION = 4325;

function assertNamespace(nsv: string): void {
  if (!/^[a-z0-9_-]+$/.test(nsv) || RESERVED.has(nsv)) {
    throw new Error(`invalid datapack namespace: ${nsv}`);
  }
}

/** World position of image pixel (ix, iy) - iy is an IMAGE row (0 = top). */
export function pixelPos(
  origin: Vec3,
  facing: ScreenFacing,
  width: number,
  height: number,
  ix: number,
  iy: number,
): { x: number; y: number; z: number } {
  const wy = origin.y + (height - 1 - iy) + 0.5; // image row 0 at top, +0.5 to the cell center
  const along = ix + 0.5;
  switch (facing) {
    case "south": // screen along +X, viewer at +Z
      return { x: origin.x + along, y: wy, z: origin.z + 0.5 };
    case "north": // mirrored so the image is un-flipped for a viewer at -Z
      return { x: origin.x + (width - along), y: wy, z: origin.z + 0.5 };
    case "east": // screen along +Z, viewer at +X
      return { x: origin.x + 0.5, y: wy, z: origin.z + (width - along) };
    case "west":
      return { x: origin.x + 0.5, y: wy, z: origin.z + along };
  }
}

function fmtF(n: number): string {
  return `${Math.round(n * 1000) / 1000}f`;
}

/**
 * One frame's delta lines from precomputed per-pixel command prefixes.
 * `mergePrefix[i]` is `data merge entity <uuid> {background:` for pixel i, so each
 * changed pixel costs one prefix + int + "}" concat instead of rebuilding the whole
 * template (~2x faster line building). Since the direct-body-build optimization in
 * generateRgbScreenDatapack, this array form serves the SPLIT case (a frame whose
 * delta exceeds the per-function limit and must be chunked into part files) and the
 * bench A/B. Byte-identical to referenceRgbScreenDeltaLines (locked by
 * rgbscreen-perf.test.ts).
 */
export function rgbScreenDeltaLines(cur: Int32Array, prev: Int32Array, mergePrefix: string[]): string[] {
  const lines: string[] = [];
  for (let i = 0; i < mergePrefix.length; i++) {
    if (cur[i] !== prev[i]) lines.push(mergePrefix[i]! + cur[i] + "}");
  }
  return lines;
}

/**
 * Reference delta-line builder, kept verbatim from before the prefix optimization:
 * rebuilds the full command template per changed pixel per frame. Exported only for
 * the same-run opt-vs-ref A/B in rgbscreen-perf.test.ts. Do not optimize.
 */
export function referenceRgbScreenDeltaLines(cur: Int32Array, prev: Int32Array, uuids: string[]): string[] {
  const lines: string[] = [];
  for (let i = 0; i < uuids.length; i++) {
    if (cur[i] !== prev[i]) lines.push(`data merge entity ${uuids[i]} {background:${cur[i]}}`);
  }
  return lines;
}

/**
 * Generate a vanilla Java datapack that plays exact-RGB frames on a text_display screen.
 *
 * Hot path: on a real clip (e.g. 2,191 frames) the delta loop emits millions of
 * `data merge entity <uuid> {background:<argb>}` lines. Rebuilding that template per
 * changed pixel per frame re-concatenates the constant prefix millions of times, so the
 * per-pixel prefix is precomputed ONCE (`mergePrefix`). A frame that fits one function
 * file (the common case) has its body string built DIRECTLY - one += per changed pixel -
 * skipping the intermediate line array + join that writeSplitFunction would do; only an
 * over-limit frame takes the array + split path (via rgbScreenDeltaLines). Same for the
 * summon loop: every part of the summon string except position, UUID, and frame-0 color
 * is loop-invariant and hoisted. Output is byte-for-byte identical to
 * generateRgbScreenDatapackReference (locked by rgbscreen-perf.test.ts).
 */
export function generateRgbScreenDatapack(
  frames: RgbScreenFrame[],
  opts: RgbScreenOptions = {},
): GeneratedPack {
  if (frames.length === 0) throw new Error("no frames");
  const { width: W, height: H } = frames[0]!;
  if (W <= 0 || H <= 0) throw new Error(`empty screen ${W}x${H}`);
  for (const [f, fr] of frames.entries()) {
    if (fr.width !== W || fr.height !== H) {
      throw new Error(`frame ${f} is ${fr.width}x${fr.height}, expected ${W}x${H}`);
    }
  }
  const ns = opts.namespace ?? "blockdream_rgb";
  assertNamespace(ns);
  const packFormat = opts.packFormat ?? 48;
  const origin = opts.origin ?? { x: 0, y: 64, z: 0 };
  const facing = opts.facing ?? "south";
  const speed = Math.max(1, Math.floor(opts.speedTicks ?? 2));
  const limit = Math.max(1, Math.floor(opts.maxCommandsPerFunction ?? DEFAULT_MAX_COMMANDS));
  const scale = opts.pxScale ?? DEFAULT_PX_SCALE;
  const yaw = FACING_YAW[facing];
  // 1.21.5+ reads SNBT components; older versions want the JSON-in-a-string form.
  const textNbt = (opts.dataVersion ?? 0) >= SNBT_TEXT_DATA_VERSION ? `" "` : `'{"text":" "}'`;

  const n = W * H;
  // Precomputed per-pixel command prefixes: `data merge entity <uuid> {background:` is
  // invariant across ALL frames for a given pixel, so build it once, not per delta line.
  const mergePrefix: string[] = new Array(n);
  const uuidNbt: string[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const u = pixelUuid(ns, i);
    mergePrefix[i] = `data merge entity ${uuidString(u)} {background:`;
    uuidNbt[i] = `[I;${u[0]},${u[1]},${u[2]},${u[3]}]`;
  }

  const files = new Map<string, string>();
  const fnDir = `data/${ns}/function`;

  // screen: one summon per pixel, frame 0's color baked in (chunked under the limit)
  const f0 = frames[0]!.argb;
  const summons: string[] = new Array(n);
  const transform = `transformation:{left_rotation:[0f,0f,0f,1f],right_rotation:[0f,0f,0f,1f],translation:[0f,0f,0f],scale:[${fmtF(scale.x)},${fmtF(scale.y)},1f]}`;
  // hoisted loop invariants: the constant head, the ns/text mid-section, and the whole
  // tail (fmtF(yaw) + transform were previously re-evaluated/re-concatenated per pixel)
  const summonHead = "summon minecraft:text_display ";
  const summonMid = `,Tags:["${ns}"],text:${textNbt},background:`;
  const summonTail = `,see_through:0b,brightness:{sky:15,block:15},billboard:"fixed",Rotation:[${fmtF(yaw)},0f],${transform}}`;
  for (let iy = 0; iy < H; iy++) {
    for (let ix = 0; ix < W; ix++) {
      const i = iy * W + ix;
      const p = pixelPos(origin, facing, W, H, ix, iy);
      summons[i] =
        summonHead + p.x + " " + p.y + " " + p.z + " {UUID:" + uuidNbt[i] + summonMid + f0[i] + summonTail;
    }
  }
  writeSplitFunction(files, `${fnDir}/screen`, summons, limit, (k) => `function ${ns}:screen/part${k}`, `# summon the ${W}x${H} pixel grid (frame 0 baked in)`);

  // per-frame deltas; frames/0 is the WRAP delta (last → 0).
  // One cheap diff scan per frame collects the CHANGED pixel indexes (reusable Int32Array, no
  // per-frame allocation): the count fixes the header AND picks the write path. In the common
  // case the frame fits ONE function file, so the body string is built directly (one += of the
  // precomputed prefix + int + "}\n" per changed pixel) instead of pushing ~100k lines into an
  // array that writeSplitFunction immediately joins. Byte-identical: `join("\n") + "\n"` over N
  // lines IS the concatenation of `line + "\n"`, and the zero-line body is exactly one extra
  // "\n". A frame over the limit falls back to the array + writeSplitFunction path unchanged
  // (the split case).
  let totalSetblocks = 0;
  let totalCommands = 0;
  const changedIdx = new Int32Array(n);
  for (let f = 0; f < frames.length; f++) {
    const cur = frames[f]!.argb;
    const prev = frames[(f - 1 + frames.length) % frames.length]!.argb;
    let changed = 0;
    if (frames.length > 1) {
      for (let i = 0; i < n; i++) if (cur[i] !== prev[i]) changedIdx[changed++] = i;
    }
    totalSetblocks += changed;
    totalCommands += changed;
    const header = `# frame ${f}${f === 0 ? " (wrap Δ from last)" : ""} (Δ ${changed})`;
    if (changed <= limit) {
      let body = header + "\n";
      if (changed > 0) {
        for (let k = 0; k < changed; k++) {
          const i = changedIdx[k]!;
          body += mergePrefix[i]! + cur[i] + "}\n";
        }
      } else {
        body += "\n"; // the reference join over ZERO lines still appends its one trailing newline
      }
      files.set(`${fnDir}/frames/${f}.mcfunction`, body);
    } else {
      const lines = rgbScreenDeltaLines(cur, prev, mergePrefix);
      writeSplitFunction(files, `${fnDir}/frames/${f}`, lines, limit, (k) => `function ${ns}:frames/${f}/part${k}`, header);
    }
  }

  files.set(`${fnDir}/play.mcfunction`, `$function ${ns}:frames/$(idx)\n`);

  // forceload bounds: the one-block-thick screen plane. pixelPos MIRRORS the along-axis
  // for north/east (x or z = origin + (width - along)), so pixel ix=0 can be the FAR
  // corner: bound over BOTH corner pixels (min/max each axis). Bounding origin + ix=W-1
  // alone degenerates the rect to a single chunk for north/east screens.
  const corner0 = pixelPos(origin, facing, W, H, 0, 0);
  const corner1 = pixelPos(origin, facing, W, H, W - 1, 0);
  const scrX0 = Math.min(origin.x, Math.floor(corner0.x), Math.floor(corner1.x));
  const scrX1 = Math.max(origin.x, Math.floor(corner0.x), Math.floor(corner1.x));
  const scrZ0 = Math.min(origin.z, Math.floor(corner0.z), Math.floor(corner1.z));
  const scrZ1 = Math.max(origin.z, Math.floor(corner0.z), Math.floor(corner1.z));

  // Optional note-block music, identical wiring to the voxel datapack (shared #play clock,
  // music loop locked to the animation loop on BOTH engines so audio/video never re-phase).
  const music = opts.music && opts.music.length ? opts.music : undefined;
  const musicOrigin = opts.musicOrigin ?? { x: scrX1 + 2, y: origin.y, z: scrZ1 };
  const loopTicksOverride = frames.length > 1 ? frames.length * speed : undefined;
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
          const nn = noteSequencer(music, { musicOrigin, maxNotes: opts.musicMaxNotes, loopTicksOverride });
          return {
            physical: nn.keyboard,
            musicLines: nn.musicLines,
            setupScores: nn.setupScores,
            noteCount: nn.noteCount,
            loopTicks: nn.loopTicks,
            // one keyboard cell per distinct (instrument, note) along +X
            bounds: nn.keyboardNotes
              ? { x0: musicOrigin.x, x1: musicOrigin.x + nn.keyboardNotes - 1, z0: musicOrigin.z, z1: musicOrigin.z }
              : undefined,
          };
        })();
  // Zero SURVIVING notes (loop trim / note cap emptied the melody) = NO music machinery:
  // no music.mcfunction, no tick.json registration, no #mt/#mtcount scores (else #mt
  // ticked forever against a never-created #mtcount for a pack that plays nothing).
  const seq = seqBuilt && seqBuilt.noteCount > 0 ? seqBuilt : undefined;

  // forceload rect: the screen plane PLUS the physical music area (setblock into an
  // unloaded chunk fails, and a redstone delay line only ticks in loaded chunks)
  const flx0 = Math.min(scrX0, seq?.bounds?.x0 ?? scrX0);
  const flx1 = Math.max(scrX1, seq?.bounds?.x1 ?? scrX1);
  const flz0 = Math.min(scrZ0, seq?.bounds?.z0 ?? scrZ0);
  const flz1 = Math.max(scrZ1, seq?.bounds?.z1 ?? scrZ1);

  files.set(
    `${fnDir}/setup.mcfunction`,
    [
      `# one-time setup: load via /function ${ns}:setup`,
      `scoreboard objectives add ma dummy`,
      `scoreboard players set #play ma ${opts.autoplay ? 1 : 0}`,
      `scoreboard players set #t ma 0`,
      `scoreboard players set #f ma 0`,
      `scoreboard players set #speed ma ${speed}`,
      `scoreboard players set #count ma ${frames.length}`,
      ...(seq ? seq.setupScores : []),
      // split at the 256-chunk /forceload cap (a long redstone spine can exceed it)
      ...forceloadLines(flx0, flz0, flx1, flz1, "add"),
      `kill @e[type=minecraft:text_display,tag=${ns}]`, // idempotent re-setup
      `function ${ns}:screen`,
      ...(seq ? seq.physical : []),
      "",
    ].join("\n"),
  );
  if (seq) files.set(`${fnDir}/music.mcfunction`, seq.musicLines.join("\n"));

  files.set(
    `${fnDir}/start.mcfunction`,
    [...forceloadLines(flx0, flz0, flx1, flz1, "add"), `scoreboard players set #play ma 1`, ""].join("\n"),
  );
  files.set(
    `${fnDir}/stop.mcfunction`,
    [`scoreboard players set #play ma 0`, ...forceloadLines(flx0, flz0, flx1, flz1, "remove"), ""].join("\n"),
  );
  files.set(
    `${fnDir}/teardown.mcfunction`,
    [
      `# remove the screen entirely (entities persist in the world save)`,
      `# forceload first: kill only reaches LOADED entities, and after :stop the`,
      `# screen chunks may have unloaded (teardown from far away would leak pixels)`,
      ...forceloadLines(flx0, flz0, flx1, flz1, "add"),
      `scoreboard players set #play ma 0`,
      `kill @e[type=minecraft:text_display,tag=${ns}]`,
      ...forceloadLines(flx0, flz0, flx1, flz1, "remove"),
      "",
    ].join("\n"),
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
    description: opts.description ?? `blockdream TRUE-RGB screen (${W}x${H}, ${frames.length} frames)`,
  };
  if (opts.supportedFormats) packMeta.supported_formats = opts.supportedFormats;
  files.set("pack.mcmeta", JSON.stringify({ pack: packMeta }, null, 2) + "\n");

  return {
    files,
    namespace: ns,
    frameCount: frames.length,
    width: W,
    height: H,
    totalSetblocks,
    totalCommands,
    // honest music reporting: what the pack actually plays, not the input timeline length
    musicNoteCount: seq ? seq.noteCount : 0,
    musicLoopTicks: seq ? seq.loopTicks : 0,
  };
}

/**
 * Deliberately-simple REFERENCE implementation, kept verbatim (algorithm and
 * emitted bytes) from before the string-building optimization (per-pixel template
 * literals rebuilt per frame). Exported only so tests can assert the optimized path
 * is byte-for-byte identical and faster (same pattern as greedyBoxesSparse vs
 * greedyBoxes). Do not optimize.
 */
export function generateRgbScreenDatapackReference(
  frames: RgbScreenFrame[],
  opts: RgbScreenOptions = {},
): GeneratedPack {
  if (frames.length === 0) throw new Error("no frames");
  const { width: W, height: H } = frames[0]!;
  if (W <= 0 || H <= 0) throw new Error(`empty screen ${W}x${H}`);
  for (const [f, fr] of frames.entries()) {
    if (fr.width !== W || fr.height !== H) {
      throw new Error(`frame ${f} is ${fr.width}x${fr.height}, expected ${W}x${H}`);
    }
  }
  const ns = opts.namespace ?? "blockdream_rgb";
  assertNamespace(ns);
  const packFormat = opts.packFormat ?? 48;
  const origin = opts.origin ?? { x: 0, y: 64, z: 0 };
  const facing = opts.facing ?? "south";
  const speed = Math.max(1, Math.floor(opts.speedTicks ?? 2));
  const limit = Math.max(1, Math.floor(opts.maxCommandsPerFunction ?? DEFAULT_MAX_COMMANDS));
  const scale = opts.pxScale ?? DEFAULT_PX_SCALE;
  const yaw = FACING_YAW[facing];
  // 1.21.5+ reads SNBT components; older versions want the JSON-in-a-string form.
  const textNbt = (opts.dataVersion ?? 0) >= SNBT_TEXT_DATA_VERSION ? `" "` : `'{"text":" "}'`;

  const n = W * H;
  const uuids: string[] = new Array(n);
  const uuidNbt: string[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const u = pixelUuid(ns, i);
    uuids[i] = uuidString(u);
    uuidNbt[i] = `[I;${u[0]},${u[1]},${u[2]},${u[3]}]`;
  }

  const files = new Map<string, string>();
  const fnDir = `data/${ns}/function`;

  // screen: one summon per pixel, frame 0's color baked in (chunked under the limit)
  const f0 = frames[0]!.argb;
  const summons: string[] = new Array(n);
  const transform = `transformation:{left_rotation:[0f,0f,0f,1f],right_rotation:[0f,0f,0f,1f],translation:[0f,0f,0f],scale:[${fmtF(scale.x)},${fmtF(scale.y)},1f]}`;
  for (let iy = 0; iy < H; iy++) {
    for (let ix = 0; ix < W; ix++) {
      const i = iy * W + ix;
      const p = pixelPos(origin, facing, W, H, ix, iy);
      summons[i] =
        `summon minecraft:text_display ${p.x} ${p.y} ${p.z} ` +
        `{UUID:${uuidNbt[i]},Tags:["${ns}"],text:${textNbt},background:${f0[i]},` +
        `see_through:0b,brightness:{sky:15,block:15},billboard:"fixed",Rotation:[${fmtF(yaw)},0f],${transform}}`;
    }
  }
  writeSplitFunction(files, `${fnDir}/screen`, summons, limit, (k) => `function ${ns}:screen/part${k}`, `# summon the ${W}x${H} pixel grid (frame 0 baked in)`);

  // per-frame deltas; frames/0 is the WRAP delta (last → 0)
  let totalSetblocks = 0;
  let totalCommands = 0;
  for (let f = 0; f < frames.length; f++) {
    const cur = frames[f]!.argb;
    const prev = frames[(f - 1 + frames.length) % frames.length]!.argb;
    const lines: string[] = [];
    if (frames.length > 1) {
      for (let i = 0; i < n; i++) {
        if (cur[i] !== prev[i]) lines.push(`data merge entity ${uuids[i]} {background:${cur[i]}}`);
      }
    }
    totalSetblocks += lines.length;
    totalCommands += lines.length;
    const header = `# frame ${f}${f === 0 ? " (wrap Δ from last)" : ""} (Δ ${lines.length})`;
    writeSplitFunction(files, `${fnDir}/frames/${f}`, lines, limit, (k) => `function ${ns}:frames/${f}/part${k}`, header);
  }

  files.set(`${fnDir}/play.mcfunction`, `$function ${ns}:frames/$(idx)\n`);

  // forceload bounds: the one-block-thick screen plane. pixelPos MIRRORS the along-axis
  // for north/east (x or z = origin + (width - along)), so pixel ix=0 can be the FAR
  // corner: bound over BOTH corner pixels (min/max each axis). Bounding origin + ix=W-1
  // alone degenerates the rect to a single chunk for north/east screens.
  const corner0 = pixelPos(origin, facing, W, H, 0, 0);
  const corner1 = pixelPos(origin, facing, W, H, W - 1, 0);
  const scrX0 = Math.min(origin.x, Math.floor(corner0.x), Math.floor(corner1.x));
  const scrX1 = Math.max(origin.x, Math.floor(corner0.x), Math.floor(corner1.x));
  const scrZ0 = Math.min(origin.z, Math.floor(corner0.z), Math.floor(corner1.z));
  const scrZ1 = Math.max(origin.z, Math.floor(corner0.z), Math.floor(corner1.z));

  // Optional note-block music, identical wiring to the voxel datapack (shared #play clock,
  // music loop locked to the animation loop on BOTH engines so audio/video never re-phase).
  const music = opts.music && opts.music.length ? opts.music : undefined;
  const musicOrigin = opts.musicOrigin ?? { x: scrX1 + 2, y: origin.y, z: scrZ1 };
  const loopTicksOverride = frames.length > 1 ? frames.length * speed : undefined;
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
          const nn = noteSequencer(music, { musicOrigin, maxNotes: opts.musicMaxNotes, loopTicksOverride });
          return {
            physical: nn.keyboard,
            musicLines: nn.musicLines,
            setupScores: nn.setupScores,
            noteCount: nn.noteCount,
            loopTicks: nn.loopTicks,
            // one keyboard cell per distinct (instrument, note) along +X
            bounds: nn.keyboardNotes
              ? { x0: musicOrigin.x, x1: musicOrigin.x + nn.keyboardNotes - 1, z0: musicOrigin.z, z1: musicOrigin.z }
              : undefined,
          };
        })();
  // Zero SURVIVING notes (loop trim / note cap emptied the melody) = NO music machinery:
  // no music.mcfunction, no tick.json registration, no #mt/#mtcount scores (else #mt
  // ticked forever against a never-created #mtcount for a pack that plays nothing).
  const seq = seqBuilt && seqBuilt.noteCount > 0 ? seqBuilt : undefined;

  // forceload rect: the screen plane PLUS the physical music area (setblock into an
  // unloaded chunk fails, and a redstone delay line only ticks in loaded chunks)
  const flx0 = Math.min(scrX0, seq?.bounds?.x0 ?? scrX0);
  const flx1 = Math.max(scrX1, seq?.bounds?.x1 ?? scrX1);
  const flz0 = Math.min(scrZ0, seq?.bounds?.z0 ?? scrZ0);
  const flz1 = Math.max(scrZ1, seq?.bounds?.z1 ?? scrZ1);

  files.set(
    `${fnDir}/setup.mcfunction`,
    [
      `# one-time setup: load via /function ${ns}:setup`,
      `scoreboard objectives add ma dummy`,
      `scoreboard players set #play ma ${opts.autoplay ? 1 : 0}`,
      `scoreboard players set #t ma 0`,
      `scoreboard players set #f ma 0`,
      `scoreboard players set #speed ma ${speed}`,
      `scoreboard players set #count ma ${frames.length}`,
      ...(seq ? seq.setupScores : []),
      // split at the 256-chunk /forceload cap (a long redstone spine can exceed it)
      ...forceloadLines(flx0, flz0, flx1, flz1, "add"),
      `kill @e[type=minecraft:text_display,tag=${ns}]`, // idempotent re-setup
      `function ${ns}:screen`,
      ...(seq ? seq.physical : []),
      "",
    ].join("\n"),
  );
  if (seq) files.set(`${fnDir}/music.mcfunction`, seq.musicLines.join("\n"));

  files.set(
    `${fnDir}/start.mcfunction`,
    [...forceloadLines(flx0, flz0, flx1, flz1, "add"), `scoreboard players set #play ma 1`, ""].join("\n"),
  );
  files.set(
    `${fnDir}/stop.mcfunction`,
    [`scoreboard players set #play ma 0`, ...forceloadLines(flx0, flz0, flx1, flz1, "remove"), ""].join("\n"),
  );
  files.set(
    `${fnDir}/teardown.mcfunction`,
    [
      `# remove the screen entirely (entities persist in the world save)`,
      `# forceload first: kill only reaches LOADED entities, and after :stop the`,
      `# screen chunks may have unloaded (teardown from far away would leak pixels)`,
      ...forceloadLines(flx0, flz0, flx1, flz1, "add"),
      `scoreboard players set #play ma 0`,
      `kill @e[type=minecraft:text_display,tag=${ns}]`,
      ...forceloadLines(flx0, flz0, flx1, flz1, "remove"),
      "",
    ].join("\n"),
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
    description: opts.description ?? `blockdream TRUE-RGB screen (${W}x${H}, ${frames.length} frames)`,
  };
  if (opts.supportedFormats) packMeta.supported_formats = opts.supportedFormats;
  files.set("pack.mcmeta", JSON.stringify({ pack: packMeta }, null, 2) + "\n");

  return {
    files,
    namespace: ns,
    frameCount: frames.length,
    width: W,
    height: H,
    totalSetblocks,
    totalCommands,
    // honest music reporting: what the pack actually plays, not the input timeline length
    musicNoteCount: seq ? seq.noteCount : 0,
    musicLoopTicks: seq ? seq.loopTicks : 0,
  };
}
