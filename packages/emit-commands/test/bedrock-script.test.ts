import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { QuantizedFrame } from "@blockdream/color-core";
import { generateBedrockScriptAddon, buildFramesJs, BEDROCK_PLAYER_JS } from "../src/bedrock-script";

const MIRROR_MAIN_JS = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../..",
  "mods/bedrock-addon/behavior_pack/scripts/main.js",
);

function frameFromIds(ids: number[][]): QuantizedFrame {
  const h = ids.length;
  const w = ids[0]!.length;
  const flat = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) flat[y * w + x] = ids[y]![x]!;
  return { width: w, height: h, paletteIndex: new Int32Array(w * h), mapColorId: flat };
}

const BLOCKS = ["minecraft:white_concrete", "minecraft:black_concrete"];
const resolve = (id: number) => BLOCKS[id % BLOCKS.length];

function parsePool(framesJs: string): any {
  const m = /export const POOL = (\{.*\});/s.exec(framesJs);
  if (!m) throw new Error("no POOL in frames.js");
  return JSON.parse(m[1]!);
}

describe("bedrock script addon generator", () => {
  const frames = [
    frameFromIds([
      [0, 1],
      [1, 0],
    ]),
    frameFromIds([
      [0, 1],
      [1, 1], // one changed cell
    ]),
  ];
  const pack = generateBedrockScriptAddon(frames, resolve, { speedTicks: 4 });

  it("emits a valid manifest.json with a script module", () => {
    const m = JSON.parse(pack.files.get("behavior_pack/manifest.json")!);
    expect(m.format_version).toBe(2);
    expect(m.modules[0].type).toBe("script");
    expect(m.modules[0].entry).toBe("scripts/main.js");
    expect(m.dependencies[0].module_name).toBe("@minecraft/server");
  });

  it("includes a runnable main.js using the Script API tick loop", () => {
    const js = pack.files.get("behavior_pack/scripts/main.js")!;
    expect(js).toContain("system.runInterval");
    expect(js).toContain("@minecraft/server");
    expect(js).toContain('import { POOL } from "./frames.js"');
  });

  it("frames.js POOL has palette + delta frames (keyframe full, then deltas)", () => {
    const pool = parsePool(pack.files.get("behavior_pack/scripts/frames.js")!);
    expect(pool.speedTicks).toBe(4);
    expect(pool.palette).toContain("minecraft:white_concrete");
    expect(pool.frames.length).toBe(2);
    expect(pool.frames[0].length).toBe(4); // keyframe = all 4 cells
    expect(pool.frames[1].length).toBe(1); // delta = 1 changed cell
    // each cell is [x, y, paletteIndex]
    expect(pool.frames[1][0].length).toBe(3);
    expect(pool.palette[pool.frames[1][0][2]]).toMatch(/^minecraft:/);
  });

  it("buildFramesJs is deterministic for the same input", () => {
    const a = buildFramesJs(frames, resolve, { speedTicks: 4 });
    const b = buildFramesJs(frames, resolve, { speedTicks: 4 });
    expect(a).toBe(b);
  });
});

// A bare `catch {}` around BlockPermutation.resolve() renders frames with
// silently-missing blocks (stale/unregistered ids give ZERO visibility).
// The player must count failures and console.warn ONCE per frame.
const BARE_CATCH = /catch\s*\{\s*(\/\*[\s\S]*?\*\/)?\s*\}/;
const WARN_LINE =
  'console.warn("[blockdream] frame " + f + ": " + failed + " cell(s) failed BlockPermutation.resolve (bad ids: " + failedIds.join(", ") + ")");';

describe("resolve-failure surfacing: source", () => {
  it("BEDROCK_PLAYER_JS has no bare catch and warns once per frame", () => {
    expect(BEDROCK_PLAYER_JS).not.toMatch(BARE_CATCH);
    expect(BEDROCK_PLAYER_JS).toContain(WARN_LINE);
    expect(BEDROCK_PLAYER_JS).toContain("failedIds.length < 3");
  });

  it("mirror mods/bedrock-addon main.js carries the identical surfacing", async () => {
    const mirror = await readFile(MIRROR_MAIN_JS, "utf8");
    expect(mirror).not.toMatch(BARE_CATCH);
    expect(mirror).toContain(WARN_LINE); // exact same warning line as the template
    expect(mirror).toContain("failedIds.length < 3");
  });
});

