// PURE CORE of the no-mod live Minecraft bridge. A sidecar polls a STOCK vanilla server
// over RCON - `data get entity <name> Pos` / `Rotation` - derives a world-model action
// from the pose delta, sends it to ml serve.py over WS, and paints the returned frame as
// a vertical solid-block wall via literal `setblock`/`fill` RCON commands. No mod, no
// datapack, no client plugin: RCON is the entire transport.
//
// Everything here is side-effect-free data transformation (the sidecar owns sockets):
//   parsePosRotation   RCON reply text → {x,y,z,yaw,pitch} (never throws)
//   poseToAction       two polled poses + poll interval → control-sim's deriveAction,
//                      so the WS message is byte-identical to the serve.py schema
//   frameToWallCommands RGB(A) frame → quantize (solid-block palette) → delta vs the
//                      previous frame → greedy box merge → capped vanilla commands

import {
  computeDeltas,
  greedyBoxes,
  makeBlockResolver,
  fillLines,
  DEFAULT_MAX_COMMANDS,
  type Cell,
  type PlacedCell,
} from "@blockdream/emit-commands";
import { getSolidBlockMapPalette } from "@blockdream/palette";
import {
  preparePalette,
  quantizeFrame,
  type DitherMethod,
  type PreparedPalette,
  type QuantizedFrame,
  type RgbImage,
} from "@blockdream/color-core";
import { deriveAction, type Action, type Pose } from "./control-sim";

// the action message/encoding is control-sim's - re-export so a sidecar imports one module
export { actionMessage, BTN, N_BUTTONS, type Action } from "./control-sim";

// ---------------------------------------------------------------------------
// 1. RCON reply parsing
// ---------------------------------------------------------------------------

/** A player pose as observed via RCON `data get entity` (Pos doubles + Rotation floats). */
export interface RconPose {
  x: number;
  y: number;
  z: number;
  yaw: number; // degrees, MC convention (0 = +Z / south)
  pitch: number; // degrees
}

export type PosRotationResult = RconPose | { error: string };

/** Type guard: did {@link parsePosRotation} fail? */
export function isParseError(r: PosRotationResult): r is { error: string } {
  return "error" in r;
}

// one SNBT number: optional sign, decimal or scientific, optional type suffix (d/f/b/s/L)
const SNBT_NUM = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?[dfbslDFBSL]?$/;

function parseNumList(group: string): number[] | null {
  const parts = group.split(",").map((s) => s.trim());
  if (parts.length === 0 || parts.some((p) => !SNBT_NUM.test(p))) return null;
  const nums = parts.map((p) => Number(p.replace(/[dfbslDFBSL]$/, "")));
  return nums.every(Number.isFinite) ? nums : null;
}

/**
 * Parse vanilla 1.21 `data get entity <name> Pos` / `Rotation` reply text, e.g.
 * "Steve has the following entity data: [1.5d, 64.0d, -3.25d]". Pass the two replies
 * CONCATENATED for a full pose: the 3-number list is Pos (x,y,z), the 2-number list is
 * Rotation (yaw,pitch). A missing list leaves its fields 0 (so a Pos-only poll still
 * yields a position). Handles d/f suffixes, negatives, scientific notation, and the
 * "No entity was found" reply. Never throws - junk input becomes `{error}`.
 */
export function parsePosRotation(rconText: string): PosRotationResult {
  try {
    const text = String(rconText ?? "");
    if (/no entity was found/i.test(text)) return { error: "no entity was found" };
    let pos: number[] | null = null;
    let rot: number[] | null = null;
    for (const m of text.matchAll(/\[([^\[\]]*)\]/g)) {
      const nums = parseNumList(m[1]!);
      if (!nums) continue;
      if (nums.length === 3 && !pos) pos = nums;
      else if (nums.length === 2 && !rot) rot = nums;
    }
    if (!pos && !rot) {
      return { error: `no Pos/Rotation list found in RCON reply: ${text.slice(0, 120)}` };
    }
    return {
      x: pos?.[0] ?? 0,
      y: pos?.[1] ?? 0,
      z: pos?.[2] ?? 0,
      yaw: rot?.[0] ?? 0,
      pitch: rot?.[1] ?? 0,
    };
  } catch (e) {
    return { error: `parse failure: ${e instanceof Error ? e.message : String(e)}` };
  }
}

