import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  getJavaMapPalette,
  getBedrockMapPalette,
  getSolidBlockMapPalette,
  resolveMcVersion,
  JAVA_DATAPACK_SUPPORTED,
  BEDROCK_BLOCK_VERSION,
} from "@blockdream/palette";
import { cushionMosaicCommands } from "@blockdream/palette/cushions";
import {
  preparePalette,
  quantizeFrame,
  quantizeVideo,
  buildRgbLut,
  nearestSrgbHue,
  type DitherMethod,
  type QuantizedFrame,
  type PreparedPalette,
} from "@blockdream/color-core";
import { extractFrames, extractAudioPcm } from "@blockdream/video";
import { analyzeAudio, type NoteEvent } from "@blockdream/audio";
import { buildMapDat, splitIntoMaps, buildFramePool, MAP_DIM } from "@blockdream/emit-java";
import { buildMcStructure, buildVoxelMcStructure } from "@blockdream/emit-bedrock";
import { generateJavaDatapack, generateVoxelDatapack, generateRgbScreenDatapack, rgbImageToScreenFrame, greedyBoxes, packageJavaDatapack, packageMcpack, makeBlockResolver, resolveSolidBlockId, solidBlockByMapColorId, planTickPlayback } from "@blockdream/emit-commands";
import { framesToAnimated3d, framesToFlat3d, objToVolume, gltfToFrames, glbToFrames, countSolid, generateBaked, rotateYQuarterTurns, BAKEABLE_ANIMS, SEQUENCE_ANIMS, type BakeableAnimName, type VoxelVolume } from "@blockdream/voxel";
import {
  generateBedrockBehaviorPack,
  generateBedrockScriptAddon,
  writePack,
} from "@blockdream/emit-commands/node";

export type RenderTarget =
  | "map"
  | "mcstructure"
  | "mcstructure3d"
  | "datapack"
  | "behaviorpack"
  | "bedrock-script"
  | "mwframes"
  | "voxel3d"
  | "model3d"
  | "rgbscreen";
export type Edition = "java" | "bedrock";

export interface RenderOptions {
  input: string;
  out: string;
  target: RenderTarget;
  width: number;
  height: number;
  edition?: Edition;
  fps?: number;
  maxFrames?: number;
  dither?: DitherMethod;
  temporalThreshold?: number;
  speedTicks?: number;
  paletteVersion?: string;
  depth?: number; // voxel3d/model3d: max build depth / resolution in blocks (default 8)
  smooth?: number; // 3D video: temporal depth smoothing 0..1 (default 0.35)
  curve?: number; // 3D: thickness curve exponent (default 0.5)
  shading?: number; // 3D: shape-from-shading gain 0..1 (luminance carves internal relief; default 0.5; 0 = off)
  symmetric?: boolean; // 3D: centered double-sided solid (default true); false = one-sided relief
  gamutMap?: number; // quantizer hue-rigidity lambda for out-of-gamut colours (keeps source hue)
  animate?: BakeableAnimName; // 3D: baked block-motion of the built solid (explode/wave/buildup/spin)
  animateFrames?: number; // frames for the procedural animation (default 24)
  origin?: { x: number; y: number; z: number }; // 3D build spawn coordinates in-world (datapack; default 0,64,0)
  facing?: Facing; // 3D build orientation: which way the build faces (north|south|east|west; default south/+Z)
  music?: MusicMode; // voxel3d: video audio → note-block music (auto = on iff the input has an audio track)
  musicInstrument?: string; // note-block instrument for the music (default harp)
  musicOrigin?: { x: number; y: number; z: number }; // where the note-block music area spawns (default beside the build)
  musicEngine?: "playsound" | "redstone"; // voxel3d: "playsound" clock (default) or a physical "redstone" delay-line that plays the note blocks
  musicMaxNotes?: number; // cap on emitted music notes (default 1500 playsound / 800 redstone); raise for a full-length song
  wall?: boolean; // voxel3d: FAITHFUL flat video wall (framesToFlat3d, background included) instead of the subject-relief pipeline
  led?: boolean; // voxel3d: invisible minecraft:light[level=15] plane fronting the build face — the wall glows like an LED screen
  cushionMosaic?: boolean; // voxel3d, EXPERIMENTAL (26.3 SNAPSHOT ONLY): also emit frame 0 as a top-down cushion-entity floor mosaic
  rgbLevels?: number; // rgbscreen: posterize levels per channel for delta stability (default 32; 0 = exact 8-bit)
  pxScale?: { x: number; y: number }; // rgbscreen: per-pixel text_display quad scale override
}

