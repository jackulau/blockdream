// Runnable NO-MOD live sidecar around the pure core in rcon-bridge.ts: connects a STOCK
// vanilla Minecraft server (RCON) to the local world-model WS server (ml serve.py) and
// paints each generated frame as a vertical solid-block wall near --origin - live, while
// the player walks around. No mod, no datapack, no client plugin: RCON is the transport.
//
//   RCON poll (`data get entity <p> Pos` / `Rotation`) → parsePosRotation → poseToAction
//   → WS {"type":"action",buttons[9],camera[2],skill} → {"type":"frame",png_b64:<RGB PNG>}
//   → ffmpeg PNG→rgb24 (scaled to --size) → frameToWallCommands → setblock/fill over RCON.
//
// All data transforms (pose parsing, action derivation, frame→commands with the
// {commands, remainder} carry contract) live in rcon-bridge.ts and are tested there;
// this file owns ONLY sockets, retry ladders, and the ONE-IN-FLIGHT pump (CPU generation
// is ~450 ms/frame - an action is sent only after the previous frame arrived, never queued).
//
// Resilience mirrors mods/java-fabric WorldModelClient.java: exponential backoff
// 1 s → 30 s cap for both sockets, reset to 1 s on success. A dead RCON client is dropped
// by its error/end handlers so the next send reconnects instead of hanging (rcon-client's
// own 2 s packet timeout rejects sends on a wedged socket).
//
//   npx tsx packages/cli/src/rcon-bridge-cli.ts --rcon-pass <pw>          # live
//   npx tsx packages/cli/src/rcon-bridge-cli.ts --mock-wm --dry-run --frames 2   # offline

import { parseArgs } from "node:util";
import WebSocket from "ws";
import { readFileSync } from "node:fs";
import { BAKEABLE_ANIMS, type BakeableAnimName } from "@blockdream/voxel";
import { runFfmpeg, ffmpegMissingMessage } from "@blockdream/video";
import type { RgbImage } from "@blockdream/color-core";
import {
  actionMessage,
  buildBoxSetupCommands,
  buildSetupCommands,
  buildToLiveFrames,
  videoBuildToLiveFrames,
  castImageFrames,
  frameToWallCommands,
  isParseError,
  isWallFacing,
  parsePosRotation,
  poseToAction,
  N_BUTTONS,
  type Action,
  type RconPose,
  type WallCommands,
  type WallFacing,
  type WallFrame,
} from "./rcon-bridge";
import { mockWorldModel } from "./control-sim";
import { RconPool } from "./rcon-pool";

const USAGE = `rcon-bridge - no-mod LIVE sidecar: vanilla server (RCON) ⇄ world-model (WS) ⇄ block wall

Usage: npx tsx packages/cli/src/rcon-bridge-cli.ts [options]

Polls the player's Pos/Rotation over RCON, derives a VPT-style action, steps the
world model (ml/src/blockdream_wm/serve.py), and paints each generated frame as a
vertical solid-block wall near --origin via setblock/fill - live, while the player
walks around a stock vanilla server.

Options:
  --rcon-host <h>     RCON host                          (default 127.0.0.1)
  --rcon-port <p>     RCON port                          (default 25575)
  --rcon-pass <pw>    RCON password - REQUIRED unless --dry-run
  --player <name>     player to follow (default: auto-detect via \`list\` when
                      exactly one player is online)
  --ws <url>          world-model WS server              (default ws://127.0.0.1:8765)
  --skill <s>         movement type sent to the WM       (default walk)
  --facing <dir>      direction the wall faces: north | south | east | west; orients the
                      paint plane (south = XY plane at z; east/west = ZY plane at x)
                                                          (default south)
  --image <path>      cast YOUR OWN image/animation (png/jpg/gif/mp4...) into the world
                      via RCON instead of the world model - paints at --origin/--facing,
                      no datapack/reload. A still = one paint; a GIF/video loops at --fps.
  --loops <n>         times to repeat an --image animation (<= 0 = endless)  (default 1)
  --build <path>      cast a 3D BUILD (image → voxels) into the world live via RCON -
                      setblock/fill at --origin/--facing, no datapack (vs --image's flat wall).
                      A VIDEO/GIF --build casts a real-content live 3D animation (each frame a build)
  --depth <n>         build thickness in voxels for --build               (default 16)
  --animate <anim>    animate a --build live: spin | explode | wave | buildup | ... -
                      streamed as a delta-encoded 3D animation at --fps, repeat with --loops
  --animate-frames <n>  frames in the baked --animate sequence            (default 24)
  --origin <x,y,z>    wall's bottom-left block           (default 10,-60,10 - on a 1.21
                      superflat the top grass block is y=-61 and players stand at
                      y=-60, so the wall base sits at ground level near spawn)
  --size <WxH>        wall size in blocks; WM frames are scaled to it (default 64x64,
                      matching the WM frame size)
  --fps <n>           poll/paint rate cap                (default 2)
  --rcon-conns <n>    parallel RCON connections used to paint a frame's commands; a
                      pool of N paints ~N× faster than serial (rcon-client serializes
                      one socket), so the sidecar stops being the paint bottleneck
                                                          (default 4)
  --max-commands <n>  RCON command budget per frame; overflow carries to the next
                      frame via the remainder contract   (default 256)
  --setup             before streaming, clear the wall volume + viewing space in the
                      RUNNING world via /fill (no datapack, no /reload). Drop-in: the
                      dream appears in-place wherever you point --origin
  --setup-clearance <n>  blocks of ±Z clearance carved around the wall by --setup
                                                          (default 3)
  --frames <n>        exit 0 after painting n frames     (default 0 = unlimited)
  --mock-wm           use control-sim's deterministic mock world model (no WS needed)
  --dry-run           implies --mock-wm AND skips RCON entirely: synthesizes a walking
                      pose and prints per-frame command counts without sending
  -h, --help          show this help
`;