// ---------------------------------------------------------------------------
// 2. pose delta → world-model action
// ---------------------------------------------------------------------------

const TICK_MS = 50; // 20 tps - control-sim's thresholds are per-tick metres/degrees
const SPRINT_SPEED = 0.25; // m/tick: sprint ≈ 0.28, walk ≈ 0.216 → clean separation
const RISE_SPEED = 0.1; // m/tick upward = jump launch (initial jump velocity ≈ 0.42)

function wrapDeg(d: number): number {
  let x = ((d + 180) % 360 + 360) % 360 - 180;
  if (x === -180) x = 180;
  return x;
}

/**
 * Derive the serve.py action from two RCON-polled poses. Built ON TOP of control-sim's
 * `deriveAction` (the single source of the {type:"action", buttons[9], camera[2], skill}
 * schema): the poll-interval deltas are rescaled to ONE TICK (50 ms) so deriveAction's
 * per-tick movement/camera thresholds apply regardless of the sidecar's poll rate, then
 * fed through as synthetic consecutive-tick poses. RCON can't see keyboard state, so the
 * server-derivable extras are inferred: horizontal speed > sprint threshold → sprint,
 * rising faster than the jump launch threshold → jump. `dtMs ≤ 0` is treated as one tick.
 */
export function poseToAction(prev: RconPose, cur: RconPose, dtMs: number, skill?: string): Action {
  const s = TICK_MS / (dtMs > 0 ? dtMs : TICK_MS);
  const dx = (cur.x - prev.x) * s;
  const dy = (cur.y - prev.y) * s;
  const dz = (cur.z - prev.z) * s;
  const dyaw = wrapDeg(cur.yaw - prev.yaw) * s;
  const dpitch = (cur.pitch - prev.pitch) * s;

  const sprinting = Math.hypot(dx, dz) > SPRINT_SPEED;
  const rising = dy > RISE_SPEED;

  // synthetic one-tick-apart poses: cur keeps the REAL facing (movement is projected into
  // cur.yaw's frame), prev is back-computed so the deltas deriveAction sees are per-tick.
  const simPrev: Pose = {
    x: cur.x - dx,
    z: cur.z - dz,
    yaw: cur.yaw - dyaw,
    pitch: cur.pitch - dpitch,
    onGround: true,
    sprinting: false,
    sneaking: false,
  };
  const simCur: Pose = {
    x: cur.x,
    z: cur.z,
    yaw: cur.yaw,
    pitch: cur.pitch,
    onGround: !rising, // just left the ground → deriveAction sets the jump button
    sprinting,
    sneaking: false, // indistinguishable from slow walking over RCON - never inferred
  };
  return deriveAction(simPrev, simCur, skill);
}

// ---------------------------------------------------------------------------
// 3. world-model frame → block-wall commands
// ---------------------------------------------------------------------------

/** A world-model frame as the sidecar receives it: RGB (3 B/px) or RGBA (4 B/px). */
export interface WallFrame {
  width: number;
  height: number;
  pixels: Uint8Array | Uint8ClampedArray;
}

/** Compass direction the live wall faces. south = the native XY-plane-at-z wall (no rotation). */
export type WallFacing = "north" | "south" | "east" | "west";
const WALL_FACINGS: ReadonlySet<string> = new Set(["north", "south", "east", "west"]);
export function isWallFacing(s: string): s is WallFacing {
  return WALL_FACINGS.has(s);
}

/**
 * Map an image cell (cx,cy) to its world block for a wall at `origin` facing `facing`. Rows always
 * run down Y (image row 0 at the top). south/north put columns on X (wall in the XY plane at
 * z=origin.z); east/west put columns on Z (wall in the ZY plane at x=origin.x). north/west mirror the
 * column axis so the image reads correctly from the opposite side. south is the byte-identical default.
 */
