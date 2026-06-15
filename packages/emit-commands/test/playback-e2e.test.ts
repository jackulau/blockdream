import { describe, it, expect } from "vitest";
import type { QuantizedFrame } from "@blockdream/color-core";
import { framesToAnimated3d } from "@blockdream/voxel";
import { computeDeltas } from "../src/delta";
import { generateJavaDatapack } from "../src/datapack";
import { generateVoxelDatapack } from "../src/datapack3d";
import { generateBedrockBehaviorPack } from "../src/behaviorpack";
import { generateBedrockScriptAddon, BEDROCK_PLAYER_JS } from "../src/bedrock-script";
import { greedyBoxes } from "../src/fill";
import {
  packageJavaDatapack,
  packageMcpack,
  validateJavaDatapackArchive,
  validateBedrockMcpackArchive,
} from "../src/package";

const W = 8;
const H = 8;

/** Build a QuantizedFrame from a per-pixel id function (ids 1..3; never 255/EMPTY). */
function frame(fill: (x: number, y: number) => number): QuantizedFrame {
  const n = W * H;
  const mapColorId = new Uint8Array(n);
  const paletteIndex = new Int32Array(n);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const id = fill(x, y);
      mapColorId[y * W + x] = id;
      paletteIndex[y * W + x] = id;
    }
  }
  return { width: W, height: H, mapColorId, paletteIndex };
}

const BLOCKS = ["minecraft:air", "minecraft:white_concrete", "minecraft:black_concrete", "minecraft:red_concrete"];
const rb = (id: number): string | undefined => BLOCKS[id] ?? undefined;

// A 3-frame "video": solid → half/half → swapped. Forces real deltas + a loop.
const FRAMES: QuantizedFrame[] = [
  frame(() => 1),
  frame((x) => (x < W / 2 ? 1 : 2)),
  frame((x) => (x < W / 2 ? 2 : 1)),
];

describe("delta playback reconstructs every frame + loops correctly (the core playback invariant)", () => {
  it("frame 0 is a full keyframe; later frames are deltas", () => {
    const d = computeDeltas(FRAMES);
    expect(d[0]!.keyframe).toBe(true);
    expect(d[0]!.cells.length).toBe(W * H); // keyframe places EVERY cell
    expect(d[1]!.keyframe).toBe(false);
    expect(d[1]!.cells.length).toBeLessThan(W * H); // only changed cells
  });

  it("applying keyframe + deltas cumulatively reproduces each source frame exactly", () => {
    const d = computeDeltas(FRAMES);
    const state = new Uint8Array(W * H);
    for (let k = 0; k < FRAMES.length; k++) {
      for (const c of d[k]!.cells) state[c.y * W + c.x] = c.mapColorId;
      expect([...state], `frame ${k}`).toEqual([...FRAMES[k]!.mapColorId]);
    }
    // LOOP: after the last frame, replaying frame 0's keyframe restores frame 0 exactly
    // (this is why wrap-to-0 is correct even though only frame 0 is a full redraw).
    for (const c of d[0]!.cells) state[c.y * W + c.x] = c.mapColorId;
    expect([...state]).toEqual([...FRAMES[0]!.mapColorId]);
  });

  it("delta also captures block→block changes with no gaps (no stale cells on transition)", () => {
    // frame 1 → frame 2 swaps both halves; every cell that differs must be in the delta.
    const d = computeDeltas(FRAMES);
    const changed = new Set(d[2]!.cells.map((c) => c.y * W + c.x));
    for (let p = 0; p < W * H; p++) {
      const differs = FRAMES[1]!.mapColorId[p] !== FRAMES[2]!.mapColorId[p];
      expect(changed.has(p), `pixel ${p}`).toBe(differs);
    }
  });
});

describe("Java vanilla datapack - playback wiring + version stamps", () => {
  const pack = generateJavaDatapack(FRAMES, rb, {
    packFormat: 71,
    supportedFormats: { min_inclusive: 48, max_inclusive: 88 },
  });
  const f = pack.files;

  it("setup draws the keyframe and start/stop toggle play", () => {
    expect(f.get("data/blockdream/function/setup.mcfunction")).toContain("function blockdream:frames/0");
    expect(f.get("data/blockdream/function/start.mcfunction")).toContain("#play ma 1");
    expect(f.get("data/blockdream/function/stop.mcfunction")).toContain("#play ma 0");
    expect(f.has("data/blockdream/function/frames/0.mcfunction")).toBe(true);
  });

  it("driver advances on a timer, dispatches via macro, and wraps to frame 0 (loop)", () => {
    const driver = f.get("data/blockdream/function/driver.mcfunction")!;
    expect(driver).toContain("execute unless score #play ma matches 1 run return 0"); // paused → bail
    expect(driver).toContain("execute if score #t ma < #speed ma run return 0"); // timer
    expect(driver).toContain("execute if score #f ma >= #count ma run scoreboard players set #f ma 0"); // LOOP
    expect(driver).toContain("function blockdream:play with storage blockdream:anim");
    expect(f.get("data/blockdream/function/play.mcfunction")).toContain("$function blockdream:frames/$(idx)");
    expect(f.get("data/minecraft/tags/function/tick.json")).toContain("blockdream:driver");
  });

  it("pack.mcmeta carries pack_format + supported_formats and the archive validates", () => {
    const meta = JSON.parse(f.get("pack.mcmeta")!);
    expect(meta.pack.pack_format).toBe(71);
    expect(meta.pack.supported_formats).toEqual({ min_inclusive: 48, max_inclusive: 88 });
    const check = validateJavaDatapackArchive(packageJavaDatapack(pack));
    expect(check.errors).toEqual([]);
    expect(check.ok).toBe(true);
  });
});

