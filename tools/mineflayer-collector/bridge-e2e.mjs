// bridge-e2e.mjs — headless END-TO-END proof of Blockdream's NO-MOD live Minecraft path.
//
// One command, no mods, no Microsoft account, no GPU: boots a throwaway STOCK vanilla
// 1.21.1 server (offline-mode, localhost-only — scripts/vanilla-server.sh), joins a
// mineflayer bot as the "player", launches the rcon-bridge sidecar
// (packages/cli/src/rcon-bridge-cli.ts) with its deterministic --mock-wm world model,
// walks + turns the bot DURING generation so the pose-derived actions vary, then ASSERTS
// over RCON that the sidecar really painted the 64×64 wall at --origin: sampled wall
// cells changed from the flat-world default (air) to solid palette blocks.
//
//   vanilla server (java -jar server.jar nogui) ←RCON— sidecar (pose poll → mock WM → setblock/fill)
//          ↑ mineflayer bot "bridgebot" walking/turning = the live player input
//
// OPERATOR-GATED: needs JDK 21; the one-time ~50MB Mojang jar download is skipped when a
// sha1-valid server.jar is cached in /tmp/bd-server-d2 or .vanilla-server (seeded below).
//   node tools/mineflayer-collector/bridge-e2e.mjs
// Exit 0 = wall painted. Nonzero = diagnostics; the temp server dir is KEPT for debugging.

import { createBot } from "mineflayer";
import { Rcon } from "rcon-client";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, copyFileSync, existsSync, rmSync, readFileSync, writeFileSync, createWriteStream } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const MC_VERSION = "1.21.1";
const RCON_PASS = "blockdream-e2e";
const BOT_NAME = "bridgebot";
const ORIGIN = { x: 10, y: -60, z: 10 }; // wall bottom-left; superflat players stand at y=-60
const SIZE = 64; // sidecar default wall is 64×64
const FRAMES = 6;
// wall cells to assert on, as (dx,dy) from ORIGIN: corners, the diagonal, the top edge
const SAMPLES = [[0, 0], [16, 12], [32, 24], [48, 36], [63, 48], [31, 63], [63, 63]];