/** Note-block music inclusion for a video import. auto = on iff the input carries audio. */
export type MusicMode = "auto" | "on" | "off";

/**
 * Decode + transcribe the input's audio track into a Minecraft note-block timeline,
 * honouring the --music mode. Returns undefined when music is off, the input has no
 * audio, or nothing voiced was detected. Shells ffmpeg (CLI-only path).
 */
function analyzeMusicForInput(opts: RenderOptions): NoteEvent[] | undefined {
  const mode: MusicMode = opts.music ?? "auto";
  if (mode === "off") return undefined;
  // extractAudioPcm returns empty PCM when the input has no audio track, so a single extract serves
  // BOTH `auto` (include iff audio present) and `on` (force; an audio-less input simply yields none) —
  // no separate hasAudioTrack probe needed (avoids a redundant ffmpeg shell-out).
  const { pcm, sampleRate } = extractAudioPcm(opts.input);
  if (pcm.length === 0) return undefined;
  // `|| "harp"` (not `??`) so an empty-string instrument also falls back, never emitting a broken
  // `block.note_block.` / `instrument=` into the datapack.
  const events = analyzeAudio(pcm, sampleRate, { instrument: opts.musicInstrument || "harp" });
  return events.length ? events : undefined;
}

/** Compass direction a 3D build faces. south = +Z = the un-rotated default. */
export type Facing = "north" | "south" | "east" | "west";
const FACINGS: ReadonlySet<string> = new Set(["north", "south", "east", "west"]);
export function isFacing(s: string): s is Facing {
  return FACINGS.has(s);
}
// south is the native +Z orientation (no rotation); each step is one +90° yaw quarter-turn.
const FACING_QUARTER_TURNS: Record<Facing, number> = { south: 0, west: 1, north: 2, east: 3 };

/** Rotate a built volume sequence to face `facing` (an exact, lossless static yaw). No-op for south. */
function applyFacing(volumes: VoxelVolume[], facing: Facing | undefined): VoxelVolume[] {
  if (!facing || facing === "south") return volumes;
  const turns = FACING_QUARTER_TURNS[facing];
  return volumes.map((v) => rotateYQuarterTurns(v, turns));
}

export { BAKEABLE_ANIMS, SEQUENCE_ANIMS };

/** When `--animate` is set, turn the FIRST built 3D solid into a baked block-motion sequence
 *  (explode/wave/buildup/spin). Predictable everywhere: a still image, a static mesh, or the first
 *  frame of a clip all become the SAME kind of animated build. No-op when --animate is absent. */
function applyAnimate(volumes: VoxelVolume[], opts: RenderOptions): VoxelVolume[] {
  if (!opts.animate || volumes.length === 0) return volumes;
  return generateBaked(opts.animate, volumes[0]!, opts.animateFrames ?? 24);
}

export interface RenderResult {
  target: RenderTarget;
  frameCount: number;
  width: number;
  height: number;
  filesWritten: string[];
  notes: string[];
}

function writeFile(path: string, data: Buffer | string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, data);
}

/** Loader notes bundled into a 3D datapack zip (Minecraft ignores the .txt). Mirrors the web export,
 *  including the force-clear warning the CLI zip previously lacked. */
