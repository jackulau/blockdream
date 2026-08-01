import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { resolveMcVersion } from "@blockdream/palette";
import { joinDashValues } from "./argv";
import { render, BAKEABLE_ANIMS, isFacing, type RenderOptions, type RenderTarget, type Edition, type Facing, type MusicMode } from "./render";
import { previewPng } from "./preview";
import type { DitherMethod } from "@blockdream/color-core";
import type { BakeableAnimName } from "@blockdream/voxel";
import { NOTE_BLOCK_INSTRUMENTS } from "@blockdream/audio";

const USAGE = `blockdream render <input> [options]
blockdream preview <input> --out preview.png   (side-by-side source | block-art PNG)

Convert a GIF/video into Minecraft block-art.

Options:
  --target <t>       map | mcstructure | mcstructure3d | datapack | behaviorpack | bedrock-script |
                       mwframes | voxel3d | model3d | rgbscreen
                       (default: datapack; mwframes = Fabric map-wall mod pool;
                        mcstructure3d = TRUE 3D Bedrock structure from the voxel pipeline;
                        model3d = voxelize a real 3D MODEL .obj/.gltf/.glb into blocks;
                        bedrock-script = Bedrock Script-API addon .mcpack; needs the
                        "Beta APIs" experiment toggled ON in the world, then chat !mw start;
                        rgbscreen = TRUE-RGB screen of text_display pixels — exact 16.7M
                        colors in unmodded Java, full-bright, no palette/dither)
  --edition <e>      java | bedrock          (map + mwframes + model3d targets; default: java)
  --grid <WxH>       block grid size      (default: 128x128 for map, 64x64 otherwise;
                       for model3d the WIDTH is the cube voxel resolution)
  --fps <n>          sample frame rate    (default: source rate; in-game playback tops out
                       at 20 fps — Minecraft runs 1 animation step per game tick, so
                       --fps 20 is the fastest 1:1 datapack playback; above 20 the pack is
                       resampled evenly to 20 fps — same duration, frames skipped — unless
                       an explicit --speed asks for raw pacing)
  --max-frames <n>   cap number of frames
  --dither <d>       floyd-steinberg | bayer | none
                       (default: bayer for video, floyd-steinberg for stills)
  --palette <p>      map | block   (preview ONLY: compare against the 244-color map palette
                       or the full solid-block build gamut; default: map)
  --temporal <n>     temporal-coherence threshold for video (e.g. 0.002)
  --gamut <lambda>   hue-rigidity for out-of-gamut colours (e.g. 0.8; keeps source hue)
  --speed <ticks>    ticks/frame for datapack/behaviorpack playback (default: matches --fps
                       so playback runs real-time - e.g. --fps 20 → 1 tick/frame; no --fps → 2)
  --depth <n>        3D build depth in blocks for voxel3d/mcstructure3d (default: 8)
  --smooth <n>       3D video temporal depth smoothing 0..1 (default: 0.35)
  --curve <n>        3D thickness curve exponent (<1 rounds the dome; default: 0.5)
  --shading <n>      3D shape-from-shading gain 0..1 — luminance carves internal relief (default: 0.5; 0 = off)
  --flat             3D one-sided relief instead of the centered double-sided solid
  --wall             voxel3d: FAITHFUL flat video wall — every pixel is exactly one block,
                       background included (no subject isolation, no relief). THE mode for
                       recreating a whole video in blocks
  --led              voxel3d: invisible minecraft:light[level=15] plane fronting the wall,
                       so it glows like an LED screen at night (placed once in setup)
  --cushion-mosaic   voxel3d, EXPERIMENTAL (Java 26.3 SNAPSHOT ONLY): also emit frame 0 as a
                       top-down cushion-entity FLOOR mosaic (16 dye colors, one summoned
                       cushion per pixel). Cushions are entities on floors - a cushion WALL
                       is impossible; see docs/cushions-26.3.md
  --animate <a>      3D block-motion of the built solid: explode | wave | buildup | spin
                       (voxel3d/mcstructure3d/model3d; animates a STILL image or a 3D model.
                        For a clip it animates the first frame.)
  --animate-frames <n>  frame count for --animate (default: 24)
  --origin <x,y,z>   where the 3D build spawns in-world (voxel3d/model3d datapack; default 0,64,0)
  --facing <dir>     which way the 3D build faces: north | south | east | west (default: south/+Z)
  --music <mode>     voxel3d/rgbscreen: video audio → note-block music. auto | on | off (default:
                       auto = include note blocks iff the input video has an audio track)
  --instrument <i>   note-block instrument for the music (default: harp). One of:
                       harp bass basedrum snare hat bell flute chime guitar xylophone
                       iron_xylophone cow_bell didgeridoo bit banjo pling
  --music-origin <x,y,z>  where the note-block music area spawns (default: beside the build)
  --music-engine <e> how the note blocks play. playsound | redstone (default: playsound).
                       playsound = a tick-driven /playsound clock strikes them. redstone =
                       a physical repeater delay-line powers the note blocks themselves, so
                       the build literally plays the song (rising-edge trigger).
  --max-notes <n>    music: cap on emitted notes (default: 1500 playsound / 800 redstone).
                       A full-length song wants more, e.g. --max-notes 8000
  --rgb-levels <n>   rgbscreen: posterize levels per channel so codec noise doesn't bloat the
                       per-frame deltas (default: 32; 0 = exact 8-bit source color)
  --px-scale <x,y>   rgbscreen: per-pixel quad scale of the text_display background
                       (default 6.667,4 ≈ a 1×1 block pixel; tune if your client shows seams)
  --version <ver>    target Minecraft version: 1.21 .. 1.21.11, 26.1, 26.2 (default: 1.21).
                       Sets pack_format / DataVersion / block stamps. Java datapacks
                       also declare supported_formats so one pack loads across the
                       whole 1.21.x line; Bedrock packs use a 1.21.0 floor (forward-compatible).
  --out <path>       output directory (default: ./out/<target>)
  -h, --help
`;