const BACKOFF_INITIAL_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;
const FRAME_TIMEOUT_MS = 60_000; // generation is ~450 ms/frame on CPU, but cold starts lag

const log = (msg: string): void => console.log(`[rcon-bridge] ${msg}`);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// RCON transport is the pool in ./rcon-pool.ts (N parallel connections; `send` for pose
// polls, `sendBatch` to paint a frame's commands concurrently). Each pool connection owns the
// same lazy-connect + backoff + drop-dead-socket resilience the single manager used to have.

// ---------------------------------------------------------------------------
// World-model WS client: serve.py protocol, one-in-flight, backoff reconnect
// ---------------------------------------------------------------------------

class WmClient {
  /** True after every (re)connect: the server forks a FRESH session per connection,
   *  so the pump must send {"type":"reset"} (and repaint) before stepping again. */
  needsReset = true;

  private ws: WebSocket | null = null;
  private backoffMs = BACKOFF_INITIAL_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pending: {
    resolve: (png: Buffer) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;
  private stopped = false;

  constructor(private readonly url: string) {
    this.connect();
  }

  isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /**
   * ONE-IN-FLIGHT pump primitive: send one JSON message (reset or action - serve.py
   * replies to both with {"type":"frame"}), resolve with the frame's PNG bytes.
   * Rejects on server {"type":"error"}, socket loss, or timeout (which recycles the
   * socket through the backoff ladder so a wedged server can never hang the pump).
   */
  request(json: string): Promise<Buffer> {
    if (this.pending) return Promise.reject(new Error("a world-model request is already in flight"));
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error("world-model not connected"));
    return new Promise<Buffer>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.failPending(new Error(`no frame after ${FRAME_TIMEOUT_MS} ms - recycling the socket`));
        ws.terminate(); // close event follows → scheduleReconnect
      }, FRAME_TIMEOUT_MS);
      this.pending = { resolve, reject, timer };
      ws.send(json, (err) => {
        if (err) this.failPending(err instanceof Error ? err : new Error(String(err)));
      });
    });
  }

  close(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.failPending(new Error("world-model client closed"));
    this.ws?.close();
    this.ws = null;
  }

  private connect(): void {
    if (this.stopped) return;
    log(`world-model connecting: ${this.url}`);
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.on("open", () => {
      this.backoffMs = BACKOFF_INITIAL_MS; // healthy again - next outage starts the ladder over
      this.needsReset = true;
      log("world-model connected");
    });
    ws.on("message", (raw) => this.onMessage(raw));
    ws.on("error", (err: Error) => log(`world-model socket error: ${err.message}`)); // close follows
    ws.on("close", () => {
      if (this.ws === ws) this.ws = null;
      this.failPending(new Error("world-model socket closed"));
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, BACKOFF_MAX_MS);
    log(`world-model down - reconnecting in ${delay} ms (cap ${BACKOFF_MAX_MS} ms)`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private failPending(err: Error): void {
    const p = this.pending;
    if (!p) return;
    this.pending = null;
    clearTimeout(p.timer);
    p.reject(err);
  }

  private onMessage(raw: WebSocket.RawData): void {
    const text = Array.isArray(raw)
      ? Buffer.concat(raw).toString("utf8")
      : raw instanceof ArrayBuffer
        ? Buffer.from(raw).toString("utf8")
        : raw.toString("utf8");
    let msg: { type?: string; png_b64?: string; error?: string; message?: string };
    try {
      msg = JSON.parse(text) as typeof msg;
    } catch {
      log(`bad world-model message (not JSON): ${text.slice(0, 120)}`);
      return;
    }
    if (msg.type === "frame" && typeof msg.png_b64 === "string") {
      const p = this.pending;
      if (!p) return; // unsolicited frame - drop
      this.pending = null;
      clearTimeout(p.timer);
      p.resolve(Buffer.from(msg.png_b64, "base64"));
    } else if (msg.type === "error") {
      this.failPending(new Error(`world-model error: ${msg.error ?? msg.message ?? "unknown"}`));
    }
    // {"type":"ok"} (skill ack) - nothing pending on it; ignore
  }
}

// ---------------------------------------------------------------------------
// frame decode: serve.py sends base64 RGB PNG → rgb24 raw, scaled to the wall
// ---------------------------------------------------------------------------

/** Inverse of @blockdream/video's rgbToPng: PNG bytes → packed RGB at w×h (ffmpeg). */
function decodeFramePng(png: Buffer, w: number, h: number): RgbImage {
  const args = [
    "-v", "error",
    "-i", "pipe:0",
    "-frames:v", "1",
    "-vf", `scale=${w}:${h}:flags=area`,
    "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1",
  ];
  const { stdout, status, stderr } = runFfmpeg(args, 1 << 26, png);
  if (status !== 0 || stdout.length !== w * h * 3) {
    throw new Error(`frame decode failed (status ${status}, ${stdout.length} B for ${w}×${h}): ${stderr.slice(0, 200)}`);
  }
  return { width: w, height: h, data: new Uint8Array(stdout.buffer, stdout.byteOffset, stdout.length) };
}

/**
 * Decode a user's image FILE (any ffmpeg-readable format: png/jpg/webp, or a GIF/mp4/webm animation)
 * to one-or-more RGB frames scaled to w×h. A still image yields 1 frame; an animation yields N. This
 * backs `--image` - casting your OWN content into a running world (vs the world-model stream).
 */
function decodeImageFrames(path: string, w: number, h: number): RgbImage[] {
  const input = readFileSync(path);
  const args = [
    "-v", "error",
    "-i", "pipe:0",
    "-vf", `scale=${w}:${h}:flags=area`,
    "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1",
  ];
  const { stdout, status, stderr } = runFfmpeg(args, 1 << 28, input);
  const frameBytes = w * h * 3;
  if (status !== 0 || stdout.length === 0 || stdout.length % frameBytes !== 0) {
    throw new Error(`image decode failed (status ${status}, ${stdout.length} B, not a multiple of ${frameBytes} for ${w}×${h}): ${stderr.slice(0, 200)}`);
  }
  const n = stdout.length / frameBytes;
  const frames: RgbImage[] = [];
  for (let i = 0; i < n; i++) {
    frames.push({ width: w, height: h, data: new Uint8Array(stdout.buffer, stdout.byteOffset + i * frameBytes, frameBytes) });
  }
  return frames;
}

// ---------------------------------------------------------------------------
// player auto-detect: `list` → "There are 1 of a max of 20 players online: Steve"
// ---------------------------------------------------------------------------

async function detectPlayer(rcon: RconPool): Promise<string> {
  for (;;) {
    let reply: string;
    try {
      reply = await rcon.send("list");
    } catch (e) {
      log(`\`list\` failed (${e instanceof Error ? e.message : String(e)}) - retrying in 2 s`);
      await sleep(2_000);
      continue;
    }
    const names = (/:\s*(.*)$/.exec(reply.trim())?.[1] ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (names.length === 1) return names[0]!;
    if (names.length > 1) {
      throw new Error(`multiple players online (${names.join(", ")}) - pass --player <name>`);
    }
    log("no players online - waiting 2 s (join the server, or pass --player)");
    await sleep(2_000);
  }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

export async function main(argv: string[]): Promise<number> {
  let values: Record<string, string | boolean | undefined>;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        "rcon-host": { type: "string" },
        "rcon-port": { type: "string" },
        "rcon-pass": { type: "string" },
        player: { type: "string" },
        ws: { type: "string" },
        skill: { type: "string" },
        origin: { type: "string" },
        facing: { type: "string" },
        image: { type: "string" },
        build: { type: "string" },
        depth: { type: "string" },
        animate: { type: "string" },
        "animate-frames": { type: "string" },
        loops: { type: "string" },
        size: { type: "string" },
        fps: { type: "string" },
        "rcon-conns": { type: "string" },
        "max-commands": { type: "string" },
        setup: { type: "boolean" },
        "setup-clearance": { type: "string" },
        frames: { type: "string" },
        "mock-wm": { type: "boolean" },
        "dry-run": { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
    }));
  } catch (e) {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n\n${USAGE}`);
    return 2;
  }
  if (values["help"]) {
    process.stdout.write(USAGE);
    return 0;
  }

  const fail = (msg: string): number => {
    process.stderr.write(`${msg}\n\n${USAGE}`);
    return 2;
  };

  const dryRun = Boolean(values["dry-run"]);
  const mockWm = Boolean(values["mock-wm"]) || dryRun;
  const rconHost = (values["rcon-host"] as string | undefined) ?? "127.0.0.1";
  const rconPort = parseInt((values["rcon-port"] as string | undefined) ?? "25575", 10);
  const rconPass = values["rcon-pass"] as string | undefined;
  const wsUrl = (values["ws"] as string | undefined) ?? "ws://127.0.0.1:8765";
  const skill = (values["skill"] as string | undefined) ?? "walk";
  const facingArg = values["facing"] as string | undefined;
  if (facingArg && !isWallFacing(facingArg)) return fail(`--facing must be north|south|east|west`);
  const wallFacing: WallFacing = (facingArg as WallFacing | undefined) ?? "south";
  const imagePath = values["image"] as string | undefined; // cast a static image/animation, not the WM
  const imageLoops = parseInt((values["loops"] as string | undefined) ?? "1", 10);
  if (values["loops"] !== undefined && !Number.isInteger(imageLoops)) return fail(`--loops must be an integer (<= 0 = endless)`);
  const buildPath = values["build"] as string | undefined; // cast a 3D BUILD (image → voxels), not a flat wall
  const buildDepth = parseInt((values["depth"] as string | undefined) ?? "16", 10);
  if (values["depth"] !== undefined && (!Number.isInteger(buildDepth) || buildDepth < 1)) return fail(`--depth must be an integer >= 1`);
  if (imagePath && buildPath) return fail(`--image and --build are mutually exclusive (flat wall vs 3D build)`);
  const animateArg = values["animate"] as string | undefined; // bake a live 3D animation of the --build
  if (animateArg && !BAKEABLE_ANIMS.includes(animateArg as BakeableAnimName)) return fail(`--animate must be one of: ${BAKEABLE_ANIMS.join(", ")}`);
  if (animateArg && !buildPath) return fail(`--animate only applies to --build (the live 3D build)`);
  const buildAnimate = animateArg as BakeableAnimName | undefined;
  const animateFrames = parseInt((values["animate-frames"] as string | undefined) ?? "24", 10);
  if (values["animate-frames"] !== undefined && (!Number.isInteger(animateFrames) || animateFrames < 1)) return fail(`--animate-frames must be an integer >= 1`);
  const fps = Number((values["fps"] as string | undefined) ?? "2");
  const rconConns = parseInt((values["rcon-conns"] as string | undefined) ?? "4", 10);
  const maxCommands = parseInt((values["max-commands"] as string | undefined) ?? "256", 10);
  const maxFrames = parseInt((values["frames"] as string | undefined) ?? "0", 10);
  const doSetup = Boolean(values["setup"]);
  const setupClearance = parseInt((values["setup-clearance"] as string | undefined) ?? "3", 10);

  if (!Number.isInteger(rconPort) || rconPort <= 0) return fail(`bad --rcon-port`);
  if (!Number.isFinite(fps) || fps <= 0) return fail(`--fps must be > 0`);
  if (!Number.isInteger(rconConns) || rconConns < 1) return fail(`--rcon-conns must be ≥ 1`);
  if (!Number.isInteger(maxCommands) || maxCommands < 1) return fail(`--max-commands must be ≥ 1`);
  if (!Number.isInteger(setupClearance) || setupClearance < 0) return fail(`--setup-clearance must be ≥ 0`);
  if (!Number.isInteger(maxFrames) || maxFrames < 0) return fail(`--frames must be ≥ 0`);
  if (!dryRun && !rconPass) return fail(`--rcon-pass is required (omit only with --dry-run)`);

  const om = /^\s*(-?\d+)\s*,\s*(-?\d+)\s*,\s*(-?\d+)\s*$/.exec((values["origin"] as string | undefined) ?? "10,-60,10");
  if (!om) return fail(`--origin must be "x,y,z" integers (e.g. 10,-60,10)`);
  const origin = { x: parseInt(om[1]!, 10), y: parseInt(om[2]!, 10), z: parseInt(om[3]!, 10) };

  const sm = /^(\d+)x(\d+)$/.exec((values["size"] as string | undefined) ?? "64x64");
  if (!sm) return fail(`--size must be WxH (e.g. 64x64)`);
  const sizeW = parseInt(sm[1]!, 10);
  const sizeH = parseInt(sm[2]!, 10);
  if (sizeW < 1 || sizeH < 1) return fail(`--size must be ≥ 1x1`);
  if (mockWm && sizeW !== sizeH) return fail(`--mock-wm frames are square - use --size NxN`);

  log(
    `wall ${sizeW}×${sizeH} at (${origin.x},${origin.y},${origin.z}) skill=${skill} fps≤${fps} budget=${maxCommands} cmds/frame` +
      `${mockWm ? " [mock-wm]" : ` ws=${wsUrl}`}${dryRun ? " [dry-run: no RCON]" : ` rcon=${rconHost}:${rconPort} ×${rconConns} conns`}`,
  );

  let stopped = false;
  const rcon = dryRun ? null : new RconPool({ host: rconHost, port: rconPort, password: rconPass!, conns: rconConns, log });
  const wm = mockWm || imagePath || buildPath ? null : new WmClient(wsUrl); // --image/--build cast a file, not the WM stream

  process.once("SIGINT", () => {
    log("SIGINT - closing rcon + ws");
    stopped = true;
    wm?.close();
    if (rcon) void rcon.stop().finally(() => process.exit(130));
    else process.exit(130);
  });

  // ----- wall state: what is painted now, plus over-budget cells carried forward -----
  let prevWall: WallFrame | undefined; // undefined until the first paint → first frame is a keyframe
  let carry: WallCommands["remainder"] = [];
  let painted = 0;
  let lastPaintAt = 0;
  // honest, separated rates: gen = model produces a frame; paint = RCON writes it in-world;
  // effective = end-to-end frames/sec (includes the --fps cap sleep). Never conflate them.
  let genMsTotal = 0;
  let paintMsTotal = 0;
  let effMsTotal = 0;
  let effFrames = 0;
  const fmtFps = (ms: number): string => (ms > 0 ? (1000 / ms).toFixed(1) : "inf");

  const paint = async (rgb: RgbImage, genMs: number): Promise<void> => {
    const frame: WallFrame = { width: rgb.width, height: rgb.height, pixels: rgb.data };
    const keyframe = !prevWall;
    const wall = frameToWallCommands(frame, origin, prevWall, { carry, maxCommands, facing: wallFacing });
    const paintT0 = Date.now();
    if (!dryRun) {
      // pooled concurrent sends; a throw leaves prevWall/carry untouched so the next
      // delta (old prevWall → new frame) repaints everything this batch missed
      await rcon!.sendBatch(wall.commands);
    }
    const paintMs = Date.now() - paintT0;
    const now = Date.now();
    const effMs = lastPaintAt ? now - lastPaintAt : 0;
    lastPaintAt = now;
    prevWall = frame;
    carry = wall.remainder;
    painted++;
    genMsTotal += genMs;
    paintMsTotal += paintMs;
    if (effMs > 0) {
      effMsTotal += effMs;
      effFrames++;
    }
    log(
      `frame ${painted}${keyframe ? " (keyframe)" : ""}: ${wall.commands.length} cmds` +
        `${dryRun ? " (dry-run)" : ""}, ${wall.remainder.length} carried - ` +
        `gen ${fmtFps(genMs)} fps . paint ${fmtFps(paintMs)} fps . effective ${effMs ? fmtFps(effMs) : "-"} fps`,
    );
  };

  // ----- resolve the player (real RCON modes only; --image/--build paint at --origin, no player needed) -----
  let player = values["player"] as string | undefined;
  if (!dryRun && !player && !imagePath && !buildPath) {
    player = await detectPlayer(rcon!);
    log(`player auto-detected: ${player}`);
  }

  // ----- optional in-world setup: clear the wall + viewing space (no datapack/reload) -----
  // (--build does its OWN 3D build-box setup below; this flat-wall clear is for the WM stream / --image)
  if (doSetup && !buildPath) {
    const setupCmds = buildSetupCommands(origin, sizeW, sizeH, { clearance: setupClearance, facing: wallFacing });
    log(`setup: clearing wall slab + ${setupClearance}-block clearance (facing ${wallFacing}) in the running world (${setupCmds.length} /fill command(s), no datapack/reload)`);
    if (dryRun) {
      for (const c of setupCmds) log(`  setup> ${c}`);
    } else {
      await rcon!.sendBatch(setupCmds);
      log("setup: done - wall volume cleared");
    }
  }

  // ----- --image: cast a static image / animation into the world, then exit (no WM pump) -----
  if (imagePath) {
    let frames: RgbImage[];
    try {
      frames = decodeImageFrames(imagePath, sizeW, sizeH);
    } catch (e) {
      return fail(`${e instanceof Error ? e.message : String(e)}\n${ffmpegMissingMessage()}`);
    }
    log(
      `image cast: "${imagePath}" → ${frames.length} frame(s) at ${sizeW}×${sizeH}, ` +
        `origin ${origin.x},${origin.y},${origin.z} facing ${wallFacing}, loops ${imageLoops <= 0 ? "∞" : imageLoops}` +
        `${dryRun ? " [dry-run: no RCON]" : ""}`,
    );
    const n = await castImageFrames(frames, async (frame) => paint(frame, 0), {
      loops: imageLoops,
      fps,
      shouldStop: () => stopped,
    });
    log(`image cast: done - ${n} frame(s) painted`);
    await rcon?.stop();
    return 0;
  }

  // ----- --build: cast a 3D BUILD (image → voxels) into the world via RCON, then exit -----
  if (buildPath) {
    let decoded: RgbImage[];
    try {
      decoded = decodeImageFrames(buildPath, sizeW, sizeH);
    } catch (e) {
      return fail(`${e instanceof Error ? e.message : String(e)}\n${ffmpegMissingMessage()}`);
    }
    const wallFrames: WallFrame[] = decoded.map((f) => ({ width: f.width, height: f.height, pixels: f.data }));
    // a multi-frame input (video/GIF) is a REAL-CONTENT 3D animation (each frame its own build); a still
    // is static or a PROCEDURAL --animate of that one frame. The two animation sources are exclusive.
    const isVideo = wallFrames.length > 1;
    if (isVideo && buildAnimate) {
      return fail(`--animate (procedural) can't combine with a multi-frame --build (a video/GIF is already its own animation)`);
    }
    const { frameCommands, volume } = isVideo
      ? videoBuildToLiveFrames(wallFrames, origin, { depth: buildDepth, facing: wallFacing })
      : buildToLiveFrames(wallFrames[0]!, origin, { depth: buildDepth, facing: wallFacing, animate: buildAnimate, animateFrames });
    // --setup clears the build box; folding it into frame 0 means each loop re-clears, so a looping
    // animation wraps cleanly (no stale blocks from the previous pass).
    if (doSetup && frameCommands.length > 0) {
      frameCommands[0] = [...buildBoxSetupCommands(origin, volume), ...frameCommands[0]!];
    }
    const kind = isVideo ? `video ×${frameCommands.length} frames` : buildAnimate ? `${buildAnimate} ×${frameCommands.length} frames` : "static";
    log(
      `build cast: "${buildPath}" → ${volume.sx}×${volume.sy}×${volume.sz} build (depth ${buildDepth}) ${kind} ` +
        `at ${origin.x},${origin.y},${origin.z} facing ${wallFacing}${dryRun ? " [dry-run: no RCON]" : ""}`,
    );
    const looping = isVideo || buildAnimate;
    const painted = await castImageFrames(
      frameCommands,
      async (cmds, i) => {
        if (dryRun) {
          log(`  frame ${i}: ${cmds.length} cmd(s)${frameCommands.length === 1 ? "" : " (dry-run)"}`);
          if (frameCommands.length === 1) for (const c of cmds) log(`    ${c}`);
        } else {
          await rcon!.sendBatch(cmds);
        }
      },
      { loops: looping ? imageLoops : 1, fps, shouldStop: () => stopped },
    );
    log(`build cast: done - ${painted} frame(s) placed`);
    await rcon?.stop();
    return 0;
  }

  // ----- mock model state (keyframed inside the pump so a failed batch retries;
  //       real-WS mode keyframes via the post-connect reset instead) -----
  let mockPrev: RgbImage | null = null;
  const neutral: Action = { type: "action", buttons: new Array<number>(N_BUTTONS).fill(0), camera: [0, 0], skill };

  // ----- the pump: poll pose → derive action → step the model → paint, ≤ fps -----
  let lastPose: RconPose | null = null;
  let lastPoseAt = 0;
  const period = 1000 / fps;
  // dry-run synthesizes a player walking forward (+Z at yaw 0) with a slow pan:
  // ~0.13 m/tick at 2 fps (walking pace) and 0.5°/tick of yaw
  let dryPose: RconPose = { x: origin.x + 0.5, y: origin.y, z: origin.z + 8.5, yaw: 0, pitch: 0 };
  if (dryRun) {
    lastPose = dryPose;
    lastPoseAt = Date.now() - period;
  }

  while (!stopped && (maxFrames === 0 || painted < maxFrames)) {
    const t0 = Date.now();
    try {
      if (wm && !wm.isOpen()) {
        // the backoff ladder is reconnecting in the background - idle this cycle
      } else if (wm?.needsReset) {
        const genT0 = Date.now();
        const png = await wm.request(JSON.stringify({ type: "reset", skill }));
        const rgb = decodeFramePng(png, sizeW, sizeH);
        const genMs = Date.now() - genT0;
        wm.needsReset = false;
        log(`world-model session reset (skill=${skill})`);
        await paint(rgb, genMs);
      } else if (mockWm && painted === 0) {
        // mock keyframe: paint the initial neutral frame (retried until the batch lands)
        const genT0 = Date.now();
        mockPrev = mockWorldModel(null, neutral, sizeW);
        await paint(mockPrev, Date.now() - genT0);
      } else {
        let pose: RconPose | null = null;
        if (dryRun) {
          dryPose = { ...dryPose, z: dryPose.z + 1.3, yaw: dryPose.yaw + 5 };
          pose = dryPose;
        } else {
          const parsed = parsePosRotation(
            `${await rcon!.send(`data get entity ${player} Pos`)}\n` +
              `${await rcon!.send(`data get entity ${player} Rotation`)}`,
          );
          if (isParseError(parsed)) log(`pose parse failed - skipping cycle: ${parsed.error}`);
          else pose = parsed;
        }
        if (pose) {
          if (lastPose) {
            const action = poseToAction(lastPose, pose, t0 - lastPoseAt, skill);
            const genT0 = Date.now();
            const rgb = wm
              ? decodeFramePng(await wm.request(actionMessage(action)), sizeW, sizeH)
              : (mockPrev = mockWorldModel(mockPrev, action, sizeW));
            await paint(rgb, Date.now() - genT0);
          }
          lastPose = pose;
          lastPoseAt = t0;
        }
      }
    } catch (e) {
      log(`cycle error (skipping): ${e instanceof Error ? e.message : String(e)}`);
    }
    const elapsed = Date.now() - t0;
    if (elapsed < period) await sleep(period - elapsed);
  }

  log(`done: ${painted} frame(s) painted`);
  if (painted > 0) {
    const avgFps = (totalMs: number, n: number): string => (n > 0 && totalMs > 0 ? (1000 / (totalMs / n)).toFixed(1) : "-");
    // gen is the honest mod-free content ceiling (the AR model is ~2 fps on CPU); paint is the
    // RCON write cost the pool drove down; effective is what the player actually sees in-world.
    log(
      `fps summary - gen ${avgFps(genMsTotal, painted)} . paint ${avgFps(paintMsTotal, painted)} . ` +
        `effective ${avgFps(effMsTotal, effFrames)} (mean over ${painted} frame(s)` +
        `${dryRun ? "; dry-run paints nothing" : ""})`,
    );
  }
  wm?.close();
  await rcon?.stop();
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(`[rcon-bridge] fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    process.exit(1);
  },
);