describe("Bedrock behavior pack - playback wiring", () => {
  const pack = generateBedrockBehaviorPack(FRAMES, rb, {});
  const f = pack.files;

  it("setup draws the keyframe; step wraps to frame 0 (loop)", () => {
    expect(f.get("functions/blockdream/setup.mcfunction")).toContain("function blockdream/frames/0");
    expect(f.get("functions/blockdream/step.mcfunction")).toContain(
      "execute if score f ma >= count ma run scoreboard players set f ma 0",
    );
  });

  it("uses a binary dispatch tree (O(log N)) reachable from the driver", () => {
    expect(f.get("functions/blockdream/driver.mcfunction")).toContain("function blockdream/advance");
    const dispatchNodes = [...f.keys()].filter((k) => /^functions\/blockdream\/dispatch\/.+\.mcfunction$/.test(k));
    expect(dispatchNodes.length).toBeGreaterThan(0);
    // a leaf calls a real frame function
    expect(f.get("functions/blockdream/dispatch/0_0.mcfunction")).toContain("function blockdream/frames/0");
    expect(f.get("functions/tick.json")).toContain("blockdream/driver");
  });

  it("the .mcpack archive validates", () => {
    const check = validateBedrockMcpackArchive(packageMcpack(f));
    expect(check.errors).toEqual([]);
    expect(check.ok).toBe(true);
  });
});

describe("Bedrock Script-API addon - playback wiring + autoplay keyframe regression", () => {
  it("the runtime draws frame 0 on load so AUTOPLAY does not start mid-animation on an empty wall", () => {
    // Regression for the fixed bug: reset() (which applies the keyframe) was only
    // wired to `!mw start`, so autoplay jumped straight to frame 1's delta.
    expect(BEDROCK_PLAYER_JS).toContain("system.run(() => { if (playing) reset(); });");
    expect(BEDROCK_PLAYER_JS).toContain("frameIndex = (frameIndex + 1) % POOL.frames.length"); // loop wrap
  });

  it("emits a POOL data module and a valid .mcpack", () => {
    const pack = generateBedrockScriptAddon(FRAMES, rb, { autoplay: true });
    expect(pack.files.get("behavior_pack/scripts/main.js")).toContain("system.run(() => { if (playing) reset(); });");
    expect(pack.files.get("behavior_pack/scripts/frames.js")).toContain("export const POOL");
    const check = validateBedrockMcpackArchive(packageMcpack(pack.files, { stripPrefix: "behavior_pack/" }));
    expect(check.errors).toEqual([]);
    expect(check.ok).toBe(true);
  });
});

describe("3D voxel datapack - playback wiring + version stamps", () => {
  it("builds an animated 3D datapack with the same loop driver + supported_formats", () => {
    const volumes = framesToAnimated3d(FRAMES, { maxDepth: 4 });
    expect(volumes.length).toBe(FRAMES.length);
    const pack = generateVoxelDatapack(volumes, rb, {
      packFormat: 88,
      supportedFormats: { min_inclusive: 48, max_inclusive: 88 },
      optimize: (cells, r) => greedyBoxes(cells, r),
    });
    const f = pack.files;
    expect(f.get("data/blockdream/function/setup.mcfunction")).toContain("function blockdream:frames/0");
    expect(f.get("data/blockdream/function/driver.mcfunction")).toContain(
      "execute if score #f ma >= #count ma run scoreboard players set #f ma 0",
    );
    const meta = JSON.parse(f.get("pack.mcmeta")!);
    expect(meta.pack.pack_format).toBe(88);
    expect(meta.pack.supported_formats).toEqual({ min_inclusive: 48, max_inclusive: 88 });
    expect(validateJavaDatapackArchive(packageJavaDatapack(pack)).ok).toBe(true);
  });
});
