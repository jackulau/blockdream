// Headless simulation of the LIVE in-Minecraft world-model control loop. This is the
// in-repo proof of the bridge the Fabric mod implements (mods/java-fabric/WorldModelClient
// + InputCapture): a player's server-observed movement → a VPT-style action → the world-model
// server → an RGB frame → nearest-map-colour tiles → each map's 16384-byte colors array.
//
// No JVM / Minecraft client / sockets needed: the data transforms and the message protocol
// ARE the contract between mod and server, and they are exercised here end-to-end. The mod
// is the same pipeline realized against a live client + ws://127.0.0.1:8765.

import { getJavaMapPalette } from "@blockdream/palette";
import { preparePalette, quantizeFrame, type RgbImage, type PreparedPalette } from "@blockdream/color-core";
import { splitIntoMaps, toMapColors, MAP_DIM } from "@blockdream/emit-java";

// VPT-style button order (matches apps/web/src/action.ts; indices 6-8 are server-derivable extras)
export const BTN = {
  forward: 0, back: 1, left: 2, right: 3, jump: 4, sneak: 5, sprint: 6, attack: 7, use: 8,
} as const;
export const N_BUTTONS = 9;

/** A player's pose as the SERVER observes it each tick (no client mod required). */
export interface Pose {
  x: number;
  z: number;
  yaw: number; // degrees, MC convention (0 = +Z / south)
  pitch: number; // degrees
  onGround: boolean;
  sprinting: boolean;
  sneaking: boolean;
}

export interface Action {
  type: "action";
  buttons: number[];
  camera: [number, number];
  skill?: string;
}

const DEG2RAD = Math.PI / 180;
const MOVE_EPS = 0.02; // m/tick below which we treat the player as stationary
const CAMERA_DEG = 12; // look-delta degrees mapped to camera magnitude 1.0

function wrapDeg(d: number): number {
  let x = ((d + 180) % 360 + 360) % 360 - 180;
  if (x === -180) x = 180;
  return x;
}

/**
 * Derive a world-model action from two consecutive server-observed poses. This is exactly
 * what InputCapture.java does on the server thread — so a player joins with a STOCK vanilla
 * client and simply walks/looks to drive the model. No keyboard hook, no client mixin.
 */
export function deriveAction(prev: Pose, cur: Pose, skill?: string): Action {
  const b = new Array(N_BUTTONS).fill(0);

  // movement delta projected into the player's facing frame
  const dx = cur.x - prev.x;
  const dz = cur.z - prev.z;
  const yaw = cur.yaw * DEG2RAD;
  const fwd = -Math.sin(yaw); // MC forward unit (x)
  const fwz = Math.cos(yaw); //  (z)
  const forward = dx * fwd + dz * fwz; // + = moving the way you face
  const strafe = dx * fwz - dz * fwd; // + = moving to your right
  if (forward > MOVE_EPS) b[BTN.forward] = 1;
  else if (forward < -MOVE_EPS) b[BTN.back] = 1;
  if (strafe > MOVE_EPS) b[BTN.right] = 1;
  else if (strafe < -MOVE_EPS) b[BTN.left] = 1;

  if (!cur.onGround && cur.onGround !== prev.onGround) b[BTN.jump] = 1; // just left the ground
  if (cur.sneaking) b[BTN.sneak] = 1;
  if (cur.sprinting) b[BTN.sprint] = 1;

  // look delta → camera in [-1, 1]
  const cx = Math.max(-1, Math.min(1, wrapDeg(cur.yaw - prev.yaw) / CAMERA_DEG));
  const cy = Math.max(-1, Math.min(1, (cur.pitch - prev.pitch) / CAMERA_DEG));

  return { type: "action", buttons: b, camera: [cx, cy], ...(skill ? { skill } : {}) };
}

/** Lazily-prepared Java map palette (shared by the frame→tiles transform). */
let _pal: PreparedPalette | null = null;
function mapPalette(version = "1.21.9"): PreparedPalette {
  if (!_pal) _pal = preparePalette(getJavaMapPalette(version));
  return _pal;
}

export interface MapTileColors {
  col: number;
  row: number;
  colors: Uint8Array; // 16384 signed-safe map-colour bytes (what MapState.colors receives)
}

/**
 * RGB world-model frame → per-tile 16384-byte map-colour arrays. This is the transform
 * WorldModelClient.java runs after ImageIO-decoding the server's PNG: quantize to the Java
 * map palette, split into 128×128 tiles, emit each tile's colour bytes. Frame dims must be
 * multiples of 128 (the wall is cols×rows maps).
 */
export function frameToMapTiles(rgb: RgbImage): MapTileColors[] {
  if (rgb.width % MAP_DIM !== 0 || rgb.height % MAP_DIM !== 0) {
    throw new Error(`frame ${rgb.width}×${rgb.height} must be a multiple of ${MAP_DIM} (wall is N×M maps)`);
  }
  const q = quantizeFrame(rgb, mapPalette(), { method: "floyd-steinberg" });
  return splitIntoMaps(q).map((t) => ({ col: t.col, row: t.row, colors: toMapColors(t.frame) }));
}

/** Build the JSON message a client sends for an action (matches serve.py's schema). */
export function actionMessage(a: Action): string {
  return JSON.stringify(a);
}

/**
 * A deterministic stand-in for the neural world-model server. Recursively shifts a
 * synthetic scene by the action so the test can prove input is carried through the loop
 * (forward brightens/zooms, camera-x pans). The real server returns model-generated frames;
 * the loop wiring is identical.
 */
export function mockWorldModel(prev: RgbImage | null, action: Action, size = MAP_DIM): RgbImage {
  const w = size, h = size;
  const data = new Uint8Array(w * h * 3);
  const fwd = action.buttons[BTN.forward]! - action.buttons[BTN.back]!;
  const panX = action.camera[0];
  const horizon = Math.floor(h * (0.5 - 0.15 * fwd)); // forward raises the horizon
  const sun = Math.floor(((panX + 1) / 2) * (w - 1)); // camera-x moves the "sun"
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 3;
      const sky = y < horizon;
      const distToSun = Math.abs(x - sun);
      if (sky) {
        data[o] = Math.max(40, 120 - distToSun);
        data[o + 1] = Math.max(120, 200 - distToSun);
        data[o + 2] = 235;
      } else {
        data[o] = 60 + ((x * 7) % 40);
        data[o + 1] = 120 + ((y * 5) % 40);
        data[o + 2] = 40;
      }
    }
  }
  return { width: w, height: h, data };
}

export interface BridgeStep {
  action: Action;
  message: string;
  tiles: MapTileColors[];
}

/**
 * Drive the full loop over a sequence of server-observed poses: derive action → encode
 * message → world-model → frame → map tiles. Returns one step per pose transition.
 */
export function runControlLoop(poses: Pose[], opts: { skill?: string; size?: number } = {}): BridgeStep[] {
  const size = opts.size ?? MAP_DIM;
  const out: BridgeStep[] = [];
  let frame: RgbImage | null = null;
  for (let i = 1; i < poses.length; i++) {
    const action = deriveAction(poses[i - 1]!, poses[i]!, opts.skill);
    frame = mockWorldModel(frame, action, size);
    out.push({ action, message: actionMessage(action), tiles: frameToMapTiles(frame) });
  }
  return out;
}
