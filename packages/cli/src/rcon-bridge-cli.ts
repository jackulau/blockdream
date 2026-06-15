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
import { Rcon } from "rcon-client";
import WebSocket from "ws";
import { runFfmpeg } from "@blockdream/video";
import type { RgbImage } from "@blockdream/color-core";
import {
  actionMessage,
  frameToWallCommands,
  isParseError,
  parsePosRotation,
  poseToAction,
  N_BUTTONS,
  type Action,
  type RconPose,
  type WallCommands,
  type WallFrame,
} from "./rcon-bridge";
import { mockWorldModel } from "./control-sim";

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
  --origin <x,y,z>    wall's bottom-left block           (default 10,-60,10 - on a 1.21
                      superflat the top grass block is y=-61 and players stand at
                      y=-60, so the wall base sits at ground level near spawn)
  --size <WxH>        wall size in blocks; WM frames are scaled to it (default 64x64,
                      matching the WM frame size)
  --fps <n>           poll/paint rate cap                (default 2)
  --max-commands <n>  RCON command budget per frame; overflow carries to the next
                      frame via the remainder contract   (default 256)
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

// ---------------------------------------------------------------------------
// RCON: lazy connect with retry/backoff; error/end handlers DROP the dead client
// (collect.mjs's lazy client lacks these - a dead socket there hangs every send)
// ---------------------------------------------------------------------------

class RconManager {
  private client: Rcon | null = null;
  private connecting: Promise<Rcon> | null = null;
  private backoffMs = BACKOFF_INITIAL_MS;
  private stopped = false;

  constructor(
    private readonly host: string,
    private readonly port: number,
    private readonly password: string,
  ) {}

  /** Send one command, (re)connecting with backoff first if needed. */
  async send(command: string): Promise<string> {
    const client = await this.ensure();
    return client.send(command);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    const c = this.client;
    this.client = null;
    if (c) await c.end().catch(() => {});
  }

  private async ensure(): Promise<Rcon> {
    while (!this.stopped) {
      if (this.client) return this.client;
      this.connecting ??= Rcon.connect({ host: this.host, port: this.port, password: this.password });
      try {
        const client = await this.connecting;
        this.connecting = null;
        const drop = (why: string): void => {
          if (this.client === client) {
            this.client = null;
            if (!this.stopped) log(`rcon connection lost (${why}) - reconnecting on next send`);
          }
        };
        client.on("error", (err) => drop(err instanceof Error ? err.message : String(err)));
        client.on("end", () => drop("closed"));
        this.client = client;
        this.backoffMs = BACKOFF_INITIAL_MS; // healthy again - next outage starts the ladder over
        log(`rcon connected: ${this.host}:${this.port}`);
        return client;
      } catch (e) {
        this.connecting = null;
        const delay = this.backoffMs;
        this.backoffMs = Math.min(this.backoffMs * 2, BACKOFF_MAX_MS);
        log(`rcon connect failed (${e instanceof Error ? e.message : String(e)}) - retrying in ${delay} ms (cap ${BACKOFF_MAX_MS} ms)`);
        await sleep(delay);
      }
    }
    throw new Error("rcon manager stopped");
  }
}

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

// ---------------------------------------------------------------------------
// player auto-detect: `list` → "There are 1 of a max of 20 players online: Steve"
// ---------------------------------------------------------------------------

async function detectPlayer(rcon: RconManager): Promise<string> {
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
        size: { type: "string" },
        fps: { type: "string" },
        "max-commands": { type: "string" },
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
  const fps = Number((values["fps"] as string | undefined) ?? "2");
  const maxCommands = parseInt((values["max-commands"] as string | undefined) ?? "256", 10);
  const maxFrames = parseInt((values["frames"] as string | undefined) ?? "0", 10);

  if (!Number.isInteger(rconPort) || rconPort <= 0) return fail(`bad --rcon-port`);
  if (!Number.isFinite(fps) || fps <= 0) return fail(`--fps must be > 0`);
  if (!Number.isInteger(maxCommands) || maxCommands < 1) return fail(`--max-commands must be ≥ 1`);
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
      `${mockWm ? " [mock-wm]" : ` ws=${wsUrl}`}${dryRun ? " [dry-run: no RCON]" : ` rcon=${rconHost}:${rconPort}`}`,
  );

  let stopped = false;
  const rcon = dryRun ? null : new RconManager(rconHost, rconPort, rconPass!);
  const wm = mockWm ? null : new WmClient(wsUrl);

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

  const paint = async (rgb: RgbImage): Promise<void> => {
    const frame: WallFrame = { width: rgb.width, height: rgb.height, pixels: rgb.data };
    const keyframe = !prevWall;
    const wall = frameToWallCommands(frame, origin, prevWall, { carry, maxCommands });
    if (!dryRun) {
      // sequential sends; a throw leaves prevWall/carry untouched so the next
      // delta (old prevWall → new frame) repaints everything this batch missed
      for (const cmd of wall.commands) await rcon!.send(cmd);
    }
    const now = Date.now();
    const fpsStr = lastPaintAt ? (1000 / (now - lastPaintAt)).toFixed(2) : "-";
    lastPaintAt = now;
    prevWall = frame;
    carry = wall.remainder;
    painted++;
    log(
      `frame ${painted}${keyframe ? " (keyframe)" : ""}: ${wall.commands.length} commands` +
        `${dryRun ? " (dry-run, not sent)" : " sent"}, ${wall.remainder.length} cells carried, ${fpsStr} fps`,
    );
  };

  // ----- resolve the player (real RCON modes only) -----
  let player = values["player"] as string | undefined;
  if (!dryRun && !player) {
    player = await detectPlayer(rcon!);
    log(`player auto-detected: ${player}`);
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
        const png = await wm.request(JSON.stringify({ type: "reset", skill }));
        wm.needsReset = false;
        log(`world-model session reset (skill=${skill})`);
        await paint(decodeFramePng(png, sizeW, sizeH));
      } else if (mockWm && painted === 0) {
        // mock keyframe: paint the initial neutral frame (retried until the batch lands)
        mockPrev = mockWorldModel(null, neutral, sizeW);
        await paint(mockPrev);
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
            const rgb = wm
              ? decodeFramePng(await wm.request(actionMessage(action)), sizeW, sizeH)
              : (mockPrev = mockWorldModel(mockPrev, action, sizeW));
            await paint(rgb);
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
