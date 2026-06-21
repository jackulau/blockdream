// Pure, DOM-free math + state for the builder's "Arrange" canvas mod. The 3D build (the animation)
// and the note-block "music area" are two independently positionable scene objects on the ground
// plane, plus a toggle that includes/excludes the note blocks. The three.js wiring (viewer3d.ts)
// calls these helpers; ALL the projection + reducer logic lives here so it is unit-testable without
// a WebGL context (the viewer itself can't run in node/jsdom).

import type { NoteEvent } from "@blockdream/audio";

export type SceneObjectId = "build" | "music";

/** A point on the ground plane (world XZ). Y is fixed per object, so arranging is a 2D problem. */
export interface GroundVec {
  x: number;
  z: number;
}

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/**
 * Ray ↔ ground-plane (y = planeY) intersection. Returns the world XZ hit, or null when the ray is
 * parallel to the plane or points away from it (the plane is behind the ray). `dir` need not be
 * normalized. This is how a screen-space pointer becomes a ground position for dragging.
 */
export function rayGroundHit(origin: Vec3, dir: Vec3, planeY = 0): GroundVec | null {
  if (Math.abs(dir.y) < 1e-9) return null; // parallel to the ground plane
  const t = (planeY - origin.y) / dir.y;
  if (t < 0) return null; // plane is behind the ray origin
  return { x: origin.x + t * dir.x, z: origin.z + t * dir.z };
}

/** An in-progress drag: the ground point first grabbed and the object's position at grab time. */
export interface DragSession {
  id: SceneObjectId;
  grab: GroundVec;
  origin: GroundVec; // the object's position when the drag began
}

/**
 * The object's new position for the current pointer ground-point: translate it by exactly the
 * pointer's ground-plane movement since grab, so the grabbed point stays under the cursor.
 */
export function dragTo(session: DragSession, current: GroundVec): GroundVec {
  return {
    x: session.origin.x + (current.x - session.grab.x),
    z: session.origin.z + (current.z - session.grab.z),
  };
}

export interface ArrangeState {
  /** Arrange mode active (an object drag suspends OrbitControls; off = normal orbit/inspect). */
  enabled: boolean;
  /** Which object a drag selects/moves by default. */
  selected: SceneObjectId;
  positions: Record<SceneObjectId, GroundVec>;
  /** Note blocks (the music area) included + visible. */
  showMusic: boolean;
}

export function initialArrangeState(musicOffsetX = 0): ArrangeState {
  return {
    enabled: false,
    selected: "build",
    positions: { build: { x: 0, z: 0 }, music: { x: musicOffsetX, z: 0 } },
    showMusic: true,
  };
}

export type ArrangeAction =
  | { type: "setEnabled"; enabled: boolean }
  | { type: "select"; id: SceneObjectId }
  | { type: "move"; id: SceneObjectId; to: GroundVec }
  | { type: "setShowMusic"; show: boolean }
  | { type: "toggleMusic" }
  | { type: "reset"; musicOffsetX?: number };

/** Pure reducer over the arrange state. Never mutates its input. */
export function arrangeReducer(state: ArrangeState, action: ArrangeAction): ArrangeState {
  switch (action.type) {
    case "setEnabled":
      return { ...state, enabled: action.enabled };
    case "select":
      return { ...state, selected: action.id };
    case "move":
      return { ...state, positions: { ...state.positions, [action.id]: { ...action.to } } };
    case "setShowMusic":
      return { ...state, showMusic: action.show };
    case "toggleMusic":
      return { ...state, showMusic: !state.showMusic };
    case "reset":
      return initialArrangeState(action.musicOffsetX ?? 0);
    default:
      return state;
  }
}

/**
 * Round a ground position to whole blocks and add a world origin → the in-world coordinates a
 * dragged object maps to. Used to turn the on-screen arrangement into datapack origins (build origin
 * = build position, music origin = music-area position) so the export matches what the user sees.
 */
export function groundToWorldOrigin(pos: GroundVec, base: Vec3): Vec3 {
  return { x: base.x + Math.round(pos.x), y: base.y, z: base.z + Math.round(pos.z) };
}

/** generateVoxelDatapack placement opts derived from the on-screen arrangement. */
export interface DatapackPlacement {
  origin: Vec3; // build (animation) origin
  music?: NoteEvent[]; // note timeline — present only when included
  musicOrigin?: Vec3; // music-area origin — present only when included
}

/**
 * Turn the on-screen arrangement + analyzed notes into datapack placement opts: the build origin =
 * the animation's dragged position, and — ONLY when notes exist AND the note-block toggle is on — the
 * note timeline placed at the music area's dragged position. Toggle off or no notes ⇒ no music fields
 * at all, so the export is byte-identical to a music-less build (the additive contract from D3).
 */
export function planDatapackPlacement(
  notes: ReadonlyArray<NoteEvent>,
  state: ArrangeState,
  base: Vec3,
): DatapackPlacement {
  const origin = groundToWorldOrigin(state.positions.build, base);
  if (notes.length === 0 || !state.showMusic) return { origin };
  return {
    origin,
    music: notes.slice(),
    musicOrigin: groundToWorldOrigin(state.positions.music, base),
  };
}
