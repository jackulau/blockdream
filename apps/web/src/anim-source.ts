// Pure, DOM-free decision logic for the builder's animation selector: given what is currently
// loaded (a flat GIF/video clip, an imported 3D model, a built solid, a generated sequence),
// decide WHICH volume/frames the chosen animation must use. All the source-selection rules live
// here so they are unit-testable without a browser (like canvas-mod.ts); showcase.ts only
// executes the returned decision. This is the fix for "picking explode/wave/buildup after
// importing a model animated the PREVIOUSLY built solid (the stale baseVolume) and silently
// discarded the import".

import { TRANSFORM_ANIMS, type VoxelVolume } from "@blockdream/voxel";

/** Live transform anims (spin/bob/rock/tumble/pulse/orbit/none) apply instantly to whatever is
 *  shown; anything else is a block-motion SEQUENCE anim (explode/wave/buildup) that must
 *  generate frames from a source. */
export const isTransformAnim = (s: string): boolean => (TRANSFORM_ANIMS as readonly string[]).includes(s);

/** The builder state the animation selector decides over (all owned by showcase.ts). */
export interface AnimSourceState {
  /** plain flat frames of an active GIF/video import; null when no flat clip is active */
  flatVolFrames: VoxelVolume[] | null;
  /** plain frames of an active MODEL import (glb/glTF/obj-seq/single obj); null otherwise */
  importedFrames: VoxelVolume[] | null;
  /** the single built solid (the page-load sample or the last "build 3D from image") */
  baseVolume: VoxelVolume | null;
  /** current3d is a sequence GENERATED from baseVolume (reverts cleanly to the solid) */
  seqFromBase: boolean;
  /** the frames currently shown by the viewer */
  current3d: VoxelVolume[];
}

/** What the animation selector must do, and with WHICH content. */
export type AnimSourceDecision =
  /** transform rides live on the active flat clip; restore = a block-motion effect had replaced
   *  the plain clip, so re-show `frames` (the plain clip) first */
  | { kind: "clip-transform"; frames: VoxelVolume[]; restore: boolean }
  /** block-motion effect generated OVER the playing flat clip's plain frames */
  | { kind: "clip-sequence"; frames: VoxelVolume[] }
  /** transform applies live to whatever is shown; revertToBase = a base-generated sequence is
   *  up, so rebuild the single solid first (imports are left intact) */
  | { kind: "shown-transform"; revertToBase: boolean }
  /** block-motion effect generated OVER the imported model's plain frames - NOT the stale
   *  baseVolume, which still points at the previously built solid */
  | { kind: "import-sequence"; frames: VoxelVolume[] }
  /** block-motion effect generated from the built solid */
  | { kind: "base-sequence"; volume: VoxelVolume }
  /** nothing usable to animate */
  | { kind: "none" };

/**
 * Decide the source for the chosen animation. Priority for sequence anims: the active flat clip,
 * else the active model import, else the built solid. The import beats baseVolume because after
 * an import, baseVolume still points at whatever solid was built BEFORE it (or the page-load
 * sample) - falling back to it would animate the wrong content and silently discard the import.
 */
export function animSourceFor(selection: string, s: AnimSourceState): AnimSourceDecision {
  const transform = isTransformAnim(selection);
  if (s.flatVolFrames) {
    if (transform) return { kind: "clip-transform", frames: s.flatVolFrames, restore: s.current3d !== s.flatVolFrames };
    if (s.flatVolFrames.length) return { kind: "clip-sequence", frames: s.flatVolFrames };
    return { kind: "none" };
  }
  if (transform) return { kind: "shown-transform", revertToBase: s.seqFromBase };
  if (s.importedFrames && s.importedFrames.length) return { kind: "import-sequence", frames: s.importedFrames };
  if (s.baseVolume) return { kind: "base-sequence", volume: s.baseVolume };
  return { kind: "none" };
}

/**
 * The volume a baked-spin EXPORT must turntable. exportFrames bakes spinSequence(volume) when a
 * single still volume is shown with "spin" selected - and that volume must follow the SAME source
 * preference as animSourceFor: the active flat clip, else the active model import, else the built
 * solid. Without this, an export after a model import baked a turntable of the STALE baseVolume
 * (the solid built BEFORE the import) - the export twin of the selector bug fixed above.
 */
export function spinExportVolume(
  s: Pick<AnimSourceState, "flatVolFrames" | "importedFrames" | "baseVolume">,
): VoxelVolume | null {
  if (s.flatVolFrames && s.flatVolFrames.length) return s.flatVolFrames[0]!;
  if (s.importedFrames && s.importedFrames.length) return s.importedFrames[0]!;
  return s.baseVolume;
}
