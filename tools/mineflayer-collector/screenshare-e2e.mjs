// screenshare-e2e.mjs - headless END-TO-END proof of the SCREEN-SHARE live cast surface
// (packages/cli/src/screenshare-bridge-cli.ts), the one live-cast path that was previously
// verified only under --dry-run. Boots a throwaway STOCK vanilla 1.21.1 server
// (offline-mode, localhost-only - scripts/vanilla-server.sh), launches the screenshare
// bridge with --setup against it, then EMULATES the capture page: a plain WebSocket client
// pushes synthetic RGB frames in the real wire format (uint16 LE width + uint16 LE height +
// W*H*3 RGB bytes - screenshare-bridge.ts), and the test ASSERTS over RCON that the exact
// blocks the paint core promises actually landed on the wall, per frame.
//
//   ws client (this test) --WS binary frame--> bridge --frameToWallCommands + RconPool--> vanilla server
//
// Expected state is computed by the bridge's OWN pure core (frameToWallCommands +
// buildSetupCommands, run through tsx on the SAME frame bytes with the SAME flags), never
// re-derived by hand - so a pass proves the sockets + pump + RCON path executed the core's
// contract cell-exact for THREE distinct frames: keyframe, band-swap delta, solid delta.
// The /stats endpoint gates each send (frame N+1 goes out only after the bridge reports
// frame N painted), so every intermediate wall state is observable and asserted.
//
// OPERATOR-GATED: needs JDK 21 (resolved via /usr/libexec/java_home -v 21); the one-time
// ~50MB Mojang jar download is skipped when a sha1-valid server.jar is cached in
// /tmp/bd-server-d2 or .vanilla-server (seeded below).
//   node tools/mineflayer-collector/screenshare-e2e.mjs
// Exit 0 = every sampled cell exact for 3 frames. Nonzero = diagnostics; dirs are KEPT.

import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, copyFileSync, existsSync, rmSync, readFileSync, writeFileSync, createWriteStream } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
// ws + rcon-client live in packages/cli's dependency tree (they are the bridge's own WS/RCON
// libraries) - resolve BOTH from there so this test speaks exactly the libs the bridge uses
// and needs no `npm install` in tools/mineflayer-collector (unlike the bot-driven siblings)
const cliRequire = createRequire(join(ROOT, "packages/cli/package.json"));
const { WebSocket } = cliRequire("ws");
const { Rcon } = cliRequire("rcon-client");

const MC_VERSION = "1.21.1";
const RCON_PASS = "blockdream-ss-e2e";
const ORIGIN = { x: 10, y: -60, z: 10 }; // wall bottom-left, near spawn (chunks stay loadable)
const W = 16, H = 12; // small wall: 3 frames paint in a handful of commands
const FACING = "south";
const MAX_COMMANDS = 4096; // far above 3 frames' needs, so the helper sees zero carry
const CLEARANCE = 3;
const N_FRAMES = 3; // bridge runs with --frames 3 and exits 0 after painting them
// wall cells to assert on, as (dx, dyUp) from ORIGIN: corners, center, off-center picks
const SAMPLES = [[0, 0], [W - 1, 0], [0, H - 1], [W - 1, H - 1], [8, 6], [3, 2], [12, 9]];