function placeCell(
  origin: { x: number; y: number; z: number },
  facing: WallFacing,
  W: number,
  H: number,
  cx: number,
  cy: number,
): { x: number; y: number; z: number } {
  const y = origin.y + (H - 1 - cy);
  switch (facing) {
    case "north":
      return { x: origin.x + (W - 1 - cx), y, z: origin.z };
    case "east":
      return { x: origin.x, y, z: origin.z + cx };
    case "west":
      return { x: origin.x, y, z: origin.z + (W - 1 - cx) };
    default:
      return { x: origin.x + cx, y, z: origin.z }; // south
  }
}

export interface WallCommandOptions {
  /**
   * Per-frame command budget (docs/vanilla-command-budgets.md - the same 8000-command
   * function budget the datapack generators split at). RCON sidecars pay a round-trip
   * per command, so they typically set this far lower (e.g. 100-500) and let the
   * remainder carry. Default {@link DEFAULT_MAX_COMMANDS}.
   */
  maxCommands?: number;
  /** Cells a previous capped call deferred - pass that call's `remainder` back here. */
  carry?: PlacedCell[];
  /** Palette/version line (validated; 1.21.x all alias to the canonical data). */
  paletteVersion?: string;
  /** Dither method. Default "bayer" - temporally stable, so deltas stay small. */
  dither?: DitherMethod;
  /** Direction the wall faces (orients its plane). Default "south" (XY plane at z=origin.z). */
  facing?: WallFacing;
}

export interface WallCommands {
  /** Literal vanilla commands (no leading slash; RCON accepts them as-is). */
  commands: string[];
  /** Cells deferred past the budget - feed back via `opts.carry` on the next call. */
  remainder: PlacedCell[];
  /** The quantized frame (solid-block palette) the commands realize - for tests/debug. */
  quantized: QuantizedFrame;
}

let _prepared: PreparedPalette | null = null;
function solidPalette(version = "1.21"): PreparedPalette {
  // the solid-block palette is one canonical table across the supported line → cache once
  if (!_prepared) _prepared = preparePalette(getSolidBlockMapPalette(version).palette);
  return _prepared;
}

function toRgb(frame: WallFrame): RgbImage {
  const { width: w, height: h, pixels: p } = frame;
  const n = w * h;
  if (p.length === n * 3) {
    return { width: w, height: h, data: new Uint8Array(p.buffer, p.byteOffset, p.length) };
  }
  if (p.length === n * 4) {
    const data = new Uint8Array(n * 3);
    for (let i = 0; i < n; i++) {
      data[i * 3] = p[i * 4]!;
      data[i * 3 + 1] = p[i * 4 + 1]!;
      data[i * 3 + 2] = p[i * 4 + 2]!;
    }
    return { width: w, height: h, data };
  }
  throw new Error(`frame pixels length ${p.length} is neither RGB (${n * 3}) nor RGBA (${n * 4}) for ${w}×${h}`);
}

const wkey = (x: number, y: number, z: number) => `${x}|${y}|${z}`;

/** Parse the box a greedyBoxes command covers (setblock = a 1×1×1 box). */
function commandBox(line: string): { x0: number; y0: number; z0: number; x1: number; y1: number; z1: number } {
  const t = line.split(/\s+/);
  if (t[0] === "setblock") {
    const [x, y, z] = [+t[1]!, +t[2]!, +t[3]!];
    return { x0: x, y0: y, z0: z, x1: x, y1: y, z1: z };
  }
  return { x0: +t[1]!, y0: +t[2]!, z0: +t[3]!, x1: +t[4]!, y1: +t[5]!, z1: +t[6]! };
}