const log = (m) => console.log(`[bridge-e2e] ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ephemeral free port — concurrent e2e runs (parallel audits / two verify-alls) must
// not race a hardcoded 25565/25575; the bind loser's clients would silently drive the
// winner's server
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

// stream child output line-by-line: echo with a prefix and remember lines for diagnostics
function tee(stream, prefix, sink) {
  let buf = "";
  stream.on("data", (d) => {
    buf += d.toString();
    for (let i; (i = buf.indexOf("\n")) >= 0; buf = buf.slice(i + 1)) {
      const line = buf.slice(0, i).trimEnd();
      if (line) { console.log(`${prefix} ${line}`); sink?.push(line); }
    }
  });
}

async function killProc(proc, name) {
  if (!proc || proc.exitCode !== null) return;
  proc.kill("SIGTERM");
  const dead = await Promise.race([new Promise((r) => proc.once("exit", () => r(true))), sleep(5000)]);
  if (dead !== true) { log(`${name} ignored SIGTERM — SIGKILL`); proc.kill("SIGKILL"); }
}

let server = null, sidecar = null, bot = null, rconClient = null;
let cleaned = false;
async function cleanup() {
  if (cleaned) return; cleaned = true;
  try { bot?.quit(); } catch {}
  await killProc(sidecar, "sidecar");
  if (rconClient) await rconClient.end().catch(() => {});
  await killProc(server, "server");
}
process.on("SIGINT", () => { log("SIGINT — cleaning up"); cleanup().finally(() => process.exit(130)); });

const t0 = Date.now();
const dir = mkdtempSync(join(tmpdir(), "bd-bridge-e2e-"));
try {
  // ---- 1. bootstrap a throwaway vanilla server (seed the cached jar to skip the 50MB pull)
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
    log(`starting server (java 21, ports: server ${SERVER_PORT}, rcon ${RCON_PORT}) — waiting for RCON (≤180 s)`);
    server = spawn(join(javaHome, "bin", "java"), ["-Xmx2G", "-jar", "server.jar", "nogui"], {
      cwd: dir, env: { ...process.env, JAVA_HOME: javaHome }, stdio: ["ignore", "pipe", "pipe"],
    });
    const bootLog = createWriteStream(join(dir, "boot-stdout.log"));
    server.stdout.pipe(bootLog); server.stderr.pipe(bootLog);
    let bootBuf = "";
    try {
      await new Promise((res, rej) => {
        const timer = setTimeout(() => rej(new Error(`server not ready after 180 s — see ${dir}/boot-stdout.log`)), 180_000);
        const onData = (d) => {
          bootBuf += d.toString();
          if (/RCON running on/.test(bootBuf)) {
            server.stdout.off("data", onData); clearTimeout(timer);
            log("server ready (RCON listening)"); res();
          }
        };
        server.stdout.on("data", onData);
        server.once("exit", (code) => { clearTimeout(timer); rej(new Error(`server exited early (code ${code}) — see ${dir}/boot-stdout.log`)); });
      });
      break; // booted
    } catch (bootErr) {
      if (attempt < 3 && /Address already in use/.test(bootBuf)) {
        log(`port collision on boot (attempt ${attempt}) — retrying with fresh ports`);
        continue;
      }
      throw bootErr;
    }
  }

  // ---- 2. RCON-prepare: keep the wall + walking area loaded, flatten the slate to air
  rconClient = await Rcon.connect({ host: "127.0.0.1", port: RCON_PORT, password: RCON_PASS });
  const rcon = (cmd) => rconClient.send(cmd);
  await rcon("difficulty peaceful");
  await rcon("defaultgamemode creative");
  await rcon("forceload add 0 0 96 64"); // wall chunks (x0–x4,z0) + the bot's walking area
  const [x2, y2] = [ORIGIN.x + SIZE - 1, ORIGIN.y + SIZE - 1];
  await rcon(`fill ${ORIGIN.x} ${ORIGIN.y} ${ORIGIN.z} ${x2} ${y2} ${ORIGIN.z} minecraft:air`);
  log(`wall plane cleared to air: (${ORIGIN.x},${ORIGIN.y},${ORIGIN.z})..(${x2},${y2},${ORIGIN.z})`);

  // ---- 3. join the bot (offline-mode server — no Microsoft account needed)
  log(`joining bot ${BOT_NAME} (mineflayer, version ${MC_VERSION}, auth offline)`);
  bot = createBot({ host: "127.0.0.1", port: SERVER_PORT, username: BOT_NAME, auth: "offline", version: MC_VERSION });
  await new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error("bot did not spawn within 60 s")), 60_000);
    bot.once("spawn", () => { clearTimeout(timer); res(); });
    bot.once("error", rej);
    bot.once("end", () => rej(new Error("bot disconnected before spawn")));
  });
  bot.on("error", (e) => log(`bot error: ${e.message}`));
  await rcon(`tp ${BOT_NAME} 42 -60 24 0 0`); // mid-wall x, 14 blocks in front of the wall plane
  await sleep(2500); // let chunks load (collect.mjs pattern)
  log("bot spawned + teleported beside the wall");

  // ---- 4. launch the sidecar (mock WM: no checkpoint/WS) and DRIVE the bot during its frames
  const tsx = join(ROOT, "node_modules/.bin/tsx");
  const args = ["packages/cli/src/rcon-bridge-cli.ts", "--rcon-pass", RCON_PASS, "--rcon-port", String(RCON_PORT),
    "--player", BOT_NAME, "--mock-wm", "--frames", String(FRAMES), "--fps", "4", "--max-commands", "4096",
    "--origin", `${ORIGIN.x},${ORIGIN.y},${ORIGIN.z}`];
  log(`launching sidecar: tsx ${args.join(" ")}`);
  sidecar = spawn(existsSync(tsx) ? tsx : "npx", existsSync(tsx) ? args : ["tsx", ...args],
    { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
  const sidecarLines = [];
  tee(sidecar.stdout, "[sidecar]", sidecarLines);
  tee(sidecar.stderr, "[sidecar!]", sidecarLines);
  const sidecarExit = new Promise((r) => sidecar.once("exit", (code) => r(code)));
  let sidecarDone = false; sidecarExit.then(() => { sidecarDone = true; });

  // walk forward, turning 90° every ~1 s — so poseToAction sees motion AND camera deltas
  // within the 6-frame window (the 64×64 keyframe alone takes a few seconds of RCON sends)
  bot.setControlState("forward", true);
  (async () => {
    while (!sidecarDone) {
      await sleep(1000);
      if (sidecarDone || !bot.entity) break;
      await bot.look(bot.entity.yaw + Math.PI / 2, 0, true).catch(() => {});
    }
    try { bot.setControlState("forward", false); } catch {}
  })();

  const code = await Promise.race([sidecarExit, sleep(120_000).then(() => "timeout")]);
  if (code === "timeout") throw new Error("sidecar did not finish 6 frames within 120 s");
  if (code !== 0) throw new Error(`sidecar exited with code ${code}`);
  const framesLine = sidecarLines.find((l) => /done: \d+ frame/.test(l)) ?? "(no done line)";
  log(`sidecar finished: ${framesLine}`);

  // ---- 5. assert via RCON: the sampled wall cells must no longer (all) be air
  await rcon(`tp ${BOT_NAME} 42 -60 24 180 0`); // park the bot facing the wall for client readback
  await sleep(2000); // let block updates reach the client
  const { Vec3 } = require("vec3");
  const rows = [];
  let painted = 0;
  for (const [dx, dy] of SAMPLES) {
    const [x, y, z] = [ORIGIN.x + dx, ORIGIN.y + dy, ORIGIN.z];
    const isAir = /passed/i.test(await rcon(`execute if block ${x} ${y} ${z} minecraft:air`));
    if (!isAir) painted++;
    const name = bot.blockAt(new Vec3(x, y, z))?.name ?? "?";
    rows.push({ coord: `(${x},${y},${z})`, server: isAir ? "AIR" : "painted", client: name });
  }
  console.log("\n[bridge-e2e] ===== wall assertion =====");
  console.log(`  ${"coord".padEnd(14)} ${"server (RCON)".padEnd(14)} client block`);
  for (const r of rows) console.log(`  ${r.coord.padEnd(14)} ${r.server.padEnd(14)} ${r.client}`);
  console.log(`  ${painted}/${SAMPLES.length} sampled wall cells painted (changed from flat-world air)`);
  if (painted === 0) throw new Error("ALL sampled wall cells are still air — the sidecar painted nothing");

  await cleanup();
  rmSync(dir, { recursive: true, force: true });
  log(`PASS in ${((Date.now() - t0) / 1000).toFixed(1)} s — no-mod live path proven end-to-end (temp dir removed)`);
  process.exit(0);
} catch (e) {
  console.error(`[bridge-e2e] FAIL: ${e.message}`);
  console.error(`[bridge-e2e] server dir KEPT for debugging: ${dir} (boot log: ${dir}/boot-stdout.log)`);
  await cleanup();
  process.exit(1);
}