function howToLoad3d(namespace: string, sx: number, sy: number, sz: number): string {
  return [
    `blockdream 3D build — how to load`,
    ``,
    `1. Drop ${namespace}.zip into your world's  datapacks/  folder (or unzip it there).`,
    `2. In game: /reload`,
    `3. /function ${namespace}:setup    then    /function ${namespace}:start`,
    ``,
    `WARNING: setup force-CLEARS a ${sx}×${sy}×${sz} box at x=0 y=64 z=0 (fill ... air) before building.`,
    `Run it somewhere safe (a flat/empty area), not on top of anything you want to keep.`,
    `Stop with /function ${namespace}:stop (frees the force-loaded chunks).`,
  ].join("\n") + "\n";
}

/** Guard against a silent empty 3D build (degenerate input: a solid-colour / fully-transparent image
 *  yields zero voxels). Throws a clear error rather than writing a valid-but-empty datapack. */
function assertNonEmpty3d(volumes: VoxelVolume[]): void {
  if (volumes.length === 0 || volumes.every((v) => countSolid(v) === 0)) {
    throw new Error(
      "no subject detected: the input produced an empty 3D build (try a clearer subject/background, " +
        "a non-zero --depth, or check the image isn't a single flat colour)",
    );
  }
}

function quantizeAll(
  frames: import("@blockdream/color-core").RgbImage[],
  pal: PreparedPalette,
  dither: DitherMethod,
  temporalThreshold: number | undefined,
  gamutMap?: number,
): QuantizedFrame[] {
  if (frames.length <= 1) {
    // single still → exact OKLab match (best quality)
    return frames.map((f) => quantizeFrame(f, pal, { method: dither, gamutMap }));
  }
  // video → prebuilt LUT for O(1)/pixel matching (≈20× faster, imperceptible penalty)
  const lut = buildRgbLut(pal);
  return quantizeVideo(frames, pal, { method: dither, temporalThreshold, lut, gamutMap });
}

/**
 * End-to-end render: decode input → quantize → emit artifacts for the chosen
 * target. Returns the list of files written. Pure enough to unit-test (writes
 * to `out`, no process state).
 */