/**
 * Turn a world-model frame into the vanilla commands that paint it as a VERTICAL wall:
 * column `c`, row `r` (image row 0 at the top) → `setblock origin.x+c origin.y+(H-1-r)
 * origin.z <block>`, with same-block runs merged into `/fill` via greedy box meshing.
 *
 * With `prevFrame` present only the cells whose quantized block changed are repainted
 * (delta); without it the full frame is a keyframe. The command count is capped at
 * `opts.maxCommands` per call - over budget, the LARGEST boxes (most pixels per command)
 * are sent this frame and the uncovered cells come back as `remainder`, which the caller
 * feeds into the next call's `opts.carry` (fresh delta cells overwrite stale carried ones
 * at the same coordinate). Carried cells stay correct because an unchanged pixel's target
 * block is the same in every later frame until a new delta covers it.
 */
export function frameToWallCommands(
  frame: WallFrame,
  origin: { x: number; y: number; z: number },
  prevFrame?: WallFrame,
  opts: WallCommandOptions = {},
): WallCommands {
  const dither = opts.dither ?? "bayer";
  const pal = solidPalette(opts.paletteVersion);
  const resolve = makeBlockResolver(opts.paletteVersion);
  const H = frame.height;
  const W = frame.width;
  const facing = opts.facing ?? "south";

  const curQ = quantizeFrame(toRgb(frame), pal, { method: dither });
  let cells: Cell[];
  if (prevFrame) {
    if (prevFrame.width !== frame.width || prevFrame.height !== frame.height) {
      throw new Error(`prevFrame ${prevFrame.width}×${prevFrame.height} != frame ${frame.width}×${frame.height}`);
    }
    const prevQ = quantizeFrame(toRgb(prevFrame), pal, { method: dither });
    cells = computeDeltas([prevQ, curQ])[1]!.cells;
  } else {
    cells = computeDeltas([curQ])[0]!.cells; // full keyframe
  }

  // image → world cells, merged with carried-over cells (fresh delta wins per coordinate)
  const pending = new Map<string, PlacedCell>();
  for (const c of opts.carry ?? []) pending.set(wkey(c.x, c.y, c.z), c);
  for (const c of cells) {
    const pos = placeCell(origin, facing, W, H, c.x, c.y);
    const p: PlacedCell = { x: pos.x, y: pos.y, z: pos.z, mapColorId: c.mapColorId };
    pending.set(wkey(p.x, p.y, p.z), p);
  }

  const lines = greedyBoxes([...pending.values()], resolve);
  const cap = Math.max(1, Math.floor(opts.maxCommands ?? DEFAULT_MAX_COMMANDS));
  if (lines.length <= cap) return { commands: lines, remainder: [], quantized: curQ };

  // over budget: send the cap-largest boxes (max pixels per command), defer the rest
  const ranked = lines
    .map((line, i) => {
      const b = commandBox(line);
      return { line, i, b, vol: (b.x1 - b.x0 + 1) * (b.y1 - b.y0 + 1) * (b.z1 - b.z0 + 1) };
    })
    .sort((a, b) => b.vol - a.vol || a.i - b.i);
  const kept = ranked.slice(0, cap).sort((a, b) => a.i - b.i); // restore deterministic order
  const remainder: PlacedCell[] = [];
  for (const d of ranked.slice(cap)) {
    for (let z = d.b.z0; z <= d.b.z1; z++)
      for (let y = d.b.y0; y <= d.b.y1; y++)
        for (let x = d.b.x0; x <= d.b.x1; x++) remainder.push(pending.get(wkey(x, y, z))!);
  }
  return { commands: kept.map((k) => k.line), remainder, quantized: curQ };
}

// ---------------------------------------------------------------------------
// 4. in-world wall setup (clear a viewing space in a RUNNING world, no datapack)
// ---------------------------------------------------------------------------

export interface WallSetupOptions {
  /**
   * Blocks of clearance carved on EACH side of the wall (perpendicular to its plane) so it's
   * visible from either approach (the wall slab itself is also cleared, since the keyframe
   * repaints it). Default 3.
   */
  clearance?: number;
  /** Block to clear the volume to. Default "minecraft:air". */
  clearBlock?: string;
  /** Direction the wall faces; the clearance is carved along its normal. Default "south" (±Z). */
  facing?: WallFacing;
}

