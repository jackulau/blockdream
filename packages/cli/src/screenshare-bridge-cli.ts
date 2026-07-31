// Desktop screen-share -> Minecraft bridge. Opens ONE local port that is both the viewer and the
// relay: GET / serves the capture page (getDisplayMedia), GET /stats serves live JSON, and a
// WebSocket receives the downscaled RGB frames the page streams. A pump paints the LATEST frame at
// <= --fps into a running vanilla world via the SAME pure core the world-model / --image cast use
// (frameToWallCommands + RconPool, delta + budget-carry), so a screencast becomes a live block wall
// you watch from inside Minecraft - no mod, no datapack, no client plugin. RCON is the transport.
//
//   page (browser)  --WS binary frame-->  bridge  --frameToWallCommands + sendBatch-->  vanilla server
//
// This file owns ONLY sockets + the pump; every frame->command transform is in rcon-bridge.ts and the
// wire codec is in screenshare-bridge.ts, both unit-tested. The pump keeps ONE frame in hand (the
// newest) and paints it as a delta against the last painted frame: a screencast is ~97% static, so
// steady-state frames are near-zero commands and only motion costs writes.
//
//   npx tsx packages/cli/src/screenshare-bridge-cli.ts --rcon-pass <pw>     # live, open http://127.0.0.1:8770
//   npx tsx packages/cli/src/screenshare-bridge-cli.ts --dry-run            # serve the page, paint nothing

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { parseArgs } from "node:util";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import { joinDashValues } from "./argv";
import {
  buildSetupCommands,
  describeSetupFootprint,
  frameToWallCommands,
  isWallFacing,
  wallSetupFootprint,
  type WallCommands,
  type WallFacing,
  type WallFrame,
} from "./rcon-bridge";
import { decodeFrameMessage } from "./screenshare-bridge";
import { capturePageHtml } from "./screenshare-page";
import { RconPool } from "./rcon-pool";

const USAGE = `screenshare-bridge - screen-share ANY screen/window into a live Minecraft block wall

Usage: npx tsx packages/cli/src/screenshare-bridge-cli.ts [options]

Opens ONE port that serves a capture page AND relays its frames into a running vanilla
server over RCON. Start it, open the URL it prints, click "Share a screen", pick a
screen/window/tab - it appears live as a block wall at --origin while you watch in-game.

Options:
  --port <p>          port for the capture page + WebSocket   (default 8770)
  --rcon-host <h>     RCON host                               (default 127.0.0.1)
  --rcon-port <p>     RCON port                               (default 25575)
  --rcon-pass <pw>    RCON password - REQUIRED unless --dry-run
  --origin <x,y,z>    wall's bottom-left block                (default 10,-60,10)
  --size <WxH>        wall size in blocks; the page downscales the screen to it (default 128x72,
                      16:9 - match your screen's aspect to avoid squish)
  --facing <dir>      wall plane: north | south | east | west (default south)
  --fps <n>           max paint rate                          (default 6)
  --max-commands <n>  RCON command budget per frame; overflow carries to the next frame (default 512)
  --rcon-conns <n>    parallel RCON connections used to paint  (default 4)
  --setup             clear the wall volume + viewing space once before the first frame (/fill)
  --setup-clearance <n>  blocks of +/-Z clearance carved by --setup  (default 3)
  --host <h>          interface to bind the page/WS server     (default 127.0.0.1 - loopback only)
  --frames <n>        exit 0 after painting n frames (0 = unlimited, for tests)  (default 0)
  --dry-run           serve the page + accept frames but send NO RCON (prints command counts)
  -h, --help          show this help
`;

const log = (msg: string): void => console.log(`[screenshare] ${msg}`);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Normalize a ws `RawData` (Buffer | ArrayBuffer | Buffer[]) into one Uint8Array view. */
function toBytes(data: RawData, isBinary: boolean): Uint8Array | null {
  if (!isBinary) return null; // control text (none defined yet) - ignore
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data));
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  const b = data as Buffer;
  return new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
}

