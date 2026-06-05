import { parseArgs } from "node:util";
import { render, type RenderOptions, type RenderTarget, type Edition } from "./render";
import type { DitherMethod } from "@mineworld/color-core";

const USAGE = `mineworld render <input> [options]

Convert a GIF/video into Minecraft block-art.

Options:
  --target <t>       map | mcstructure | datapack | behaviorpack | mwframes
                       (default: datapack; mwframes = Fabric map-wall mod pool)
  --edition <e>      java | bedrock                                (map target only; default: java)
  --grid <WxH>       block grid size      (default: 128x128 for map, 64x64 otherwise)
  --fps <n>          sample frame rate    (default: source rate)
  --max-frames <n>   cap number of frames
  --dither <d>       floyd-steinberg | bayer | none
                       (default: bayer for video, floyd-steinberg for stills)
  --temporal <n>     temporal-coherence threshold for video (e.g. 0.002)
  --speed <ticks>    ticks/frame for datapack/behaviorpack playback (default: 2 = 10fps)
  --version <ver>    palette version (default: 1.21.9 java / 1.21 bedrock)
  --out <path>       output directory (default: ./out/<target>)
  -h, --help
`;

const TARGETS = new Set<RenderTarget>([
  "map",
  "mcstructure",
  "datapack",
  "behaviorpack",
  "bedrock-script",
  "mwframes",
]);
const DITHERS = new Set<DitherMethod>(["floyd-steinberg", "bayer", "none"]);

export function runCli(argv: string[]): number {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      target: { type: "string" },
      edition: { type: "string" },
      grid: { type: "string" },
      fps: { type: "string" },
      "max-frames": { type: "string" },
      dither: { type: "string" },
      temporal: { type: "string" },
      speed: { type: "string" },
      version: { type: "string" },
      out: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });

  if (values.help || positionals[0] !== "render" || !positionals[1]) {
    process.stdout.write(USAGE);
    return values.help ? 0 : 1;
  }

  const input = positionals[1];
  const target = (values.target ?? "datapack") as RenderTarget;
  if (!TARGETS.has(target)) {
    process.stderr.write(`unknown --target ${target}\n`);
    return 2;
  }
  const edition = (values.edition ?? "java") as Edition;

  let width: number;
  let height: number;
  if (values.grid) {
    const m = /^(\d+)x(\d+)$/.exec(values.grid);
    if (!m) {
      process.stderr.write(`--grid must be WxH (e.g. 128x128)\n`);
      return 2;
    }
    width = parseInt(m[1]!, 10);
    height = parseInt(m[2]!, 10);
  } else {
    width = target === "map" ? 128 : 64;
    height = target === "map" ? 128 : 64;
  }

  const dither = values.dither as DitherMethod | undefined;
  if (dither && !DITHERS.has(dither)) {
    process.stderr.write(`unknown --dither ${dither}\n`);
    return 2;
  }

  const opts: RenderOptions = {
    input,
    out: values.out ?? `./out/${target}`,
    target,
    edition,
    width,
    height,
    fps: values.fps ? Number(values.fps) : undefined,
    maxFrames: values["max-frames"] ? Number(values["max-frames"]) : undefined,
    dither,
    temporalThreshold: values.temporal ? Number(values.temporal) : undefined,
    speedTicks: values.speed ? Number(values.speed) : undefined,
    paletteVersion: values.version,
  };

  try {
    const r = render(opts);
    process.stdout.write(
      `✓ ${r.target}: ${r.frameCount} frame(s) at ${r.width}×${r.height} → ${r.filesWritten.length} file(s) in ${opts.out}\n`,
    );
    for (const n of r.notes) process.stdout.write(`  • ${n}\n`);
    return 0;
  } catch (e) {
    process.stderr.write(`✗ render failed: ${(e as Error).message}\n`);
    return 1;
  }
}
