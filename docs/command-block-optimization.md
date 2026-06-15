# Command-block optimization - building & animating blocks in vanilla, efficiently

This is the deep version of `vanilla-command-budgets.md`. It covers how blockdream places
and animates thousands of blocks per tick in **100% vanilla** Minecraft, why each choice
wins, and the strategy the builder (`@blockdream/emit-commands` + `@blockdream/voxel`) now
bakes in. No mods, no FAWE, no WorldEdit.

## 0. The mental model: "command block" = datapack function

The phrase "command block" is a red herring for anything non-trivial. There are three
vanilla ways to run commands on a clock:

| Mechanism | Reality |
|---|---|
| **Impulse/chain command-block lines** | A physical chain of blocks you hand-place; capped, un-versionable, painful to author, and they re-parse on every activation. Fine for ≤ a few commands. |
| **Repeating command block** | Runs one command every tick. To run thousands, it must `function` into a datapack anyway. |
| **Datapack function on `#minecraft:tick`** | A text `.mcfunction` of arbitrarily many commands, loaded once, dispatched every tick by the game. **This is the correct primitive.** |

So the "custom command-block builder" emits a **datapack** whose `#minecraft:tick` tag runs
a tiny `driver` function. Literal command-block chains are the anti-pattern for block-art:
they don't scale, can't be delta-encoded cleanly, and re-tokenize constantly. Everything
below assumes datapack functions.

## 1. The per-tick command budget

Two hard limits bound a single tick:

- **`maxCommandChainLength`** (gamerule, default **65536**) - the max commands a single
  function (and its `function`-callees) may execute in one tick before the chain is cut.
  Exceed it and the frame silently truncates.
- **Practical hitch threshold** - long before 65536, running many thousands of
  `/setblock`s in one tick causes a visible frame stall (each is a block update + lighting
  + neighbour notification). Smooth playback wants the *per-advance* command count low.

The builder splits any frame whose command count exceeds `maxCommandsPerFunction`
(**default 8000**, configurable) into `frames/<i>/part<k>` sub-functions called by the
parent (`chunk.ts:writeSplitFunction`). That keeps any one function well under
`maxCommandChainLength` and spreads a heavy keyframe across callees.

| Grid (W×H) | Keyframe blocks | Sub-functions @ 8000 |
|---|---|---|
| 64×64 | 4,096 | 1 |
| 128×128 | 16,384 | 3 |
| 64×64×16 (3D) | up to 65,536 | up to 9 (before `/fill`) |

The keyframe (frame 0) is the worst case. **Sustained cost is the delta, not the keyframe.**

## 2. /setblock vs /fill vs /clone vs structure blocks

- **`/setblock x y z block`** - one block. Baseline; O(N) commands for N cells.
- **`/fill x1 y1 z1 x2 y2 z2 block`** - a whole cuboid in **one** command (vanilla caps the
  fill volume at **32,768** blocks). A solid 64-wide row → 1 command instead of 64. This is
  the single biggest lever for block-art, which is full of same-colour runs.
- **`/clone`** - copies an existing region. Great for *repeating* a pre-built motif or for
  double-buffering (build off-screen, clone into place), but needs the source to already
  exist; not a primary placement tool here.
- **Structure blocks / `place template`** - load a saved `.nbt`/`.mcstructure` instantly,
  bypassing per-block commands entirely. Best for a *static* 3D build or a small set of
  discrete frames (swap structures per frame). The cost moves from per-tick commands to
  load I/O. blockdream emits `.mcstructure` (`buildVoxelMcStructure`) for exactly this path.

**Winner for animation:** `/fill` run-batching over `/setblock`, with structure-swap as the
alternative for a handful of heavy 3D frames.

## 3. Delta encoding + double-buffering

Frame 0 is a full keyframe; every later frame lists **only the cells that changed** vs the
previous frame (`delta.ts`, `datapack3d.computeVoxelDeltas`). For real video / a slow spin,
the per-frame delta is a small fraction of the keyframe, so sustained per-tick cost stays
low even at 128×128 or a 3D volume. Air transitions (solid→air on a spin) are encoded as
`/setblock … air`, so the build stays correct frame-to-frame without a full clear.

For very high motion, **double-buffer**: build frame N+1 in an off-screen copy of the
region while frame N is shown, then `/clone` it into place in one command. This trades
space for a single-command swap and zero mid-build tearing. (Documented here; the default
emitter uses in-place deltas, which are cheaper for typical low-to-medium motion.)

## 4. /fill run-batching - the core optimizer

`fill.ts:fillBatch` groups a frame's cells by `(y,z)` row and collapses maximal runs of
**contiguous, same-block** cells along X into one `/fill`; singletons stay `/setblock`.
Deterministic `z→y→x` ordering keeps output reproducible. On block-art (large flat colour
fields) this cuts command counts by 5–50×; a solid 64-cell row becomes a single `/fill`.
It works unchanged in 3D (runs are per-`(y,z)` row), and `/fill`'s 32,768-block cap is
respected because runs are 1-D. This is wired into the 3D datapack via the `optimize` hook.

## 5. 3D & spin specifics

- A 3D build is a `VoxelVolume` (`@blockdream/voxel`); the emitter clears the bounding box
  once with a single `/fill … air` then places solids, so leftover blocks never corrupt it.
- A **spin** is `voxel.spin(volume, nFrames)` → N rotated volumes → delta-encoded frames.
  Because rotation only changes a thin shell of voxels per step, deltas stay small.
- 3D fill cuboids: where a solid sub-box exists, a future pass can emit a 3-D `/fill` for
  the whole cuboid (greedy meshing in command space). The row-wise `/fill` already captures
  the dominant 1-D win; cuboid batching is the next increment.

## 6. Parallel, multi-core emission

Generating the commands is itself CPU-bound (voxelize + delta + fill-batch over many
frames). `parallel.ts:fillBatchFrames` spreads per-frame fill-batching across
`cpus-1` real OS threads via node **worker** threads (`emit-worker.mjs`), merging results
in frame order. The output is **byte-identical** to the serial path - parallelism is purely
an efficiency win, verified in `parallel.test.ts`. The browser viewer uses vite-native
`Worker`s for the same effect in-page. A serial fallback runs when workers are unavailable
or there is ≤1 frame.

## 7. fps / resolution tradeoffs

Playback advances one frame every `speedTicks` (20 tps): 1→20 fps, 2→10 fps, 4→5 fps.
Pick the budget so the *delta* per advance stays under a few thousand post-`/fill` commands:

- **Hero stills / low motion** → vanilla blocks, 64–128 wide (or a modest 3D volume),
  5–10 fps. Crisp, fully vanilla.
- **High motion / video** → drop resolution/fps, or use the map-item wall
  (`@blockdream/emit-java`) which swaps a 16,384-byte colour array per map instead of
  thousands of block updates.
- **Static 3D / few frames** → `.mcstructure` + structure blocks (instant load).

## The winning strategy (what the builder bakes in)

1. Emit a **datapack function** driven by `#minecraft:tick` (never literal command-block chains).
2. **Delta-encode** frames; keyframe 0 only, then changed cells.
3. **`/fill` run-batch** every frame (`fillBatch`) - the dominant command-count cut.
4. **Split** any frame over `maxCommandsPerFunction` into sub-functions, staying under `maxCommandChainLength`.
5. Clear the 3D build box once with `/fill … air`; place via 3D `/setblock`/`/fill`.
6. **Parallelize** emission across cores (worker threads); output identical to serial.
7. Offer **`.mcstructure`** for static/3D builds and the **map-wall** path for high-motion video.