describe("resolve-failure surfacing: executed against a stubbed @minecraft/server", () => {
  // Stub: BlockPermutation.resolve throws for any id containing "bad_",
  // system.run fires synchronously, runInterval callbacks are captured.
  const STUB_SRC = `export const state = { placed: [], intervals: [] };
export const world = {
  getDimension: () => ({
    getBlock: (loc) => ({
      setPermutation: (perm) => { state.placed.push({ loc, blockId: perm.blockId }); },
    }),
  }),
  afterEvents: {},
};
export const system = {
  runInterval: (fn) => { state.intervals.push(fn); return 1; },
  run: (fn) => { fn(); return 1; },
};
export const BlockPermutation = {
  resolve: (blockId) => {
    if (blockId.includes("bad_")) throw new Error("unknown block " + blockId);
    return { blockId };
  },
};
`;

  // Frame 0: 5 failing cells across 4 DISTINCT bad ids (bad_a twice) + 1 good
  // cell. Frame 1: good cells only. speedTicks 1 so each tick advances a frame.
  const POOL = {
    height: 2,
    origin: { x: 0, y: 64, z: 0 },
    speedTicks: 1,
    dimension: "overworld",
    autoplay: true,
    palette: [
      "minecraft:bad_a",
      "minecraft:bad_b",
      "minecraft:bad_c",
      "minecraft:bad_d",
      "minecraft:white_concrete",
    ],
    frames: [
      [[0, 0, 0], [1, 0, 0], [2, 0, 1], [3, 0, 2], [0, 1, 3], [1, 1, 4]],
      [[0, 0, 4], [1, 0, 4]],
    ],
  };

  let dir: string;
  let stub: any;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "blockdream-bedrock-script-"));
    await writeFile(join(dir, "package.json"), '{ "type": "module" }\n');
    const stubPath = join(dir, "minecraft-server-stub.js");
    await writeFile(stubPath, STUB_SRC);
    await writeFile(join(dir, "frames.js"), `export const POOL = ${JSON.stringify(POOL)};\n`);
    // Retarget only the @minecraft/server import; ./frames.js resolves in-dir.
    const mainSrc = BEDROCK_PLAYER_JS.replace(
      '"@minecraft/server"',
      JSON.stringify(pathToFileURL(stubPath).href),
    );
    expect(mainSrc).not.toBe(BEDROCK_PLAYER_JS);
    await writeFile(join(dir, "main.js"), mainSrc);

    stub = await import(/* @vite-ignore */ pathToFileURL(stubPath).href);
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    // Importing main.js runs system.run -> reset() -> applyFrame(0) (autoplay).
    await import(/* @vite-ignore */ pathToFileURL(join(dir, "main.js")).href);
  });

  afterAll(async () => {
    warnSpy.mockRestore();
    await rm(dir, { recursive: true, force: true });
  });

  it("warns exactly once for the failing keyframe: frame index, count, up to 3 distinct ids", () => {
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const msg = String(warnSpy.mock.calls[0]![0]);
    expect(msg).toContain("frame 0");
    expect(msg).toContain("5 cell(s) failed BlockPermutation.resolve");
    expect(msg).toContain("minecraft:bad_a");
    expect(msg).toContain("minecraft:bad_b");
    expect(msg).toContain("minecraft:bad_c");
    expect(msg).not.toContain("minecraft:bad_d"); // capped at 3 distinct ids
  });

  it("still places the resolvable blocks of a failing frame", () => {
    expect(stub.state.placed.map((p: any) => p.blockId)).toContain("minecraft:white_concrete");
  });

  it("clean frames do not warn; re-applying the bad frame warns again (once)", () => {
    stub.state.intervals[0]!(); // tick -> frame 1 (all good)
    expect(warnSpy).toHaveBeenCalledTimes(1);
    stub.state.intervals[0]!(); // tick -> wraps to frame 0 (bad)
    expect(warnSpy).toHaveBeenCalledTimes(2);
    expect(String(warnSpy.mock.calls[1]![0])).toContain("frame 0");
  });
});
