import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { QuantizedFrame } from "@mineworld/color-core";
import { computeDeltas, type FrameDelta } from "./delta";
import { DEFAULT_MAX_COMMANDS, writeSplitFunction } from "./chunk";

export interface DatapackOptions {
  /** datapack namespace (a..z0-9_-). Default "mineworld". */
  namespace?: string;
  /** pack_format: 48 = MC 1.21.0 (singular folder layout). Override per target. */
  packFormat?: number;
  description?: string;
  /** world origin of the wall's bottom-left, +Z facing. Default {x:0,y:64,z:0}. */
  origin?: { x: number; y: number; z: number };
  /** ticks between frames (20 tps; 2 → 10 fps). Default 2. */
  speedTicks?: number;
  /** block placed for an unmapped color id. Default "minecraft:air". */
  fallbackBlock?: string;
  /** start playing immediately on load (else call <ns>:start). Default false. */
  autoplay?: boolean;
  /** max setblock commands per function before splitting into sub-functions. */
  maxCommandsPerFunction?: number;
}

export interface GeneratedPack {
  /** relative file path → text content */
  files: Map<string, string>;
  namespace: string;
  frameCount: number;
  width: number;
  height: number;
  /** total setblock commands across all frames (delta-encoded) */
  totalSetblocks: number;
}

const RESERVED = new Set(["minecraft"]);

function assertNamespace(ns: string): void {
  if (!/^[a-z0-9_-]+$/.test(ns) || RESERVED.has(ns)) {
    throw new Error(`invalid datapack namespace: ${ns}`);
  }
}

function setblockLine(
  x: number,
  y: number,
  z: number,
  block: string,
): string {
  return `setblock ${x} ${y} ${z} ${block} replace`;
}

function frameSetblockLines(
  delta: FrameDelta,
  height: number,
  origin: { x: number; y: number; z: number },
  resolveBlock: (mapColorId: number) => string | undefined,
  fallback: string,
): string[] {
  const lines: string[] = [];
  for (const c of delta.cells) {
    const wx = origin.x + c.x;
    const wy = origin.y + (height - 1 - c.y); // image row 0 at top
    const wz = origin.z;
    lines.push(setblockLine(wx, wy, wz, resolveBlock(c.mapColorId) ?? fallback));
  }
  return lines;
}

/**
 * Generate a 100%-vanilla Java datapack that plays a block-art video as a wall
 * of solid blocks, driven entirely by command content (no mod / FAWE).
 *
 * Mechanism: `#minecraft:tick` runs `<ns>:driver`, which advances a scoreboard
 * frame counter every `speedTicks` and dispatches via a vanilla MACRO
 * (`$function <ns>:frames/$(idx)`), so there is no O(frames) execute-if table.
 */
export function generateJavaDatapack(
  frames: QuantizedFrame[],
  resolveBlock: (mapColorId: number) => string | undefined,
  opts: DatapackOptions = {},
): GeneratedPack {
  if (frames.length === 0) throw new Error("no frames");
  const ns = opts.namespace ?? "mineworld";
  assertNamespace(ns);
  const packFormat = opts.packFormat ?? 48;
  const origin = opts.origin ?? { x: 0, y: 64, z: 0 };
  const speed = Math.max(1, Math.floor(opts.speedTicks ?? 2));
  const fallback = opts.fallbackBlock ?? "minecraft:air";
  const { width: W, height: H } = frames[0]!;

  const limit = Math.max(1, Math.floor(opts.maxCommandsPerFunction ?? DEFAULT_MAX_COMMANDS));
  const deltas = computeDeltas(frames);
  const files = new Map<string, string>();
  const fnDir = `data/${ns}/function`;

  // per-frame functions (split into sub-functions if over the command budget)
  let totalSetblocks = 0;
  for (const d of deltas) {
    totalSetblocks += d.cells.length;
    const lines = frameSetblockLines(d, H, origin, resolveBlock, fallback);
    const header = `# frame ${d.index}${d.keyframe ? " (keyframe)" : ` (Δ ${d.cells.length})`}`;
    writeSplitFunction(
      files,
      `${fnDir}/frames/${d.index}`,
      lines,
      limit,
      (k) => `function ${ns}:frames/${d.index}/part${k}`,
      header,
    );
  }

  // macro dispatcher: called with storage {idx:int}
  files.set(`${fnDir}/play.mcfunction`, `$function ${ns}:frames/$(idx)\n`);

  // setup: objectives, forceload, build keyframe
  const minX = origin.x;
  const maxX = origin.x + W - 1;
  const z = origin.z;
  files.set(
    `${fnDir}/setup.mcfunction`,
    [
      `# one-time setup: load via /function ${ns}:setup`,
      `scoreboard objectives add ma dummy`,
      `scoreboard players set #play ma ${opts.autoplay ? 1 : 0}`,
      `scoreboard players set #t ma 0`,
      `scoreboard players set #f ma 0`,
      `scoreboard players set #speed ma ${speed}`,
      `scoreboard players set #count ma ${frames.length}`,
      `forceload add ${minX} ${z} ${maxX} ${z}`,
      `function ${ns}:frames/0`,
      "",
    ].join("\n"),
  );

  files.set(`${fnDir}/start.mcfunction`, `scoreboard players set #play ma 1\n`);
  files.set(`${fnDir}/stop.mcfunction`, `scoreboard players set #play ma 0\n`);

  // driver: runs every tick via the tick tag
  files.set(
    `${fnDir}/driver.mcfunction`,
    [
      `# advance + dispatch — runs every tick from #minecraft:tick`,
      `execute unless score #play ma matches 1 run return 0`,
      `scoreboard players add #t ma 1`,
      `execute if score #t ma < #speed ma run return 0`,
      `scoreboard players set #t ma 0`,
      `scoreboard players add #f ma 1`,
      `execute if score #f ma >= #count ma run scoreboard players set #f ma 0`,
      `execute store result storage ${ns}:anim idx int 1 run scoreboard players get #f ma`,
      `function ${ns}:play with storage ${ns}:anim`,
      "",
    ].join("\n"),
  );

  // tick tag (minecraft namespace, singular "function" since 1.21)
  files.set(
    `data/minecraft/tags/function/tick.json`,
    JSON.stringify({ values: [`${ns}:driver`] }, null, 2) + "\n",
  );

  files.set(
    "pack.mcmeta",
    JSON.stringify(
      {
        pack: {
          pack_format: packFormat,
          description: opts.description ?? `mineworld block-art video (${W}×${H}, ${frames.length} frames)`,
        },
      },
      null,
      2,
    ) + "\n",
  );

  return { files, namespace: ns, frameCount: frames.length, width: W, height: H, totalSetblocks };
}

/** Write a generated pack's file map to disk under destDir. */
export function writePack(pack: GeneratedPack, destDir: string): void {
  for (const [rel, content] of pack.files) {
    const abs = join(destDir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
}
