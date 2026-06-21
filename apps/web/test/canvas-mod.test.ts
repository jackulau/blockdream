import { describe, it, expect } from "vitest";
import {
  rayGroundHit,
  dragTo,
  arrangeReducer,
  initialArrangeState,
  groundToWorldOrigin,
  planDatapackPlacement,
  type ArrangeState,
  type DragSession,
} from "../src/canvas-mod";
import type { NoteEvent } from "@blockdream/audio";

describe("rayGroundHit", () => {
  it("a straight-down ray hits the ground directly below the origin", () => {
    const hit = rayGroundHit({ x: 5, y: 10, z: -3 }, { x: 0, y: -1, z: 0 }, 0);
    expect(hit).toEqual({ x: 5, z: -3 });
  });

  it("an angled ray hits where it crosses the plane", () => {
    // from (0,10,0) heading down-and-+x at 45° → crosses y=0 after 10 units of x
    const hit = rayGroundHit({ x: 0, y: 10, z: 0 }, { x: 1, y: -1, z: 0 }, 0);
    expect(hit!.x).toBeCloseTo(10, 6);
    expect(hit!.z).toBeCloseTo(0, 6);
  });

  it("respects a non-zero ground plane", () => {
    const hit = rayGroundHit({ x: 0, y: 10, z: 0 }, { x: 0, y: -1, z: 2 }, 4);
    // travels 6 down to reach y=4 → z advances 2*6 = 12
    expect(hit!.z).toBeCloseTo(12, 6);
  });

  it("returns null for a ray parallel to the ground", () => {
    expect(rayGroundHit({ x: 0, y: 5, z: 0 }, { x: 1, y: 0, z: 0 }, 0)).toBeNull();
  });

  it("returns null when the plane is behind the ray (pointing away)", () => {
    // origin above the plane, ray pointing UP → never reaches y=0
    expect(rayGroundHit({ x: 0, y: 5, z: 0 }, { x: 0, y: 1, z: 0 }, 0)).toBeNull();
  });
});

describe("dragTo", () => {
  it("keeps the grabbed point under the cursor (object follows the pointer delta)", () => {
    const session: DragSession = { id: "music", grab: { x: 2, z: 2 }, origin: { x: 10, z: 10 } };
    // cursor moved +3 in x, -1 in z → object moves the same
    expect(dragTo(session, { x: 5, z: 1 })).toEqual({ x: 13, z: 9 });
  });

  it("no pointer movement leaves the object where it was", () => {
    const session: DragSession = { id: "build", grab: { x: 7, z: -4 }, origin: { x: 0, z: 0 } };
    expect(dragTo(session, { x: 7, z: -4 })).toEqual({ x: 0, z: 0 });
  });
});

describe("arrangeReducer", () => {
  const base = (): ArrangeState => initialArrangeState(8);

  it("initial state: build at origin, music offset, shown, arrange off", () => {
    const s = base();
    expect(s.enabled).toBe(false);
    expect(s.selected).toBe("build");
    expect(s.positions.build).toEqual({ x: 0, z: 0 });
    expect(s.positions.music).toEqual({ x: 8, z: 0 });
    expect(s.showMusic).toBe(true);
  });

  it("setEnabled / select / move update only their slice", () => {
    let s = base();
    s = arrangeReducer(s, { type: "setEnabled", enabled: true });
    expect(s.enabled).toBe(true);
    s = arrangeReducer(s, { type: "select", id: "music" });
    expect(s.selected).toBe("music");
    s = arrangeReducer(s, { type: "move", id: "music", to: { x: 20, z: -5 } });
    expect(s.positions.music).toEqual({ x: 20, z: -5 });
    expect(s.positions.build).toEqual({ x: 0, z: 0 }); // untouched
  });

  it("toggleMusic flips, setShowMusic sets", () => {
    let s = base();
    s = arrangeReducer(s, { type: "toggleMusic" });
    expect(s.showMusic).toBe(false);
    s = arrangeReducer(s, { type: "toggleMusic" });
    expect(s.showMusic).toBe(true);
    s = arrangeReducer(s, { type: "setShowMusic", show: false });
    expect(s.showMusic).toBe(false);
  });

  it("reset returns a fresh state", () => {
    let s = base();
    s = arrangeReducer(s, { type: "move", id: "build", to: { x: 99, z: 99 } });
    s = arrangeReducer(s, { type: "toggleMusic" });
    s = arrangeReducer(s, { type: "reset", musicOffsetX: 4 });
    expect(s.positions.build).toEqual({ x: 0, z: 0 });
    expect(s.positions.music).toEqual({ x: 4, z: 0 });
    expect(s.showMusic).toBe(true);
  });

  it("never mutates the input state", () => {
    const s = base();
    const frozen = JSON.stringify(s);
    arrangeReducer(s, { type: "move", id: "build", to: { x: 1, z: 1 } });
    arrangeReducer(s, { type: "toggleMusic" });
    expect(JSON.stringify(s)).toBe(frozen);
  });
});

describe("groundToWorldOrigin", () => {
  it("rounds the dragged ground position to whole blocks and offsets by the base origin", () => {
    expect(groundToWorldOrigin({ x: 3.4, z: -2.6 }, { x: 0, y: 64, z: 0 })).toEqual({ x: 3, y: 64, z: -3 });
    expect(groundToWorldOrigin({ x: 10.5, z: 10.5 }, { x: -50, y: 70, z: -50 })).toEqual({ x: -39, y: 70, z: -39 });
  });
});

describe("planDatapackPlacement", () => {
  const NOTES: NoteEvent[] = [{ tick: 0, note: 12, instrument: "harp", velocity: 0.8 }];

  it("centers the build: origin = dragged center minus the half-extent (WYSIWYG)", () => {
    const s = arrangeReducer(initialArrangeState(0), { type: "move", id: "build", to: { x: 20, z: 10 } });
    const p = planDatapackPlacement([], s, { x: 0, y: 64, z: 0 }, { buildHalf: { x: 8, z: 8 } });
    expect(p.origin).toEqual({ x: 12, y: 64, z: 2 });
    expect(p.music).toBeUndefined();
  });

  it("centers the note-block row at its dragged position and includes notes when toggled on", () => {
    const s = arrangeReducer(initialArrangeState(0), { type: "move", id: "music", to: { x: 30, z: -7 } });
    const p = planDatapackPlacement(NOTES, s, { x: 0, y: 64, z: 0 }, { musicHalf: { x: 2, z: 0 } });
    expect(p.musicOrigin).toEqual({ x: 28, y: 64, z: -7 });
    expect(p.music).toHaveLength(1);
  });

  it("no extents ⇒ origin is the raw dragged position (back-compatible default)", () => {
    const s = arrangeReducer(initialArrangeState(0), { type: "move", id: "build", to: { x: 5, z: 6 } });
    expect(planDatapackPlacement([], s, { x: 0, y: 64, z: 0 }).origin).toEqual({ x: 5, y: 64, z: 6 });
  });

  it("toggle off ⇒ no music fields regardless of notes", () => {
    const s = arrangeReducer(initialArrangeState(0), { type: "setShowMusic", show: false });
    const p = planDatapackPlacement(NOTES, s, { x: 0, y: 64, z: 0 }, { musicHalf: { x: 2, z: 0 } });
    expect(p.music).toBeUndefined();
    expect(p.musicOrigin).toBeUndefined();
  });
});