const log = (m) => console.log(`[screenshare-e2e] ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ephemeral free port - concurrent e2e runs must not race a hardcoded port; the loser's
// clients would silently drive the winner's server (same rationale as bridge-e2e)
function freePort() {
  return new Promise((res, rej) => {
    const srv = createServer();
    srv.once("error", rej);
    srv.listen(0, "127.0.0.1", () => {
      const p = srv.address().port;
      srv.close(() => res(p));
    });
  });
}

// replace-or-APPEND a server.properties key: the bootstrap properties are minimal
// (vanilla appends missing defaults on first boot), so a bare .replace() on an absent
// key is a silent no-op and the server binds the default port instead
function setProp(text, key, val) {
  const re = new RegExp(`^${key.replace(/\./g, "\\.")}=.*$`, "m");
  return re.test(text) ? text.replace(re, `${key}=${val}`) : `${text.replace(/\n?$/, "\n")}${key}=${val}\n`;
}

// stream child output line-by-line: echo with a prefix, remember lines, notify a watcher
function tee(stream, prefix, sink, onLine) {
  let buf = "";
  stream.on("data", (d) => {
    buf += d.toString();
    for (let i; (i = buf.indexOf("\n")) >= 0; buf = buf.slice(i + 1)) {
      const line = buf.slice(0, i).trimEnd();
      if (line) { console.log(`${prefix} ${line}`); sink?.push(line); onLine?.(line); }
    }
  });
}

async function killProc(proc, name) {
  if (!proc || proc.exitCode !== null) return;
  proc.kill("SIGTERM");
  const dead = await Promise.race([new Promise((r) => proc.once("exit", () => r(true))), sleep(5000)]);
  if (dead !== true) { log(`${name} ignored SIGTERM - SIGKILL`); proc.kill("SIGKILL"); }
}

// ---------- synthetic frames + the real wire format ----------
// [0..1] width (uint16 LE)  [2..3] height (uint16 LE)  [4..] RGB bytes (W*H*3)
function encodeFrame(rgb) {
  const out = Buffer.alloc(4 + rgb.length);
  out.writeUInt16LE(W, 0);
  out.writeUInt16LE(H, 2);
  out.set(rgb, 4);
  return out;
}
function bandFrame(topRgb, bottomRgb) {
  const px = Buffer.alloc(W * H * 3);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const c = y < H / 2 ? topRgb : bottomRgb; // image row 0 is the TOP of the wall
      px.set(c, (y * W + x) * 3);
    }
  return px;
}
const RED = [200, 30, 30], GREEN = [30, 160, 60], BLUE = [30, 30, 200];
const FRAME_RGB = [bandFrame(RED, GREEN), bandFrame(GREEN, RED), bandFrame(BLUE, BLUE)];

// apply the core's own setblock/fill lines to a coord->block world model (fullvideo-e2e pattern)
function applyCommands(world, cmds) {
  for (const line of cmds) {
    let m;
    if ((m = /^setblock (-?\d+) (-?\d+) (-?\d+) (\S+)(?: \w+)?$/.exec(line))) {
      world.set(`${m[1]},${m[2]},${m[3]}`, m[4]);
    } else if ((m = /^fill (-?\d+) (-?\d+) (-?\d+) (-?\d+) (-?\d+) (-?\d+) (\S+)(?: \w+)?$/.exec(line))) {
      const [x0, y0, z0, x1, y1, z1] = m.slice(1, 7).map(Number);
      for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++)
        for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++)
          for (let z = Math.min(z0, z1); z <= Math.max(z0, z1); z++)
            world.set(`${x},${y},${z}`, m[7]);
    } else {
      throw new Error(`unrecognized wall command from the core: ${line}`);
    }
  }
  return world;
}

let server = null, bridge = null, wsClient = null, rconClient = null;
let cleaned = false;
async function cleanup() {
  if (cleaned) return; cleaned = true;
  try { wsClient?.terminate(); } catch {} // an open WS would hang the bridge's httpServer.close()
  await killProc(bridge, "bridge");
  if (rconClient) await rconClient.end().catch(() => {});
  await killProc(server, "server");
}
process.on("SIGINT", () => { log("SIGINT - cleaning up"); cleanup().finally(() => process.exit(130)); });

const t0 = Date.now();
const dir = mkdtempSync(join(tmpdir(), "bd-screenshare-e2e-"));
const work = mkdtempSync(join(tmpdir(), "bd-screenshare-e2e-work-"));
try {
  // ---- 1. expected commands from the bridge's OWN pure core (same bytes, same flags)
  const tsx = join(ROOT, "node_modules/.bin/tsx");
  const framePaths = FRAME_RGB.map((rgb, i) => {
    const p = join(work, `frame${i}.rgb`);
    writeFileSync(p, rgb);
    return p;
  });
  const specPath = join(work, "spec.json");
  writeFileSync(specPath, JSON.stringify({
    width: W, height: H, origin: ORIGIN, maxCommands: MAX_COMMANDS, facing: FACING,
    clearance: CLEARANCE, frames: framePaths,
  }));
  const helperPath = join(work, "expected-commands.mts");
  const coreImport = JSON.stringify(join(ROOT, "packages/cli/src/rcon-bridge"));
  writeFileSync(helperPath, [
    `import { readFileSync } from "node:fs";`,
    `import { frameToWallCommands, buildSetupCommands } from ${coreImport};`,
    `const spec = JSON.parse(readFileSync(process.argv[2], "utf8"));`,
    `const frames = spec.frames.map((p: string) => ({ width: spec.width, height: spec.height, pixels: new Uint8Array(readFileSync(p)) }));`,
    `let prev, prevQ;`,
    `const out = [];`,
    `for (const f of frames) {`,
    `  const w = frameToWallCommands(f, spec.origin, prev, { maxCommands: spec.maxCommands, facing: spec.facing, prevQuantized: prevQ });`,
    `  if (w.remainder.length > 0) throw new Error("unexpected remainder under the test budget");`,
    `  out.push(w.commands);`,
    `  prev = f; prevQ = w.quantized;`,
    `}`,
    `const setup = buildSetupCommands(spec.origin, spec.width, spec.height, { clearance: spec.clearance, facing: spec.facing });`,
    `console.log(JSON.stringify({ setup, frames: out }));`,
  ].join("\n"));
  const expectedJson = execFileSync(existsSync(tsx) ? tsx : "npx",
    existsSync(tsx) ? [helperPath, specPath] : ["tsx", helperPath, specPath], { cwd: ROOT, encoding: "utf8" });
  const expected = JSON.parse(expectedJson.trim().split("\n").pop());
  if (expected.frames.length !== N_FRAMES) throw new Error(`core produced ${expected.frames.length} command sets, want ${N_FRAMES}`);

  // cumulative expected wall state after setup + frames 0..i, and the sample rows per frame
  const world = applyCommands(new Map(), expected.setup);
  const stateAt = expected.frames.map((cmds, i) => {
    if (cmds.length === 0) throw new Error(`frame ${i + 1} produced ZERO commands - the frames are not distinct to the core`);
    return new Map(applyCommands(world, cmds));
  });
  const sampleCoord = ([dx, dyUp]) => [ORIGIN.x + dx, ORIGIN.y + dyUp, ORIGIN.z];
  for (let i = 1; i < N_FRAMES; i++) {
    const differs = SAMPLES.some((s) => {
      const k = sampleCoord(s).join(",");
      return stateAt[i - 1].get(k) !== stateAt[i].get(k);
    });
    if (!differs) throw new Error(`frames ${i} and ${i + 1} quantize identically at every sampled cell - the test could not tell them apart`);
  }
  log(`expected state computed from the core: ${expected.frames.map((c) => c.length).join("+")} commands over ${N_FRAMES} frames`);

  // ---- 2. bootstrap a throwaway vanilla server (seed the cached jar to skip the 50MB pull)
  for (const cache of ["/tmp/bd-server-d2", join(ROOT, ".vanilla-server")]) {
    if (existsSync(join(cache, "server.jar")) && existsSync(join(cache, "server.jar.sha1"))) {
      copyFileSync(join(cache, "server.jar"), join(dir, "server.jar"));
      copyFileSync(join(cache, "server.jar.sha1"), join(dir, "server.jar.sha1"));
      log(`seeded cached server.jar from ${cache}`);
      break;
    }
  }
  log(`bootstrapping vanilla ${MC_VERSION} in ${dir}`);
  execFileSync("bash", [join(ROOT, "scripts/vanilla-server.sh"), "--dir", dir, "--rcon-pass", RCON_PASS, "--no-start"], { stdio: "inherit" });

  // unique ports per run so concurrent instances can't cross-talk. freePort() has a
  // tiny check-then-use race (another process can bind the port between close and
  // java's bind), so a bind-failure boot is retried with fresh ports.
  const javaHome = execFileSync("/usr/libexec/java_home", ["-v", "21"]).toString().trim();
  const propsPath = join(dir, "server.properties");
  let SERVER_PORT, RCON_PORT;
  for (let attempt = 1; ; attempt++) {
    SERVER_PORT = await freePort();
    RCON_PORT = await freePort();
    writeFileSync(propsPath,
      setProp(setProp(readFileSync(propsPath, "utf8"), "server-port", SERVER_PORT), "rcon.port", RCON_PORT));
    log(`starting server (java 21, ports: server ${SERVER_PORT}, rcon ${RCON_PORT}) - waiting for RCON (<=300 s)`);
    server = spawn(join(javaHome, "bin", "java"), ["-Xmx2G", "-jar", "server.jar", "nogui"], {
      cwd: dir, env: { ...process.env, JAVA_HOME: javaHome }, stdio: ["ignore", "pipe", "pipe"],
    });
    const bootLog = createWriteStream(join(dir, "boot-stdout.log"));
    server.stdout.pipe(bootLog); server.stderr.pipe(bootLog);
    let bootBuf = "";
    try {
      await new Promise((res, rej) => {
        // a FIRST boot unpacks every bundled library + generates the spawn area - on a cold
        // machine that legitimately exceeds bridge-e2e's 180 s, so allow 300 s like the
        // heavier siblings (fullvideo-e2e runs 240 s)
        const timer = setTimeout(() => rej(new Error(`server not ready after 300 s - see ${dir}/boot-stdout.log`)), 300_000);
        const onData = (d) => {
          bootBuf += d.toString();
          if (/RCON running on/.test(bootBuf)) {
            server.stdout.off("data", onData); clearTimeout(timer);
            log("server ready (RCON listening)"); res();
          }
        };
        server.stdout.on("data", onData);
        server.once("exit", (code) => { clearTimeout(timer); rej(new Error(`server exited early (code ${code}) - see ${dir}/boot-stdout.log`)); });
      });
      break; // booted
    } catch (bootErr) {
      if (attempt < 3 && /Address already in use/.test(bootBuf)) {
        log(`port collision on boot (attempt ${attempt}) - retrying with fresh ports`);
        continue;
      }
      throw bootErr;
    }
  }

  // ---- 3. RCON-prepare: keep the wall chunks loaded, flatten the slate to air
  rconClient = await Rcon.connect({ host: "127.0.0.1", port: RCON_PORT, password: RCON_PASS });
  const rcon = (cmd) => rconClient.send(cmd);
  await rcon("difficulty peaceful");
  await rcon("forceload add 0 0 48 32"); // the wall's chunks - block reads keep working with no player
  const [x2, y2] = [ORIGIN.x + W - 1, ORIGIN.y + H - 1];
  await rcon(`fill ${ORIGIN.x} ${ORIGIN.y} ${ORIGIN.z} ${x2} ${y2} ${ORIGIN.z} minecraft:air`);
  log(`wall plane cleared to air: (${ORIGIN.x},${ORIGIN.y},${ORIGIN.z})..(${x2},${y2},${ORIGIN.z})`);

  // ---- 4. launch the screenshare bridge (--setup, --frames 3 => exits 0 after painting them)
  const bridgeLines = [];
  let HTTP_PORT, bridgeExit;
  for (let attempt = 1; ; attempt++) {
    HTTP_PORT = await freePort();
    const args = ["packages/cli/src/screenshare-bridge-cli.ts", "--rcon-pass", RCON_PASS, "--rcon-port", String(RCON_PORT),
      "--port", String(HTTP_PORT), "--origin", `${ORIGIN.x},${ORIGIN.y},${ORIGIN.z}`, "--size", `${W}x${H}`,
      "--facing", FACING, "--fps", "8", "--max-commands", String(MAX_COMMANDS),
      "--setup", "--setup-clearance", String(CLEARANCE), "--frames", String(N_FRAMES)];
    log(`launching bridge: tsx ${args.join(" ")}`);
    let servedRes;
    const served = new Promise((r) => { servedRes = r; });
    bridge = spawn(existsSync(tsx) ? tsx : "npx", existsSync(tsx) ? args : ["tsx", ...args],
      { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
    tee(bridge.stdout, "[bridge]", bridgeLines, (l) => { if (l.includes("serving http://")) servedRes(true); });
    tee(bridge.stderr, "[bridge!]", bridgeLines);
    bridgeExit = new Promise((r) => bridge.once("exit", (code) => r(code)));
    const outcome = await Promise.race([served, bridgeExit.then((code) => ({ exitedEarly: code })), sleep(60_000).then(() => "timeout")]);
    if (outcome === true) break; // page + WS listening
    if (outcome === "timeout") throw new Error("bridge did not start serving within 60 s");
    if (attempt < 3 && bridgeLines.some((l) => l.includes("cannot bind"))) {
      log(`bridge port collision (attempt ${attempt}) - retrying with a fresh port`);
      bridgeLines.length = 0;
      continue;
    }
    throw new Error(`bridge exited before serving (code ${outcome.exitedEarly})`);
  }
  let bridgeDone = false;
  bridgeExit.then(() => { bridgeDone = true; });

  // ---- 5. emulate the capture page: WS client + real wire-format frames, /stats-gated
  wsClient = new WebSocket(`ws://127.0.0.1:${HTTP_PORT}/`);
  await new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error("WS client did not connect within 15 s")), 15_000);
    wsClient.once("open", () => { clearTimeout(timer); res(); });
    wsClient.once("error", (e) => { clearTimeout(timer); rej(e); });
  });
  wsClient.on("error", (e) => log(`ws client error: ${e.message}`));
  log("WS client connected (emulated capture page)");

  const waitPainted = async (n) => {
    const t = Date.now();
    while (Date.now() - t < 30_000) {
      if (bridgeDone && n < N_FRAMES) throw new Error(`bridge exited before painting frame ${n}`);
      try {
        const s = await (await fetch(`http://127.0.0.1:${HTTP_PORT}/stats`)).json();
        if (s.framesPainted >= n) return s;
      } catch {} // bridge busy or already closing - keep polling
      await sleep(100);
    }
    throw new Error(`bridge did not report frame ${n} painted within 30 s`);
  };

  const assertWall = async (frameNo) => {
    const state = stateAt[frameNo - 1];
    const rows = [];
    let exact = 0;
    for (const s of SAMPLES) {
      const [x, y, z] = sampleCoord(s);
      const want = state.get(`${x},${y},${z}`) ?? "minecraft:air";
      const r = await rcon(`execute if block ${x} ${y} ${z} ${want}`);
      const ok = /passed/i.test(r);
      if (ok) exact++;
      rows.push({ coord: `(${x},${y},${z})`, want, result: ok ? "exact" : (r.trim() || "(empty)") });
    }
    console.log(`\n[screenshare-e2e] ===== wall assertion, frame ${frameNo} =====`);
    console.log(`  ${"coord".padEnd(14)} ${"expected block".padEnd(28)} server (RCON)`);
    for (const r of rows) console.log(`  ${r.coord.padEnd(14)} ${r.want.padEnd(28)} ${r.result}`);
    console.log(`  ${exact}/${SAMPLES.length} sampled wall cells exact-match\n`);
    if (exact !== SAMPLES.length) throw new Error(`frame ${frameNo}: ${SAMPLES.length - exact} sampled cell(s) wrong`);
  };

  for (let i = 0; i < N_FRAMES; i++) {
    wsClient.send(encodeFrame(FRAME_RGB[i]), { binary: true });
    if (i < N_FRAMES - 1) {
      await waitPainted(i + 1);
      await assertWall(i + 1);
    } else {
      // last frame reaches --frames, so the bridge exits 0 on its own (clean-shutdown proof:
      // it must terminate our still-open WS client and get past httpServer.close())
      const code = await Promise.race([bridgeExit, sleep(60_000).then(() => "timeout")]);
      if (code === "timeout") throw new Error(`bridge did not exit within 60 s of frame ${N_FRAMES}`);
      if (code !== 0) throw new Error(`bridge exited with code ${code}`);
      try { wsClient.terminate(); } catch {}
      const doneLine = bridgeLines.find((l) => /done: received \d+ frame/.test(l)) ?? "(no done line)";
      log(`bridge exited 0 after --frames ${N_FRAMES}: ${doneLine}`);
      if (!bridgeLines.some((l) => l.includes("setup: cleared"))) throw new Error("bridge never ran --setup");
      await assertWall(N_FRAMES);
    }
  }

  await cleanup();
  rmSync(dir, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
  log(`PASS in ${((Date.now() - t0) / 1000).toFixed(1)} s - screen-share live cast proven end-to-end: ` +
    `3 wire-format frames painted cell-exact on a stock vanilla server (temp dirs removed)`);
  process.exit(0);
} catch (e) {
  console.error(`[screenshare-e2e] FAIL: ${e.message}`);
  console.error(`[screenshare-e2e] dirs KEPT for debugging: server=${dir} work=${work} (boot log: ${dir}/boot-stdout.log)`);
  await cleanup();
  process.exit(1);
}