const TARGETS = new Set<RenderTarget>([
  "map",
  "mcstructure",
  "mcstructure3d",
  "datapack",
  "behaviorpack",
  "bedrock-script",
  "mwframes",
  "voxel3d",
  "model3d",
  "rgbscreen",
]);
const DITHERS = new Set<DitherMethod>(["floyd-steinberg", "bayer", "none"]);

/** Shared --grid shape check for BOTH verbs: "WxH" with positive integers (e.g. 128x128).
 *  preview used to parseInt with no validation, so `--grid abc` flowed to ffmpeg as scale=NaN:NaN. */
function parseGrid(raw: string): { width: number; height: number } | null {
  const m = /^(\d+)x(\d+)$/.exec(raw);
  if (!m) return null;
  const width = parseInt(m[1]!, 10);
  const height = parseInt(m[2]!, 10);
  return width > 0 && height > 0 ? { width, height } : null;
}

export function runCli(argv: string[]): number {
  const { values, positionals } = parseArgs({
    // let a negative --origin (e.g. -50,70,-50) through node's parseArgs (it else errors "ambiguous")
    args: joinDashValues(argv, new Set(["flat", "wall", "led", "help"])),
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
      depth: { type: "string" },
      smooth: { type: "string" },
      curve: { type: "string" },
      shading: { type: "string" },
      flat: { type: "boolean" },
      wall: { type: "boolean" },
      led: { type: "boolean" },
      "cushion-mosaic": { type: "boolean" },
      "max-notes": { type: "string" },
      "rgb-levels": { type: "string" },
      "px-scale": { type: "string" },
      animate: { type: "string" },
      "animate-frames": { type: "string" },
      origin: { type: "string" },
      facing: { type: "string" },
      music: { type: "string" },
      instrument: { type: "string" },
      "music-origin": { type: "string" },
      "music-engine": { type: "string" },
      version: { type: "string" },
      out: { type: "string" },
      palette: { type: "string" },
      gamut: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });

  const verb = positionals[0];
  if (values.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  // Usage errors name the actual mistake on stderr before the USAGE dump - a bare wall of help
  // text left the user to diff their invocation against it by eye (exit code unchanged: 1).
  if (verb !== "render" && verb !== "preview") {
    process.stderr.write(
      verb === undefined
        ? `missing command: expected "render" or "preview"\n`
        : `unknown command "${verb}" (expected "render" or "preview")\n`,
    );
    process.stdout.write(USAGE);
    return 1;
  }
  if (!positionals[1]) {
    process.stderr.write(`missing <input> for ${verb} (e.g. blockdream ${verb} clip.gif)\n`);
    process.stdout.write(USAGE);
    return 1;
  }

  const input = positionals[1];

  // Numeric flags are validated at the parse boundary: a bad value must exit 2 with a message
  // naming the flag, never flow downstream as NaN. (A NaN --speed used to survive `?? default`
  // - NaN is not nullish - and reach the emitted datapack as `scoreboard players set #speed ma
  // NaN` with exit 0: silent corruption.) All bad flags are reported in one run.
  let badNumeric = false;
  const numFlag = (name: string, raw: string | undefined, what: string, ok: (n: number) => boolean): number | undefined => {
    if (raw === undefined) return undefined;
    const n = Number(raw);
    if (!Number.isFinite(n) || !ok(n)) {
      process.stderr.write(`--${name} must be ${what} (got "${raw}")\n`);
      badNumeric = true;
      return undefined;
    }
    return n;
  };
  const fps = numFlag("fps", values.fps, "a number > 0", (n) => n > 0);
  // >= 1, not >= 0: extract.ts treats a 0 cap as falsy, so `--max-frames 0` silently meant
  // NO cap at all (the exact opposite of what it says) instead of "zero frames".
  const maxFrames = numFlag("max-frames", values["max-frames"], "an integer >= 1", (n) => Number.isInteger(n) && n >= 1);
  const temporal = numFlag("temporal", values.temporal, "a non-negative number", (n) => n >= 0);
  const speedTicks = numFlag("speed", values.speed, "an integer >= 1 (ticks per frame)", (n) => Number.isInteger(n) && n >= 1);
  const depth = numFlag("depth", values.depth, "an integer >= 1", (n) => Number.isInteger(n) && n >= 1);
  const smooth = numFlag("smooth", values.smooth, "a number in 0..1", (n) => n >= 0 && n <= 1);
  const curve = numFlag("curve", values.curve, "a number > 0 (thickness exponent)", (n) => n > 0);
  const shading = numFlag("shading", values.shading, "a number in 0..1", (n) => n >= 0 && n <= 1);
  const gamut = numFlag("gamut", values.gamut, "a non-negative number", (n) => n >= 0);
  const animateFrames = numFlag("animate-frames", values["animate-frames"], "an integer >= 1", (n) => Number.isInteger(n) && n >= 1);
  if (badNumeric) return 2;

  // Validations shared by BOTH verbs run BEFORE the preview branch. preview used to return
  // early, so `preview x.png --dither bogus` silently rendered floyd-steinberg while the same
  // flag made render exit 2 - the two verbs must agree on what a bad flag is.
  const dither = values.dither as DitherMethod | undefined;
  if (dither && !DITHERS.has(dither)) {
    process.stderr.write(`unknown --dither ${dither}\n`);
    return 2;
  }
  // validate, don't coerce: `values.palette === "block" ? "block" : "map"` mapped typos to map
  const palette = values.palette as "map" | "block" | undefined;
  if (palette !== undefined && palette !== "map" && palette !== "block") {
    process.stderr.write(`unknown --palette ${values.palette} (valid: map | block)\n`);
    return 2;
  }
  try {
    resolveMcVersion(values.version); // unknown --version is a usage error for both verbs
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n`);
    return 2;
  }

  if (verb === "preview") {
    const out = values.out ?? "preview.png";
    let grid = 128;
    if (values.grid) {
      const g = parseGrid(values.grid); // same shape check as render - exit 2, not scale=NaN:NaN
      if (!g) {
        process.stderr.write(`--grid must be WxH (e.g. 128x128)\n`);
        return 2;
      }
      grid = g.width; // preview compares at a square grid: the WIDTH is the resolution
    }
    try {
      const png = previewPng(input, {
        grid,
        method: dither,
        palette,
        paletteVersion: values.version,
        gamutMap: gamut,
      });
      writeFileSync(out, png);
      process.stdout.write(`✓ preview (source | block-art) → ${out} (${png.length} bytes)\n`);
      return 0;
    } catch (e) {
      process.stderr.write(`✗ preview failed: ${(e as Error).message}\n`);
      return 1;
    }
  }
  const target = (values.target ?? "datapack") as RenderTarget;
  if (!TARGETS.has(target)) {
    process.stderr.write(`unknown --target ${target}\n`);
    return 2;
  }
  const edition = (values.edition ?? "java") as Edition;

  let width: number;
  let height: number;
  if (values.grid) {
    const g = parseGrid(values.grid);
    if (!g) {
      process.stderr.write(`--grid must be WxH (e.g. 128x128)\n`);
      return 2;
    }
    width = g.width;
    height = g.height;
  } else {
    width = target === "map" ? 128 : 64;
    height = target === "map" ? 128 : 64;
  }

  const animate = values.animate as BakeableAnimName | undefined;
  if (animate && !(BAKEABLE_ANIMS as ReadonlyArray<string>).includes(animate)) {
    process.stderr.write(`unknown --animate ${animate} (valid: ${BAKEABLE_ANIMS.join(" | ")})\n`);
    return 2;
  }

  let origin: { x: number; y: number; z: number } | undefined;
  if (values.origin) {
    const m = /^(-?\d+),(-?\d+),(-?\d+)$/.exec(values.origin);
    if (!m) {
      process.stderr.write(`--origin must be x,y,z integers (e.g. 10,64,-20)\n`);
      return 2;
    }
    origin = { x: parseInt(m[1]!, 10), y: parseInt(m[2]!, 10), z: parseInt(m[3]!, 10) };
  }

  const facing = values.facing as Facing | undefined;
  if (facing && !isFacing(facing)) {
    process.stderr.write(`unknown --facing ${facing} (valid: north | south | east | west)\n`);
    return 2;
  }

  const music = values.music as MusicMode | undefined;
  if (music && music !== "auto" && music !== "on" && music !== "off") {
    process.stderr.write(`unknown --music ${music} (valid: auto | on | off)\n`);
    return 2;
  }

  const instrument = values.instrument;
  // `!== undefined` (not a truthiness check) so an empty `--instrument=` is rejected too — otherwise
  // it would slip past and emit a broken `block.note_block.` / `instrument=` into the datapack.
  if (instrument !== undefined && !(NOTE_BLOCK_INSTRUMENTS as ReadonlyArray<string>).includes(instrument)) {
    process.stderr.write(`unknown --instrument "${instrument}" (valid: ${NOTE_BLOCK_INSTRUMENTS.join(" ")})\n`);
    return 2;
  }

  const musicEngine = values["music-engine"] as "playsound" | "redstone" | undefined;
  if (musicEngine !== undefined && musicEngine !== "playsound" && musicEngine !== "redstone") {
    process.stderr.write(`unknown --music-engine "${musicEngine}" (valid: playsound | redstone)\n`);
    return 2;
  }

  let musicOrigin: { x: number; y: number; z: number } | undefined;
  if (values["music-origin"]) {
    const m = /^(-?\d+),(-?\d+),(-?\d+)$/.exec(values["music-origin"]);
    if (!m) {
      process.stderr.write(`--music-origin must be x,y,z integers (e.g. 10,64,-20)\n`);
      return 2;
    }
    musicOrigin = { x: parseInt(m[1]!, 10), y: parseInt(m[2]!, 10), z: parseInt(m[3]!, 10) };
  }

  // Note-block music attaches to the voxel3d and rgbscreen datapacks (the targets whose
  // generators carry the sequencer). Warn rather than silently no-op elsewhere.
  if (
    (values.music || values.instrument || values["music-origin"] || values["music-engine"] || values["max-notes"]) &&
    target !== "voxel3d" &&
    target !== "rgbscreen"
  ) {
    process.stderr.write(`note: --music/--instrument/--music-origin/--music-engine/--max-notes apply only to --target voxel3d|rgbscreen (ignored for ${target})\n`);
  }
  if ((values.wall || values.led || values["cushion-mosaic"]) && target !== "voxel3d") {
    process.stderr.write(`note: --wall/--led/--cushion-mosaic apply only to --target voxel3d (ignored for ${target})\n`);
  }
  // --edition only branches the map-palette targets and the model3d exporter; everywhere else the
  // edition is fixed by the target itself (datapack = Java, behaviorpack/mcstructure = Bedrock).
  if (values.edition && target !== "map" && target !== "mwframes" && target !== "model3d") {
    process.stderr.write(`note: --edition applies only to --target map|mwframes|model3d (ignored for ${target})\n`);
  }
  const wants3dShape =
    values.depth !== undefined ||
    values.smooth !== undefined ||
    values.curve !== undefined ||
    values.shading !== undefined ||
    values.flat;
  if (wants3dShape && target !== "voxel3d" && target !== "mcstructure3d" && target !== "model3d") {
    process.stderr.write(`note: --depth/--smooth/--curve/--shading/--flat apply only to the 3D targets voxel3d|mcstructure3d|model3d (ignored for ${target})\n`);
  }
  if ((values["rgb-levels"] !== undefined || values["px-scale"] !== undefined) && target !== "rgbscreen") {
    process.stderr.write(`note: --rgb-levels/--px-scale apply only to --target rgbscreen (ignored for ${target})\n`);
  }

  const maxNotes = values["max-notes"] !== undefined ? Number(values["max-notes"]) : undefined;
  if (maxNotes !== undefined && (!Number.isFinite(maxNotes) || maxNotes < 0)) {
    process.stderr.write(`--max-notes must be a non-negative number\n`);
    return 2;
  }

  const rgbLevels = values["rgb-levels"] !== undefined ? Number(values["rgb-levels"]) : undefined;
  if (rgbLevels !== undefined && (!Number.isFinite(rgbLevels) || rgbLevels < 0)) {
    process.stderr.write(`--rgb-levels must be a non-negative number (0 = exact)\n`);
    return 2;
  }

  let pxScale: { x: number; y: number } | undefined;
  if (values["px-scale"]) {
    const m = /^([\d.]+),([\d.]+)$/.exec(values["px-scale"]);
    const sx = m ? Number(m[1]) : NaN;
    const sy = m ? Number(m[2]) : NaN;
    if (!m || !Number.isFinite(sx) || !Number.isFinite(sy) || sx <= 0 || sy <= 0) {
      process.stderr.write(`--px-scale must be two positive numbers x,y (e.g. 6.667,4)\n`);
      return 2;
    }
    pxScale = { x: sx, y: sy };
  }

  const opts: RenderOptions = {
    input,
    out: values.out ?? `./out/${target}`,
    target,
    edition,
    width,
    height,
    fps,
    maxFrames,
    dither,
    temporalThreshold: temporal,
    speedTicks,
    depth,
    smooth,
    curve,
    shading,
    symmetric: values.flat ? false : undefined,
    gamutMap: gamut,
    paletteVersion: values.version,
    animate,
    animateFrames,
    origin,
    facing,
    music,
    musicInstrument: instrument,
    musicOrigin,
    musicEngine,
    musicMaxNotes: maxNotes,
    wall: values.wall ? true : undefined,
    led: values.led ? true : undefined,
    cushionMosaic: values["cushion-mosaic"] ? true : undefined,
    rgbLevels,
    pxScale,
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
