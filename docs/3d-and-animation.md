# 3D builds & animation

How an image becomes a real 3D Minecraft build, how the blocks are meshed, and the animation
system. Code lives in `packages/voxel` (engine) + `apps/web/src` (viewer).

## Image → 3D

`packages/voxel/src/depth.ts` → `imageToSolid(frame, opts)`.

The old approach (`relief` mode in `voxelize.ts`) faked depth from pixel **brightness** extruded
from one face - so the background got extruded, the subject was never isolated, and it read as a
flat card when spun edge-on. `imageToSolid` fixes all three:

1. **Subject isolation** - `detectBackgroundMask` flood-fills the border-connected dominant colour
   and removes it, so the object floats in air.
2. **Depth from shape** - with no external depth map, a 2D chamfer distance transform
   (`silhouetteDistance`) "inflates" the silhouette: pixels deep inside bulge out, pixels near the
   outline taper thin (a rounded dome). A real per-pixel depth map (`depthOf`) - from a Blender
   depth pass or a monocular depth model - overrides the heuristic.
3. **Centered + double-sided** - thickness is distributed symmetrically about the mid-plane, so the
   front *and* back carry the image and the side silhouette shows the depth profile.

**Accuracy guarantees** (`packages/voxel/test/depth-accuracy.test.ts`): the front-view projection
reproduces every subject pixel's block exactly (colour + position), the silhouette equals the
subject mask, the background is air, and the side view is genuinely thick. Self-validation
(`apps/web/test/selfvalidate-3d.test.ts`) runs the full pipeline on real + synthetic images and
writes front/side projection PNGs; the live WebGL render is checked in a real browser.

## Greedy meshing

`apps/web/src/mesh3d.ts` → `greedyQuads` + `meshByMaterial`. The viewer no longer draws one cube
per voxel. It:

- **culls** any face that borders a solid neighbour (interior/occluded faces vanish) - a solid N³
  build drops from 6·N³ faces to ~6·N² shell faces;
- **greedy-merges** coplanar same-block faces into big UV-tiled quads (a solid cube → exactly 6
  quads);
- groups geometry by a material key so a block can carry **per-face textures** (grass top vs side,
  log end-grain), driven by the optional `faces` map in the texture manifest.

`Viewer3D` builds one `BufferGeometry` per material instead of an `InstancedMesh` of cubes.

## Animation

`packages/voxel/src/animate.ts`. Two tiers:

- **Transform animations** - a pure `(seconds, size) → pose` applied to the whole object each frame
  as an *absolute* pose (refresh-rate independent). Built-ins: `spin`, `bob`, `rock`, `tumble`,
  `pulse`, `orbit`. These replace the old baked 24-frame turntable (which aliased on rotation).
- **Volume-sequence generators** - produce a list of `VoxelVolume` frames where the content moves:
  `explodeAssemble`, `wave`, `buildUp`. These play through the frame scheduler and export straight
  to an animated datapack.

Shared **easing** curves drive both. The viewer (`apps/web/src/viewer3d.ts`) exposes `setAnim(name)`
and the web UI offers an animation dropdown. A single static build defaults to live `spin`; a
multi-frame sequence plays the frames (transform off, so it doesn't double-animate).