export function render(opts: RenderOptions): RenderResult {
  const edition: Edition = opts.edition ?? "java";
  // Resolve the target MC version once → format stamps for every emitted artifact.
  // Throws a helpful error for an unsupported version (vs. a deep ENOENT later).
  const mc = resolveMcVersion(opts.paletteVersion);
  const notes: string[] = [];
  const filesWritten: string[] = [];

  // model3d: voxelize a real 3D MODEL (.obj/.gltf/.glb) into Minecraft blocks. Handled BEFORE
  // extractFrames (which decodes images/video, not meshes). Per-triangle colour is matched to the
  // solid palette via OKLab+hue (the model-import + colour path that was unreachable from the CLI).
  if (opts.target === "model3d") {
    const { palette } = getSolidBlockMapPalette(opts.paletteVersion);
    const pal = preparePalette(palette);
    const matchColor = (r: number, g: number, b: number) => nearestSrgbHue(r, g, b, pal).color.mapColorId;
    const resolveBlock = makeBlockResolver(opts.paletteVersion);
    const solidIds = solidBlockByMapColorId();
    const resolveMcStructureBlock = (id: number) => {
      const name = resolveSolidBlockId(solidIds, id);
      return name ? { name, states: {} } : undefined;
    };
    const resolution = Math.max(2, opts.width); // width = cube grid resolution for models
    const lower = opts.input.toLowerCase();
    let volumes: VoxelVolume[];
    if (lower.endsWith(".glb")) {
      const buf = readFileSync(opts.input);
      const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
      volumes = glbToFrames(ab, { resolution, solid: true, matchColor });
    } else if (lower.endsWith(".gltf")) {
      volumes = gltfToFrames(readFileSync(opts.input, "utf8"), { resolution, solid: true, matchColor });
    } else {
      volumes = [objToVolume(readFileSync(opts.input, "utf8"), { resolution, solid: true, matchColor })];
    }
    assertNonEmpty3d(volumes);
    volumes = applyAnimate(volumes, opts); // --animate: procedural block-motion of the built model
    volumes = applyFacing(volumes, opts.facing); // --facing: orient the build (static yaw)
    if (edition === "bedrock") {
      volumes.forEach((vol, fi) => {
        const buf = buildVoxelMcStructure(vol, resolveMcStructureBlock, { blockVersion: BEDROCK_BLOCK_VERSION, origin: opts.origin });
        const path = join(opts.out, volumes.length > 1 ? `model_${fi}.mcstructure` : `model3d.mcstructure`);
        writeFile(path, buf);
        filesWritten.push(path);
      });
      const v0 = volumes[0]!;
      notes.push(`3D model → Bedrock .mcstructure (${volumes.length} frame(s), ${v0.sx}×${v0.sy}×${v0.sz}); place with a structure block.`);
    } else {
      const pack = generateVoxelDatapack(volumes, resolveBlock, {
        namespace: "blockdream_model", packFormat: mc.packFormat, origin: opts.origin,
        supportedFormats: JAVA_DATAPACK_SUPPORTED, optimize: (cells, r) => greedyBoxes(cells, r),
      });
      const mv = volumes[0]!;
      pack.files.set("HOW_TO_LOAD.txt", howToLoad3d(pack.namespace, mv.sx, mv.sy, mv.sz));
      writePack(pack, opts.out);
      filesWritten.push(...[...pack.files.keys()].map((k) => join(opts.out, k)));
      const zip = join(opts.out, `${pack.namespace}.zip`);
      writeFile(zip, Buffer.from(packageJavaDatapack(pack)));
      filesWritten.push(zip);
      notes.push(`3D model → vanilla datapack (${volumes.length} frame(s), ${pack.totalCommands ?? pack.totalSetblocks} cmds): drop ${pack.namespace}.zip into world/datapacks/, /function ${pack.namespace}:setup then :start.`);
    }
    const v0 = volumes[0]!;
    return { target: opts.target, frameCount: volumes.length, width: v0.sx, height: v0.sy, filesWritten, notes };
  }

  const rawFrames = extractFrames(opts.input, {
    width: opts.width,
    height: opts.height,
    fps: opts.fps,
    maxFrames: opts.maxFrames,
  });
  if (rawFrames.length === 0) throw new Error("no frames decoded from input");
  // Minecraft executes one animation step per game tick (20 tps), so a >20 fps decode can never
  // play 1:1 - speedTicks floors at 1 and the pack would silently run slow (30 fps → 1.5x the
  // source duration) and drift against the real-time music clock. Resample evenly to the ceiling
  // (identical algorithm to the web exporter via the shared planTickPlayback) so duration is
  // preserved and frames are skipped instead. Explicit --speed opts out: raw pacing requested.
  let frames = rawFrames;
  if (rawFrames.length > 1 && opts.speedTicks == null && opts.fps != null && opts.fps > 20) {
    const plan = planTickPlayback(rawFrames.length, rawFrames.map(() => 1000 / opts.fps!));
    if (plan.resampled) {
      frames = plan.indices.map((i) => rawFrames[i]!);
      notes.push(
        `--fps ${opts.fps} is above Minecraft's 20 fps in-game ceiling (1 frame per game tick): ` +
          `resampled ${rawFrames.length} → ${frames.length} frames at 20 fps (same duration, frames skipped evenly).`,
      );
    }
  }
  const isVideo = frames.length > 1;
  // default dither: video → bayer (temporally stable), still → floyd-steinberg
  const dither: DitherMethod = opts.dither ?? (isVideo ? "bayer" : "floyd-steinberg");
  // Playback pace when --speed is NOT given: match the decode fps (1 game tick = 50 ms), so
  // --fps 20 plays real-time at 1 tick/frame and --fps 10 keeps the historical 2. Without this,
  // every fps other than 10 silently played at the wrong wall-clock rate - and drifted against
  // the note-block music, whose clock is real time. Explicit --speed always wins; no --fps
  // (source-rate stills/models) keeps the emitters' documented default of 2. Above 20 fps the
  // resample block earlier already reduced the clip to the 20 fps ceiling, so the floor of 1
  // tick/frame here is exact, not a silent slowdown.
  const speedTicksAuto = opts.speedTicks ?? (opts.fps && opts.fps > 0 ? Math.max(1, Math.round(20 / opts.fps)) : undefined);

  if (opts.target === "rgbscreen") {
    // TRUE-RGB screen: exact source colors on a text_display pixel grid — NO palette, NO
    // quantization, NO dither. Vanilla has no RGB block (checked through the 2026 drops), but a
    // text_display background is a full ARGB int, and the grid plays back with the same
    // scoreboard+macro machinery as the block walls. Full-bright by construction (LED look).
    const screenFrames = frames.map((f) => rgbImageToScreenFrame(f, opts.rgbLevels ?? 32));
    const music = analyzeMusicForInput(opts);
    const pack = generateRgbScreenDatapack(screenFrames, {
      packFormat: mc.packFormat,
      supportedFormats: JAVA_DATAPACK_SUPPORTED,
      dataVersion: mc.dataVersion,
      origin: opts.origin,
      facing: opts.facing,
      speedTicks: speedTicksAuto,
      pxScale: opts.pxScale,
      music,
      musicOrigin: opts.musicOrigin,
      musicEngine: opts.musicEngine,
      musicMaxNotes: opts.musicMaxNotes,
    });
    pack.files.set(
      "HOW_TO_LOAD.txt",
      [
        `blockdream TRUE-RGB screen — how to load`,
        ``,
        `1. Drop ${pack.namespace}.zip into your world's  datapacks/  folder (or unzip it there).`,
        `2. In game: /reload`,
        `3. /function ${pack.namespace}:setup    then    /function ${pack.namespace}:start`,
        ``,
        `The screen is ${opts.width}x${opts.height} = ${opts.width * opts.height} text_display entities`,
        `(exact RGB pixels, full-bright). Pause with :stop; REMOVE it with /function ${pack.namespace}:teardown`,
        `(the entities persist in the world save until torn down).`,
        `Pixel quads not perfectly flush on your client? Re-render with --px-scale to tune.`,
      ].join("\n") + "\n",
    );
    if (music?.length) {
      const cap = opts.musicMaxNotes ?? (opts.musicEngine === "redstone" ? 800 : 1500);
      notes.push(
        `note-block music: ${Math.min(music.length, cap)} notes from the audio track` +
          (music.length > cap ? ` (capped from ${music.length}; raise --max-notes for the full song)` : "") +
          `; plays on /function ${pack.namespace}:start.`,
      );
    }
    writePack(pack, opts.out);
    filesWritten.push(...[...pack.files.keys()].map((k) => join(opts.out, k)));
    const zip = join(opts.out, `${pack.namespace}.zip`);
    writeFile(zip, Buffer.from(packageJavaDatapack(pack)));
    filesWritten.push(zip);
    notes.push(
      `TRUE-RGB screen datapack (${opts.width}x${opts.height} px, ${screenFrames.length} frame(s), ${pack.totalCommands} delta cmds): drop ${pack.namespace}.zip into world/datapacks/, /function ${pack.namespace}:setup then :start. Teardown with :teardown.`,
    );
    return { target: opts.target, frameCount: screenFrames.length, width: opts.width, height: opts.height, filesWritten, notes };
  }

  if (opts.target === "map") {
    const mapPal =
      edition === "bedrock"
        ? getBedrockMapPalette(opts.paletteVersion)
        : getJavaMapPalette(opts.paletteVersion);
    const pal = preparePalette(mapPal);
    const q = quantizeAll(frames, pal, dither, opts.temporalThreshold, opts.gamutMap);
    if (opts.width % MAP_DIM !== 0 || opts.height % MAP_DIM !== 0) {
      throw new Error(`map target requires grid sizes that are multiples of ${MAP_DIM} (got ${opts.width}×${opts.height})`);
    }
    q.forEach((frame, fi) => {
      const tiles = splitIntoMaps(frame);
      for (const t of tiles) {
        const name = tiles.length > 1 ? `map_${fi}_c${t.col}_r${t.row}.dat` : `map_${fi}.dat`;
        const path = join(opts.out, name);
        writeFile(path, buildMapDat(t.frame, { dataVersion: mc.dataVersion }));
        filesWritten.push(path);
      }
    });
    notes.push(`${edition} filled-map .dat (${frames.length} frame(s), DataVersion ${mc.dataVersion}; older stamps auto-upgrade on load); load with an NBT/world tool or the datapack item-frame wall.`);
    return { target: opts.target, frameCount: frames.length, width: opts.width, height: opts.height, filesWritten, notes };
  }

  if (opts.target === "mwframes") {
    const mapPal =
      edition === "bedrock"
        ? getBedrockMapPalette(opts.paletteVersion)
        : getJavaMapPalette(opts.paletteVersion);
    const pal = preparePalette(mapPal);
    const q = quantizeAll(frames, pal, dither, opts.temporalThreshold, opts.gamutMap);
    if (opts.width % MAP_DIM !== 0 || opts.height % MAP_DIM !== 0) {
      throw new Error(`mwframes target requires grid sizes that are multiples of ${MAP_DIM}`);
    }
    const pool = buildFramePool(q, speedTicksAuto);
    const binPath = join(opts.out, "frames.bin");
    const mapsPath = join(opts.out, "maps.txt");
    writeFile(binPath, pool.bin);
    writeFile(mapsPath, pool.mapsTxtTemplate);
    filesWritten.push(binPath, mapsPath);
    notes.push(`Fabric map-wall pool (${pool.cols}×${pool.rows} maps, ${frames.length} frames). Edit maps.txt with real map ids; the mods/java-fabric mod plays it.`);
    return { target: opts.target, frameCount: frames.length, width: opts.width, height: opts.height, filesWritten, notes };
  }

  // block-based targets. Use the canonical shade-tolerant + air-aware resolver (block-resolver.ts) so
  // the CLI can't drift from the library and a non-+2 shade (4-shade palette / model import) never
  // silently drops to air. `solidIds` backs the mcstructure closures that need {name, states}.
  const { palette } = getSolidBlockMapPalette(opts.paletteVersion);
  const pal = preparePalette(palette);
  const q = quantizeAll(frames, pal, dither, opts.temporalThreshold, opts.gamutMap);
  const resolveBlock = makeBlockResolver(opts.paletteVersion);
  const solidIds = solidBlockByMapColorId();
  const resolveMcStructureBlock = (id: number) => {
    const name = resolveSolidBlockId(solidIds, id);
    return name ? { name, states: {} } : undefined;
  };

  if (opts.target === "voxel3d") {
    // video → temporally-stable animated 3D block build → vanilla datapack (delta-encoded, fill-batched)
    // --animate replaces the (video/still) sequence with procedural block-motion of the first solid.
    // shape-from-shading: per-pixel OKLab lightness of the quantized block carves internal relief into
    // the silhouette dome (a bright region bulges, a dark one recedes). On by default (gain 0.5).
    const shadingGain = opts.shading ?? 0.5;
    const shadingForFrame =
      shadingGain > 0
        ? (f: number, x: number, y: number) => pal.entries[q[f]!.paletteIndex[y * q[f]!.width + x]!]!.lab.L
        : undefined;
    // --wall: FAITHFUL flat video wall — every pixel becomes exactly one block, background
    // included (framesToFlat3d). The default pipeline instead isolates a subject and inflates
    // relief, which is right for photos but wrong for reproducing a whole video frame.
    let volumes = applyAnimate(
      opts.wall
        ? framesToFlat3d(q, { depth: 1 })
        : framesToAnimated3d(q, {
            maxDepth: opts.depth ?? 8,
            smooth: opts.smooth,
            curve: opts.curve,
            symmetric: opts.symmetric,
            shadingForFrame,
            shadingGain,
          }),
      opts,
    );
    assertNonEmpty3d(volumes);
    volumes = applyFacing(volumes, opts.facing); // --facing: orient the build (static yaw)
    // --music: if the video carries audio, transcribe it to a note-block music area + sequencer.
    const music = analyzeMusicForInput(opts);
    const pack = generateVoxelDatapack(volumes, resolveBlock, {
      namespace: "blockdream_3d",
      packFormat: mc.packFormat,
      origin: opts.origin,
      supportedFormats: JAVA_DATAPACK_SUPPORTED,
      optimize: (cells, r) => greedyBoxes(cells, r),
      speedTicks: speedTicksAuto,
      music,
      musicOrigin: opts.musicOrigin,
      musicEngine: opts.musicEngine,
      musicMaxNotes: opts.musicMaxNotes,
      // --led: glow plane one block outside the face the build looks toward (post-rotation)
      ledPlane: opts.led ? (opts.facing ?? "south") : undefined,
    });
    if (music?.length) {
      const engine =
        opts.musicEngine === "redstone"
          ? "a physical redstone delay-line plays the note blocks"
          : "a tick-driven playsound clock";
      const cap = opts.musicMaxNotes ?? (opts.musicEngine === "redstone" ? 800 : 1500);
      notes.push(
        `note-block music: ${Math.min(music.length, cap)} notes from the audio track` +
          (music.length > cap ? ` (capped from ${music.length}; raise --max-notes for the full song)` : "") +
          ` (instrument ${opts.musicInstrument ?? "harp"}; ${engine}); plays on /function ${pack.namespace}:start.`,
      );
    }
    const vv = volumes[0]!;
    pack.files.set("HOW_TO_LOAD.txt", howToLoad3d(pack.namespace, vv.sx, vv.sy, vv.sz));
    writePack(pack, opts.out);
    filesWritten.push(...[...pack.files.keys()].map((k) => join(opts.out, k)));
    const zip = join(opts.out, `${pack.namespace}.zip`);
    writeFile(zip, Buffer.from(packageJavaDatapack(pack)));
    filesWritten.push(zip);
    notes.push(
      `3D voxel datapack (${volumes.length} frame(s), ${pack.totalCommands ?? pack.totalSetblocks} cmds): drop ${pack.namespace}.zip into world/datapacks/, /function ${pack.namespace}:setup then :start.`,
    );
    if (opts.cushionMosaic) {
      // EXPERIMENTAL side artifact, never inside the datapack zip: cushions are 26.3-snapshot
      // ENTITIES (flat pads on floors, not blocks) - see docs/cushions-26.3.md. Passing the flag
      // IS the explicit experimental opt-in the generator requires.
      const mosaic = cushionMosaicCommands(frames[0]!, { experimental: true, origin: opts.origin });
      const mosaicPath = join(opts.out, "cushion_mosaic_frame0.mcfunction");
      writeFile(mosaicPath, mosaic.commands);
      filesWritten.push(mosaicPath);
      notes.push(
        `EXPERIMENTAL cushion floor mosaic (26.3 SNAPSHOT ONLY): frame 0 as ${mosaic.entityCount} summoned cushion entities` +
          (mosaic.truncated ? " (TRUNCATED at the entity cap)" : "") +
          ` - cushions are entities laid flat on floors, viewed from above; not blocks, no walls. docs/cushions-26.3.md.`,
      );
    }
    return { target: opts.target, frameCount: volumes.length, width: opts.width, height: opts.height, filesWritten, notes };
  }

  if (opts.target === "mcstructure") {
    q.forEach((frame, fi) => {
      const buf = buildMcStructure(frame, resolveMcStructureBlock, { blockVersion: BEDROCK_BLOCK_VERSION, origin: opts.origin });
      const path = join(opts.out, q.length > 1 ? `frame_${fi}.mcstructure` : `art.mcstructure`);
      writeFile(path, buf);
      filesWritten.push(path);
    });
    notes.push(`Bedrock .mcstructure (${frames.length} frame(s)); import with a structure block or world tool.`);
    return { target: opts.target, frameCount: frames.length, width: opts.width, height: opts.height, filesWritten, notes };
  }

  if (opts.target === "mcstructure3d") {
    // image/video → temporally-stable 3D volumes (same pipeline as voxel3d) → a TRUE 3D Bedrock
    // .mcstructure per frame (depth = volume depth, not the 1-thick wall of `mcstructure`)
    let volumes = applyAnimate(
      framesToAnimated3d(q, { maxDepth: opts.depth ?? 8, smooth: opts.smooth, curve: opts.curve, symmetric: opts.symmetric }),
      opts,
    );
    assertNonEmpty3d(volumes);
    volumes = applyFacing(volumes, opts.facing); // --facing: orient the build (static yaw)
    volumes.forEach((vol, fi) => {
      const buf = buildVoxelMcStructure(vol, resolveMcStructureBlock, { blockVersion: BEDROCK_BLOCK_VERSION, origin: opts.origin });
      const path = join(opts.out, volumes.length > 1 ? `frame_${fi}.mcstructure` : `model3d.mcstructure`);
      writeFile(path, buf);
      filesWritten.push(path);
    });
    const v0 = volumes[0]!;
    notes.push(
      `TRUE 3D Bedrock .mcstructure (${volumes.length} frame(s), ${v0.sx}×${v0.sy}×${v0.sz}); place with a structure block or import via a world tool.`,
    );
    return { target: opts.target, frameCount: volumes.length, width: opts.width, height: opts.height, filesWritten, notes };
  }

  if (opts.target === "bedrock-script") {
    const pack = generateBedrockScriptAddon(q, resolveBlock, { speedTicks: speedTicksAuto });
    writePack(pack, opts.out);
    filesWritten.push(...[...pack.files.keys()].map((k) => join(opts.out, k)));
    const mcpack = join(opts.out, "blockdream-script.mcpack");
    writeFile(mcpack, Buffer.from(packageMcpack(pack.files, { stripPrefix: "behavior_pack/" })));
    filesWritten.push(mcpack);
    notes.push(`Bedrock Script-API addon: double-click blockdream-script.mcpack to import, then in chat: !mw start.`);
    return { target: opts.target, frameCount: frames.length, width: opts.width, height: opts.height, filesWritten, notes };
  }

  if (opts.target === "datapack") {
    const pack = generateJavaDatapack(q, resolveBlock, {
      speedTicks: speedTicksAuto,
      packFormat: mc.packFormat,
      supportedFormats: JAVA_DATAPACK_SUPPORTED,
    });
    writePack(pack, opts.out);
    filesWritten.push(...[...pack.files.keys()].map((k) => join(opts.out, k)));
    const zip = join(opts.out, `${pack.namespace}.zip`);
    writeFile(zip, Buffer.from(packageJavaDatapack(pack)));
    filesWritten.push(zip);
    notes.push(`Vanilla Java datapack (pack_format ${mc.packFormat}; loads on MC ${JAVA_DATAPACK_SUPPORTED.min_inclusive}..${JAVA_DATAPACK_SUPPORTED.max_inclusive} via supported_formats): drop ${pack.namespace}.zip (or the folder) into world/datapacks/, run /function ${pack.namespace}:setup then /function ${pack.namespace}:start.`);
    return { target: opts.target, frameCount: frames.length, width: opts.width, height: opts.height, filesWritten, notes };
  }

  // behaviorpack
  const pack = generateBedrockBehaviorPack(q, resolveBlock, { speedTicks: speedTicksAuto });
  writePack(pack, opts.out);
  filesWritten.push(...[...pack.files.keys()].map((k) => join(opts.out, k)));
  const mcpack = join(opts.out, "blockdream.mcpack");
  writeFile(mcpack, Buffer.from(packageMcpack(pack.files)));
  filesWritten.push(mcpack);
  notes.push(`Vanilla Bedrock behavior pack: double-click blockdream.mcpack to import (or copy the folder to behavior_packs/), /function ${pack.namespace}/setup then /function ${pack.namespace}/start.`);
  return { target: opts.target, frameCount: frames.length, width: opts.width, height: opts.height, filesWritten, notes };
}
