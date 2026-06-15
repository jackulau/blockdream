import { createHash } from "node:crypto";
import type { QuantizedFrame } from "@blockdream/color-core";
import { computeDeltas, type FrameDelta } from "./delta";
import { DEFAULT_MAX_COMMANDS, writeSplitFunction } from "./chunk";
import { greedyBoxes, type PlacedCell } from "./fill";
import type { GeneratedPack } from "./datapack";

export interface BehaviorPackOptions {
  namespace?: string;
  name?: string;
  description?: string;
  /** [major,minor,patch] min engine version. Default [1,21,0]. */
  minEngineVersion?: [number, number, number];
  origin?: { x: number; y: number; z: number };
  speedTicks?: number;
  fallbackBlock?: string;
  autoplay?: boolean;
  /** override the two manifest UUIDs (header, module); else derived deterministically. */
  uuids?: [string, string];
  /** max setblock commands per function before splitting into sub-functions. */
  maxCommandsPerFunction?: number;
  /** collapse same-block runs into /fill via greedy box-merging (lossless). Default true. */
  optimizeFills?: boolean;
}

/** Deterministic UUID (v4-shaped) from a seed string - reproducible packs/tests. */
function uuidFromSeed(seed: string): string {
  const h = createHash("sha1").update(seed).digest("hex");
  // shape xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
  const y = ((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${y}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

function setblockLine(x: number, y: number, z: number, block: string): string {
  return `setblock ${x} ${y} ${z} ${block} replace`;
}

function frameSetblockLines(
  delta: FrameDelta,
  height: number,
  origin: { x: number; y: number; z: number },
  resolveBlock: (id: number) => string | undefined,
  fallback: string,
): string[] {
  const lines: string[] = [];
  for (const c of delta.cells) {
    lines.push(setblockLine(origin.x + c.x, origin.y + (height - 1 - c.y), origin.z, resolveBlock(c.mapColorId) ?? fallback));
  }
  return lines;
}

/** Map a 2D delta's cells to WORLD-coordinate placed cells (image row 0 at top of wall). */
function framePlacedCells(
  delta: FrameDelta,
  height: number,
  origin: { x: number; y: number; z: number },
): PlacedCell[] {
  return delta.cells.map((c) => ({
    x: origin.x + c.x,
    y: origin.y + (height - 1 - c.y),
    z: origin.z,
    mapColorId: c.mapColorId,
  }));
}

/**
 * Build a binary dispatch tree of functions so the per-tick frame lookup is
 * O(log N) instead of an O(N) execute-if scan (Bedrock has no macros). Returns
 * the root function's relative name and registers every node in `files`.
 */
function buildDispatchTree(
  ns: string,
  count: number,
  files: Map<string, string>,
): string {
  const dir = `functions/${ns}/dispatch`;
  const build = (lo: number, hi: number): string => {
    const nameRel = `${ns}/dispatch/${lo}_${hi}`;
    if (lo === hi) {
      // leaf: parent guard already matched this range → call the frame directly
      files.set(`${dir}/${lo}_${hi}.mcfunction`, `function ${ns}/frames/${lo}\n`);
      return nameRel;
    }
    const mid = (lo + hi) >> 1;
    const left = build(lo, mid);
    const right = build(mid + 1, hi);
    files.set(
      `${dir}/${lo}_${hi}.mcfunction`,
      [
        `execute if score f ma matches ${lo}..${mid} run function ${left}`,
        `execute if score f ma matches ${mid + 1}..${hi} run function ${right}`,
        "",
      ].join("\n"),
    );
    return nameRel;
  };
  return build(0, count - 1);
}

/**
 * Generate a 100%-vanilla Bedrock behavior pack that plays the block-art video.
 * Bedrock differences vs Java: plural `functions/`, no namespace on function
 * refs, `tick.json` auto-runs the driver, no `return`/macros (→ nested guard
 * functions + a binary dispatch tree), `tickingarea` for chunk loading.
 */
export function generateBedrockBehaviorPack(
  frames: QuantizedFrame[],
  resolveBlock: (mapColorId: number) => string | undefined,
  opts: BehaviorPackOptions = {},
): GeneratedPack {
  if (frames.length === 0) throw new Error("no frames");
  const ns = opts.namespace ?? "blockdream";
  if (!/^[a-z0-9_]+$/.test(ns)) throw new Error(`invalid namespace: ${ns}`);
  const origin = opts.origin ?? { x: 0, y: 64, z: 0 };
  const speed = Math.max(1, Math.floor(opts.speedTicks ?? 2));
  const fallback = opts.fallbackBlock ?? "minecraft:air";
  const { width: W, height: H } = frames[0]!;
  const limit = Math.max(1, Math.floor(opts.maxCommandsPerFunction ?? DEFAULT_MAX_COMMANDS));
  const optimizeFills = opts.optimizeFills ?? true;
  const deltas = computeDeltas(frames);
  const files = new Map<string, string>();

  let totalSetblocks = 0;
  let totalCommands = 0;
  for (const d of deltas) {
    totalSetblocks += d.cells.length;
    const lines = optimizeFills
      ? greedyBoxes(framePlacedCells(d, H, origin), (id) => resolveBlock(id) ?? fallback)
      : frameSetblockLines(d, H, origin, resolveBlock, fallback);
    totalCommands += lines.length;
    const header = `# frame ${d.index}${d.keyframe ? " (keyframe)" : ` (Δ ${d.cells.length})`}`;
    writeSplitFunction(
      files,
      `functions/${ns}/frames/${d.index}`,
      lines,
      limit,
      (k) => `function ${ns}/frames/${d.index}/part${k}`,
      header,
    );
  }

  const dispatchRoot = buildDispatchTree(ns, frames.length, files);

  // tick driver (Bedrock has no `return`; use nested guard functions)
  files.set(`functions/${ns}/driver.mcfunction`, `execute if score play ma matches 1 run function ${ns}/advance\n`);
  files.set(
    `functions/${ns}/advance.mcfunction`,
    [`scoreboard players add t ma 1`, `execute if score t ma >= speed ma run function ${ns}/step`, ""].join("\n"),
  );
  files.set(
    `functions/${ns}/step.mcfunction`,
    [
      `scoreboard players set t ma 0`,
      `scoreboard players add f ma 1`,
      `execute if score f ma >= count ma run scoreboard players set f ma 0`,
      `function ${dispatchRoot}`,
      "",
    ].join("\n"),
  );

  const minX = origin.x;
  const maxX = origin.x + W - 1;
  const minY = origin.y;
  const maxY = origin.y + H - 1;
  files.set(
    `functions/${ns}/setup.mcfunction`,
    [
      `# run once: /function ${ns}/setup`,
      `scoreboard objectives add ma dummy`,
      `scoreboard players set play ma ${opts.autoplay ? 1 : 0}`,
      `scoreboard players set t ma 0`,
      `scoreboard players set f ma 0`,
      `scoreboard players set speed ma ${speed}`,
      `scoreboard players set count ma ${frames.length}`,
      `tickingarea add ${minX} ${minY} ${origin.z} ${maxX} ${maxY} ${origin.z} ${ns}_area`,
      `function ${ns}/frames/0`,
      "",
    ].join("\n"),
  );
  files.set(`functions/${ns}/start.mcfunction`, `scoreboard players set play ma 1\n`);
  files.set(`functions/${ns}/stop.mcfunction`, `scoreboard players set play ma 0\n`);

  // tick.json - Bedrock auto-runs these every tick
  files.set(`functions/tick.json`, JSON.stringify({ values: [`${ns}/driver`] }, null, 2) + "\n");

  const headerUuid = opts.uuids?.[0] ?? uuidFromSeed(`${ns}:header`);
  const moduleUuid = opts.uuids?.[1] ?? uuidFromSeed(`${ns}:module`);
  files.set(
    "manifest.json",
    JSON.stringify(
      {
        format_version: 2,
        header: {
          name: opts.name ?? "blockdream block-art video",
          description: opts.description ?? `${W}×${H}, ${frames.length} frames`,
          uuid: headerUuid,
          version: [1, 0, 0],
          min_engine_version: opts.minEngineVersion ?? [1, 21, 0],
        },
        modules: [{ type: "data", uuid: moduleUuid, version: [1, 0, 0] }],
      },
      null,
      2,
    ) + "\n",
  );

  return { files, namespace: ns, frameCount: frames.length, width: W, height: H, totalSetblocks, totalCommands };
}
