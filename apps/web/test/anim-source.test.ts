import { describe, it, expect } from "vitest";
import { animSourceFor, isTransformAnim, type AnimSourceState } from "../src/anim-source";
import type { VoxelVolume } from "@blockdream/voxel";

// tiny distinct volumes: identity (===) is what the decision hands back, so a unique data
// payload per volume makes "which content was chosen" assertions unambiguous.
const vol = (tag: number): VoxelVolume => ({ sx: 1, sy: 1, sz: 1, data: new Uint8Array([tag]) });

const state = (over: Partial<AnimSourceState> = {}): AnimSourceState => ({
  flatVolFrames: null,
  importedFrames: null,
  baseVolume: null,
  seqFromBase: false,
  current3d: [],
  ...over,
});

describe("isTransformAnim", () => {
  it("classifies the live transforms (including none) as transforms", () => {
    for (const s of ["spin", "bob", "rock", "tumble", "pulse", "orbit", "none"]) expect(isTransformAnim(s)).toBe(true);
  });
  it("classifies the block-motion sequences as NOT transforms", () => {
    for (const s of ["explode", "wave", "buildup"]) expect(isTransformAnim(s)).toBe(false);
  });
});

describe("animSourceFor: model import then a sequence anim (the stale-baseVolume bug)", () => {
  it("uses the IMPORTED frames, not the previously built solid still in baseVolume", () => {
    const stale = vol(1); // the solid built BEFORE the import (or the page-load sample)
    const imported = [vol(2)]; // a single .obj model import
    const s = state({ importedFrames: imported, baseVolume: stale, current3d: imported });
    const d = animSourceFor("explode", s);
    expect(d.kind).toBe("import-sequence");
    if (d.kind === "import-sequence") {
      expect(d.frames).toBe(imported); // the import, by identity
      expect(d.frames[0]).not.toBe(stale); // and NOT the stale solid
    }
  });

  it("uses the imported clip for a MULTI-frame model import (glb/glTF/obj-seq)", () => {
    const stale = vol(1);
    const imported = [vol(2), vol(3), vol(4)];
    const d = animSourceFor("wave", state({ importedFrames: imported, baseVolume: stale, current3d: imported }));
    expect(d).toEqual({ kind: "import-sequence", frames: imported });
  });

  it("re-picking another effect after one is showing starts from the PLAIN import again", () => {
    const imported = [vol(2)];
    const effected = [vol(9), vol(10)]; // current3d = the explode-over-import frames
    const d = animSourceFor("buildup", state({ importedFrames: imported, baseVolume: vol(1), current3d: effected }));
    expect(d).toEqual({ kind: "import-sequence", frames: imported });
  });

  it("never falls back to base-sequence while a model import is active", () => {
    const s = state({ importedFrames: [vol(2)], baseVolume: vol(1), current3d: [vol(2)] });
    for (const sel of ["explode", "wave", "buildup"]) {
      expect(animSourceFor(sel, s).kind).toBe("import-sequence");
    }
  });
});

describe("animSourceFor: still-image build then a sequence anim (previously-correct path)", () => {
  it("uses baseVolume when no import is active", () => {
    const base = vol(1);
    const d = animSourceFor("explode", state({ baseVolume: base, current3d: [base] }));
    expect(d).toEqual({ kind: "base-sequence", volume: base });
  });

  it("a base-GENERATED sequence re-sequences from baseVolume (seqFromBase set)", () => {
    const base = vol(1);
    const d = animSourceFor("wave", state({ baseVolume: base, seqFromBase: true, current3d: [vol(5), vol(6)] }));
    expect(d).toEqual({ kind: "base-sequence", volume: base });
  });

  it("with nothing loaded at all there is no source", () => {
    expect(animSourceFor("explode", state())).toEqual({ kind: "none" });
  });
});

describe("animSourceFor: spin (and the other live transforms) behave as before", () => {
  it("spin on a built solid applies live, no rebuild", () => {
    const base = vol(1);
    const d = animSourceFor("spin", state({ baseVolume: base, current3d: [base] }));
    expect(d).toEqual({ kind: "shown-transform", revertToBase: false });
  });

  it("spin after a base-generated sequence reverts to the solid first", () => {
    const base = vol(1);
    const d = animSourceFor("spin", state({ baseVolume: base, seqFromBase: true, current3d: [vol(5), vol(6)] }));
    expect(d).toEqual({ kind: "shown-transform", revertToBase: true });
  });

  it("spin on a model import rides the import live (no rebuild, import left intact)", () => {
    const imported = [vol(2), vol(3)];
    const d = animSourceFor("spin", state({ importedFrames: imported, baseVolume: vol(1), current3d: imported }));
    expect(d).toEqual({ kind: "shown-transform", revertToBase: false });
  });

  it("spin on a flat clip rides the clip; no restore needed when the plain clip is showing", () => {
    const clip = [vol(2), vol(3)];
    const d = animSourceFor("spin", state({ flatVolFrames: clip, current3d: clip }));
    expect(d).toEqual({ kind: "clip-transform", frames: clip, restore: false });
  });

  it("spin on a flat clip restores the plain clip when an effect had replaced it", () => {
    const clip = [vol(2), vol(3)];
    const effected = [vol(9)];
    const d = animSourceFor("spin", state({ flatVolFrames: clip, current3d: effected }));
    expect(d).toEqual({ kind: "clip-transform", frames: clip, restore: true });
  });
});

describe("animSourceFor: flat clip sequence path unchanged", () => {
  it("a sequence anim on a flat clip generates OVER the plain clip frames", () => {
    const clip = [vol(2), vol(3)];
    const d = animSourceFor("wave", state({ flatVolFrames: clip, baseVolume: vol(1), current3d: clip }));
    expect(d).toEqual({ kind: "clip-sequence", frames: clip });
  });

  it("the flat clip wins over baseVolume AND importedFrames for any selection", () => {
    const clip = [vol(2)];
    const s = state({ flatVolFrames: clip, importedFrames: [vol(3)], baseVolume: vol(1), current3d: clip });
    expect(animSourceFor("explode", s)).toEqual({ kind: "clip-sequence", frames: clip });
    expect(animSourceFor("none", s)).toEqual({ kind: "clip-transform", frames: clip, restore: false });
  });
});
