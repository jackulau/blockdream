// Animation toolkit for the 3D viewer. Two kinds:
//   1. TRANSFORM animations — a pure (time → {position, rotation, scale}) function applied to the
//      whole object every frame. Cheap + perfectly smooth (no baked geometry), refresh-rate
//      independent because the pose is an ABSOLUTE function of elapsed seconds, not an accumulator.
//      These replace the old single hard-coded turntable: spin, bob, rock, tumble, pulse, orbit.
//   2. VOLUME-SEQUENCE generators — produce a list of VoxelVolume frames where the CONTENT moves
//      (explode⇄assemble, travelling wave, build-up). These play back through the frame scheduler
//      and also export straight to an animated datapack.
// All pure + deterministic → unit-testable, and the easing curves are shared by both.

import { createVolume, forEachSolid, setVoxel, type VoxelVolume } from "./volume";

// ---- easing curves (t in [0,1] → eased [0,1]) ---------------------------------------------------
export type Easing = (t: number) => number;
export const easing: Record<string, Easing> = {
  linear: (t) => t,
  easeInOutSine: (t) => -(Math.cos(Math.PI * t) - 1) / 2,
  easeInOutQuad: (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2),
  easeOutCubic: (t) => 1 - (1 - t) ** 3,
  easeOutBack: (t) => 1 + 2.70158 * (t - 1) ** 3 + 1.70158 * (t - 1) ** 2,
  easeOutBounce: (t) => {
    const n1 = 7.5625;
    const d1 = 2.75;
    if (t < 1 / d1) return n1 * t * t;
    if (t < 2 / d1) return n1 * (t -= 1.5 / d1) * t + 0.75;
    if (t < 2.5 / d1) return n1 * (t -= 2.25 / d1) * t + 0.9375;
    return n1 * (t -= 2.625 / d1) * t + 0.984375;
  },
};

/** A ping-pong triangle wave: 0→1→0 over period (default 1). Used to drive looping motions. */
export const pingPong = (t: number, period = 1): number => {
  const x = ((t % period) + period) % period / period;
  return x < 0.5 ? x * 2 : 2 - x * 2;
};

// ---- transform animations -----------------------------------------------------------------------
export interface Transform {
  px: number;
  py: number;
  pz: number;
  rx: number;
  ry: number;
  rz: number;
  scale: number;
}
const IDENTITY: Transform = { px: 0, py: 0, pz: 0, rx: 0, ry: 0, rz: 0, scale: 1 };
/** (elapsedSeconds, objectSize) → pose. objectSize scales translation-based motions to the model. */
export type TransformAnim = (tSec: number, size: number) => Transform;

export const TRANSFORM_ANIMS = ["spin", "bob", "rock", "tumble", "pulse", "orbit", "none"] as const;
export type TransformAnimName = (typeof TRANSFORM_ANIMS)[number];

export const transformAnims: Record<TransformAnimName, TransformAnim> = {
  none: () => ({ ...IDENTITY }),
  // steady turntable
  spin: (t) => ({ ...IDENTITY, ry: 0.6 * t }),
  // turntable + vertical sine bob (eased so the top/bottom hang a beat)
  bob: (t, size) => ({ ...IDENTITY, ry: 0.4 * t, py: (easing.easeInOutSine!(pingPong(t, 1.6)) - 0.5) * size * 0.18 }),
  // pendulum rock about Z + slow turn
  rock: (t) => ({ ...IDENTITY, ry: 0.2 * t, rz: Math.sin(t * 1.5) * 0.28 }),
  // free tumble on two axes
  tumble: (t) => ({ ...IDENTITY, rx: 0.5 * t, ry: 0.7 * t }),
  // breathe: turntable + eased scale pulse
  pulse: (t) => ({ ...IDENTITY, ry: 0.4 * t, scale: 1 + (easing.easeInOutSine!(pingPong(t, 1.4)) - 0.5) * 0.24 }),
  // object travels a small circle while spinning
  orbit: (t, size) => ({ ...IDENTITY, ry: 0.4 * t, px: Math.cos(t) * size * 0.3, pz: Math.sin(t) * size * 0.3 }),
};

/** Evaluate a named transform animation at a time. Falls back to identity for unknown names. */
export function poseAt(name: string, tSec: number, size: number): Transform {
  return (transformAnims[name as TransformAnimName] ?? transformAnims.none)(tSec, size);
}

/** Interpolate a custom keyframe track (times must be ascending) with an easing curve. Lets callers
 *  script bespoke intros/outros (pop-in, settle) beyond the built-ins. */