const BOOLEAN_FLAGS = new Set(["setup", "dry-run"]);

export async function main(argv: string[]): Promise<number> {
  let values: Record<string, string | boolean | undefined>;
  try {
    ({ values } = parseArgs({
      args: joinDashValues(argv, BOOLEAN_FLAGS),
      options: {
        port: { type: "string" },
        "rcon-host": { type: "string" },
        "rcon-port": { type: "string" },
        "rcon-pass": { type: "string" },
        origin: { type: "string" },
        size: { type: "string" },
        facing: { type: "string" },
        fps: { type: "string" },
        "max-commands": { type: "string" },
        "rcon-conns": { type: "string" },
        setup: { type: "boolean" },
        "setup-clearance": { type: "string" },
        host: { type: "string" },
        frames: { type: "string" },
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
  const port = parseInt((values["port"] as string | undefined) ?? "8770", 10);
  const host = (values["host"] as string | undefined) ?? "127.0.0.1";
  const rconHost = (values["rcon-host"] as string | undefined) ?? "127.0.0.1";
  const rconPort = parseInt((values["rcon-port"] as string | undefined) ?? "25575", 10);
  const rconPass = values["rcon-pass"] as string | undefined;
  const facingArg = values["facing"] as string | undefined;
  if (facingArg && !isWallFacing(facingArg)) return fail(`--facing must be north|south|east|west`);
  const wallFacing: WallFacing = (facingArg as WallFacing | undefined) ?? "south";
  const fps = Number((values["fps"] as string | undefined) ?? "6");
  const maxCommands = parseInt((values["max-commands"] as string | undefined) ?? "512", 10);
  const rconConns = parseInt((values["rcon-conns"] as string | undefined) ?? "4", 10);
  const doSetup = Boolean(values["setup"]);
  const setupClearance = parseInt((values["setup-clearance"] as string | undefined) ?? "3", 10);
  const maxFrames = parseInt((values["frames"] as string | undefined) ?? "0", 10);

  if (!Number.isInteger(port) || port <= 0 || port > 65535) return fail(`bad --port`);
  if (!Number.isInteger(rconPort) || rconPort <= 0) return fail(`bad --rcon-port`);
  if (!Number.isFinite(fps) || fps <= 0) return fail(`--fps must be > 0`);
  if (!Number.isInteger(maxCommands) || maxCommands < 1) return fail(`--max-commands must be >= 1`);
  if (!Number.isInteger(rconConns) || rconConns < 1) return fail(`--rcon-conns must be >= 1`);
  if (!Number.isInteger(setupClearance) || setupClearance < 0) return fail(`--setup-clearance must be >= 0`);
  if (!Number.isInteger(maxFrames) || maxFrames < 0) return fail(`--frames must be >= 0`);
  if (!dryRun && !rconPass) return fail(`--rcon-pass is required (omit only with --dry-run)`);

  const om = /^\s*(-?\d+)\s*,\s*(-?\d+)\s*,\s*(-?\d+)\s*$/.exec((values["origin"] as string | undefined) ?? "10,-60,10");
  if (!om) return fail(`--origin must be "x,y,z" integers (e.g. 10,-60,10)`);
  const origin = { x: parseInt(om[1]!, 10), y: parseInt(om[2]!, 10), z: parseInt(om[3]!, 10) };

  const sm = /^(\d+)x(\d+)$/.exec((values["size"] as string | undefined) ?? "128x72");
  if (!sm) return fail(`--size must be WxH (e.g. 128x72)`);
  const sizeW = parseInt(sm[1]!, 10);
  const sizeH = parseInt(sm[2]!, 10);
  if (sizeW < 1 || sizeH < 1) return fail(`--size must be >= 1x1`);

  // ----- shared pump state: newest captured frame + the delta/carry contract from the live cast -----
  let stopped = false;
  // `null as ...` (not `: ... = null`) so CFA keeps the union: latest is reassigned only inside the
  // WS callback below, which TS's flow analysis can't see - a bare `= null` would narrow it to `null`
  // in the pump and make the paint branch unreachable (never).
  let latest = null as WallFrame | null; // newest frame from the page; the pump paints this
  let lastPainted: WallFrame | null = null; // identity guard so a static screen isn't re-diffed
  let prevWall: WallFrame | undefined; // last painted frame, for the delta (undefined => keyframe)
  let prevQuant: WallCommands["quantized"] | undefined; // prevWall's quantization, reused (quantize once/frame)
  let carry: WallCommands["remainder"] = []; // cells a capped frame deferred, flushed on later ticks
  let didSetup = false;
  let framesRecv = 0;
  let painted = 0;
  let lastCmdCount = 0;

  // --setup disclosure: print the exact clear box up front, BEFORE any connection or /fill (the
  // actual clear runs on the first captured frame; if its dims differ from --size, the pump
  // re-discloses the real box before clearing). Additive logging only - no prompt.
  if (doSetup) {
    for (const line of describeSetupFootprint("wall + viewing clearance", wallSetupFootprint(origin, sizeW, sizeH, { clearance: setupClearance, facing: wallFacing }))) log(line);
  }

  const rcon = dryRun ? null : new RconPool({ host: rconHost, port: rconPort, password: rconPass!, conns: rconConns, log });

  // ----- HTTP: the capture page + a live stats JSON, both on the one port -----
  const pageHtml = capturePageHtml({ width: sizeW, height: sizeH, fps });
  const httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = (req.url ?? "/").split("?")[0];
    if (path === "/" || path === "/index.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(pageHtml);
    } else if (path === "/favicon.ico") {
      res.writeHead(204).end(); // no icon; keep the browser console clean (no 404 on the auto-request)
    } else if (path === "/stats") {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(
        JSON.stringify({
          framesReceived: framesRecv,
          framesPainted: painted,
          clients: wss.clients.size,
          lastCommands: lastCmdCount,
          carried: carry.length,
          size: `${sizeW}x${sizeH}`,
          fps,
          origin,
          facing: wallFacing,
          dryRun,
        }),
      );
    } else {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
    }
  });

  // ----- WebSocket: capture-page frames land here and update `latest` (newest wins) -----
  const wss = new WebSocketServer({ server: httpServer });
  wss.on("connection", (socket: WebSocket) => {
    log(`capture page connected (${wss.clients.size} client(s))`);
    socket.on("message", (data: RawData, isBinary: boolean) => {
      const bytes = toBytes(data, isBinary);
      if (!bytes) return;
      try {
        latest = decodeFrameMessage(bytes);
        framesRecv++;
      } catch (e) {
        log(`dropped a bad frame: ${e instanceof Error ? e.message : String(e)}`);
      }
    });
    socket.on("close", () => log(`capture page disconnected (${wss.clients.size} client(s))`));
    socket.on("error", (e: Error) => log(`ws error: ${e.message}`));
  });

  try {
    await new Promise<void>((resolve, reject) => {
      const onStartupError = (e: Error): void => reject(e);
      httpServer.once("error", onStartupError);
      httpServer.listen(port, host, () => {
        httpServer.removeListener("error", onStartupError);
        httpServer.on("error", (e: Error) => log(`http server error: ${e.message}`)); // late errors: log, don't crash
        resolve();
      });
    });
  } catch (e) {
    log(`cannot bind ${host}:${port}: ${e instanceof Error ? e.message : String(e)}`);
    await rcon?.stop();
    return 1;
  }

  log(
    `serving http://${host}:${port}  (open it, click "Share a screen")  -> wall ${sizeW}x${sizeH} at ` +
      `(${origin.x},${origin.y},${origin.z}) facing ${wallFacing}, fps<=${fps}, budget ${maxCommands}` +
      `${dryRun ? " [dry-run: no RCON]" : ` -> rcon ${rconHost}:${rconPort} x${rconConns}`}`,
  );

  const shutdown = (): void => {
    stopped = true;
  };
  process.once("SIGINT", () => {
    log("SIGINT - shutting down");
    shutdown();
  });

  // ----- the pump: paint the newest frame as a delta, <= fps; flush any budget carry between frames -----
  const period = 1000 / fps;
  let firstPaintLogged = false;
  while (!stopped && (maxFrames === 0 || painted < maxFrames)) {
    const t0 = Date.now();
    const frame = latest;
    // paint when a NEW frame arrived, or when a capped frame still has cells to flush (carry)
    if (frame && (frame !== lastPainted || carry.length > 0)) {
      lastPainted = frame;
      const dimsMatch = prevWall != null && prevWall.width === frame.width && prevWall.height === frame.height;
      const usePrev = dimsMatch ? prevWall : undefined;
      if (!usePrev) carry = []; // first frame or a resized capture => keyframe, drop stale carry
      try {
        if (doSetup && !didSetup) {
          if (frame.width !== sizeW || frame.height !== sizeH) {
            // the page sent different dims than --size: re-disclose the ACTUAL box before clearing it
            for (const line of describeSetupFootprint("wall + viewing clearance", wallSetupFootprint(origin, frame.width, frame.height, { clearance: setupClearance, facing: wallFacing }))) log(line);
          }
          const setupCmds = buildSetupCommands(origin, frame.width, frame.height, { clearance: setupClearance, facing: wallFacing });
          if (!dryRun) await rcon!.sendBatch(setupCmds);
          didSetup = true;
          log(`setup: cleared ${frame.width}x${frame.height} wall + ${setupClearance}-block clearance (${setupCmds.length} /fill)`);
        }
        const wall = frameToWallCommands(frame, origin, usePrev, {
          carry,
          maxCommands,
          facing: wallFacing,
          prevQuantized: usePrev ? prevQuant : undefined,
        });
        if (!dryRun) await rcon!.sendBatch(wall.commands);
        prevWall = frame;
        prevQuant = wall.quantized;
        carry = wall.remainder;
        painted++;
        lastCmdCount = wall.commands.length;
        if (!firstPaintLogged) {
          log(`first frame painted: ${wall.commands.length} cmds${usePrev ? "" : " (keyframe)"}${dryRun ? " (dry-run)" : ""}`);
          firstPaintLogged = true;
        } else if (maxFrames > 0 || wall.remainder.length > 0) {
          log(`frame ${painted}: ${wall.commands.length} cmds, ${wall.remainder.length} carried${dryRun ? " (dry-run)" : ""}`);
        }
      } catch (e) {
        // a failed batch leaves prevWall/prevQuant/carry untouched so the next delta repaints what
        // this frame missed; re-arm the identity guard so the newest frame retries next tick
        log(`paint failed (will repaint): ${e instanceof Error ? e.message : String(e)}`);
        lastPainted = null;
      }
    }
    const elapsed = Date.now() - t0;
    if (elapsed < period) await sleep(period - elapsed);
  }

  log(`done: received ${framesRecv} frame(s), painted ${painted}`);
  for (const client of wss.clients) client.terminate(); // don't block shutdown on a still-open capture page
  await new Promise<void>((resolve) => wss.close(() => resolve()));
  httpServer.closeAllConnections(); // Node 18.2+: force-close active/idle sockets so close() actually fires
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  await rcon?.stop();
  return 0;
}

// Run only as a script, not when imported by tests (which call main() directly).
if (process.argv[1] && (process.argv[1].endsWith("screenshare-bridge-cli.ts") || process.argv[1].endsWith("screenshare-bridge-cli.js"))) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err: unknown) => {
      console.error(`[screenshare] fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
      process.exit(1);
    },
  );
}