/**
 * Vanilla `/fill … air` commands that carve a clean viewing space for the wall in a RUNNING
 * world - no datapack, no `/reload`, no leaving the world. Clears the wall slab
 * (W×H at z = origin.z) plus `clearance` blocks on each ±Z side, so a player sees the dream
 * from either approach instead of finding it buried in terrain. Oversized boxes are split at
 * the vanilla 32768-block `/fill` cap (reuses emit-commands' {@link fillLines}); a 64×64 wall
 * with the default clearance is one fill. Pure data transform - the sidecar sends these over
 * RCON once, before the first frame.
 */
export function buildSetupCommands(
  origin: { x: number; y: number; z: number },
  width: number,
  height: number,
  opts: WallSetupOptions = {},
): string[] {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new Error(`wall size must be integers ≥ 1×1 (got ${width}×${height})`);
  }
  const clearance = Math.max(0, Math.floor(opts.clearance ?? 3));
  const block = opts.clearBlock ?? "minecraft:air";
  const facing = opts.facing ?? "south";
  // east/west put the wall in the ZY plane (columns along Z), so width runs Z and clearance runs X;
  // south/north keep it in the XY plane (width along X, clearance along Z) - the original box.
  const eastWest = facing === "east" || facing === "west";
  const x0 = eastWest ? origin.x - clearance : origin.x;
  const x1 = eastWest ? origin.x + clearance : origin.x + width - 1;
  const z0 = eastWest ? origin.z : origin.z - clearance;
  const z1 = eastWest ? origin.z + width - 1 : origin.z + clearance;
  return fillLines(x0, origin.y, z0, x1, origin.y + height - 1, z1, block, "replace");
}

// ---------------------------------------------------------------------------
// 5. cast a static image / animation (NOT the world model) into a running world
// ---------------------------------------------------------------------------

export interface ImageCastOptions {
  /** Times to repeat the frame sequence; <= 0 = endless (until shouldStop). Default 1. */
  loops?: number;
  /** Frames/sec pacing between paints (0 = as fast as possible). Default 0. */
  fps?: number;
  /** Sleep hook (injectable for tests). Default setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  /** Clock hook (injectable for tests). Default Date.now. */
  now?: () => number;
  /** Cooperative stop check between frames (e.g. SIGINT). */
  shouldStop?: () => boolean;
}

/**
 * Drive `paint` over a frame sequence - the loop behind casting a user's OWN image/animation live
 * (vs the world-model stream). Pure orchestration: it owns NO sockets and decodes nothing; the caller's
 * `paint` does the frame→wall→RCON work (so the per-frame delta + budget carry are exactly the live
 * path's). A single image is a one-frame sequence (painted once); a GIF/video is N frames looped at
 * `fps`. `paint` receives the running paint index (0 = the keyframe). Returns the number of frames
 * painted. Generic over the frame type so it is unit-testable with synthetic frames + a fake paint.
 */
export async function castImageFrames<F>(
  frames: F[],
  paint: (frame: F, index: number) => Promise<void>,
  opts: ImageCastOptions = {},
): Promise<number> {
  if (frames.length === 0) throw new Error("castImageFrames: no frames to cast");
  const loops = opts.loops ?? 1;
  const endless = loops <= 0;
  const fps = Math.max(0, opts.fps ?? 0);
  const frameMs = fps > 0 ? 1000 / fps : 0;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  let painted = 0;
  for (let loop = 0; endless || loop < loops; loop++) {
    for (let i = 0; i < frames.length; i++) {
      if (opts.shouldStop?.()) return painted;
      const t = now();
      await paint(frames[i]!, painted);
      painted++;
      const isLast = !endless && loop === loops - 1 && i === frames.length - 1;
      if (frameMs > 0 && !isLast) {
        const rest = frameMs - (now() - t);
        if (rest > 0) await sleep(rest);
      }
    }
  }
  return painted;
}