export function sampleKeyframes(keys: Array<{ t: number; pose: Partial<Transform> }>, tSec: number, ease: Easing = easing.linear!): Transform {
  if (keys.length === 0) return { ...IDENTITY };
  if (tSec <= keys[0]!.t) return { ...IDENTITY, ...keys[0]!.pose };
  const last = keys[keys.length - 1]!;
  if (tSec >= last.t) return { ...IDENTITY, ...last.pose };
  let i = 0;
  while (i < keys.length - 1 && keys[i + 1]!.t <= tSec) i++;
  const a = keys[i]!;
  const b = keys[i + 1]!;
  const f = ease((tSec - a.t) / (b.t - a.t || 1));
  const lerp = (k: keyof Transform): number => {
    const av = (a.pose[k] ?? IDENTITY[k]) as number;
    const bv = (b.pose[k] ?? IDENTITY[k]) as number;
    return av + (bv - av) * f;
  };
  return { px: lerp("px"), py: lerp("py"), pz: lerp("pz"), rx: lerp("rx"), ry: lerp("ry"), rz: lerp("rz"), scale: lerp("scale") };
}

// ---- volume-sequence generators -----------------------------------------------------------------

/** Translate every solid voxel by (dx,dy,dz) into a fresh volume of the given padded size. */
function shifted(v: VoxelVolume, sx: number, sy: number, sz: number, off: (x: number, y: number, z: number) => [number, number, number]): VoxelVolume {
  const out = createVolume(sx, sy, sz);
  forEachSolid(v, (x, y, z, c) => {
    const [nx, ny, nz] = off(x, y, z);
    setVoxel(out, Math.round(nx), Math.round(ny), Math.round(nz), c);
  });
  return out;
}

/** Explode⇄assemble loop: voxels fly out from the centroid then come back together. The middle
 *  frame is fully assembled; the ends are fully exploded, so playback loops seamlessly. */
export function explodeAssemble(v: VoxelVolume, frames = 24, spread = 6): VoxelVolume[] {
  const pad = Math.ceil(spread) + 1;
  const sx = v.sx + pad * 2;
  const sy = v.sy + pad * 2;
  const sz = v.sz + pad * 2;
  const cx = (v.sx - 1) / 2;
  const cy = (v.sy - 1) / 2;
  const cz = (v.sz - 1) / 2;
  const out: VoxelVolume[] = [];
  for (let f = 0; f < frames; f++) {
    const s = easing.easeInOutSine!(1 - pingPong(f / frames, 1)) * spread; // spread at ends, 0 (assembled) at mid
    out.push(
      shifted(v, sx, sy, sz, (x, y, z) => {
        const dx = x - cx;
        const dy = y - cy;
        const dz = z - cz;
        const len = Math.hypot(dx, dy, dz) || 1;
        return [pad + x + (dx / len) * s, pad + y + (dy / len) * s, pad + z + (dz / len) * s];
      }),
    );
  }
  return out;
}

/** Travelling vertical wave: each column is displaced in +Y by a sine that moves along X over time. */
export function wave(v: VoxelVolume, frames = 24, amp = 3, wavelength = 0): VoxelVolume[] {
  const a = Math.max(1, Math.round(amp));
  const wl = wavelength > 0 ? wavelength : Math.max(4, v.sx / 2);
  const sy = v.sy + a * 2;
  const out: VoxelVolume[] = [];
  for (let f = 0; f < frames; f++) {
    const phase = (f / frames) * Math.PI * 2;
    out.push(
      shifted(v, v.sx, sy, v.sz, (x, y, z) => [x, y + a + Math.round(Math.sin((x / wl) * Math.PI * 2 - phase) * a), z]),
    );
  }
  return out;
}

/** Build-up: reveal the model bottom-to-top over the frames (an assemble/dissolve-in). */
export function buildUp(v: VoxelVolume, frames = 24, ease: Easing = easing.easeOutCubic!): VoxelVolume[] {
  const out: VoxelVolume[] = [];
  for (let f = 0; f < frames; f++) {
    const thresh = ease((f + 1) / frames) * v.sy;
    const out_v = createVolume(v.sx, v.sy, v.sz);
    forEachSolid(v, (x, y, z, c) => {
      if (y <= thresh) setVoxel(out_v, x, y, z, c);
    });
    out.push(out_v);
  }
  return out;
}

/** Names of the volume-sequence generators, for UI menus. */
export const SEQUENCE_ANIMS = ["explode", "wave", "buildup"] as const;
export type SequenceAnimName = (typeof SEQUENCE_ANIMS)[number];

/** Dispatch a sequence generator by name. */
export function generateSequence(name: SequenceAnimName, v: VoxelVolume, frames = 24): VoxelVolume[] {
  if (name === "explode") return explodeAssemble(v, frames);
  if (name === "wave") return wave(v, frames);
  return buildUp(v, frames);
}
