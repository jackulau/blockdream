// music-datapack-e2e.mjs - headless END-TO-END proof that Blockdream's NOTE-BLOCK MUSIC
// path runs on a STOCK vanilla server (goal 066 shipped the feature with unit tests only;
// this proves vanilla actually EXECUTES the emitted music functions, the project's
// "prove it on a real server" bar that datapack-e2e/scale-datapack-e2e set for builds).
//
// One command, no mods, no Microsoft account: renders a real ffmpeg clip WITH AN AUDIO
// TRACK → voxel3d datapack with --music on (REAL CLI), installs blockdream_3d.zip into a
// throwaway vanilla 1.21.1 world, boots it, then asserts over RCON that:
//
//   1. the pack is ENABLED at boot AND SURVIVES /reload - reload re-parses every function,
//      so a clean reload proves the playsound / note_block / scoreboard commands the music
//      path emits are vanilla-LEGAL syntax (a bad command would drop the function on load)
//   2. /function blockdream_3d:setup places the physical tuned NOTE BLOCK (and its
//      instrument-selecting base block) at the emitter's coordinates, wires the music clock
//      (#mtcount), and leaves the BUILD intact (#count) - music is additive, not breaking
//   3. :start really drives the music: the shared #play clock advances the music-tick
//      counter #mt every tick (the blockdream_3d:music entry in #minecraft:tick executes);
//      :stop freezes it - the exact live behaviour a user gets dropping the pack in
//
//   clip(+audio) ─CLI→ blockdream_3d.zip ─vanilla-server.sh→ world/datapacks/ ─RCON→ asserts
//
// OPERATOR-GATED (like datapack-e2e): needs JDK 21 + ffmpeg; the one-time ~50MB Mojang jar
// download is skipped when a sha1-valid server.jar is cached in /tmp/bd-server-d2 or
// .vanilla-server. In verify-all it is `node --check`ed always and run live under
// BLOCKDREAM_E2E=1.
//   node tools/mineflayer-collector/music-datapack-e2e.mjs
// Exit 0 = vanilla executed the music datapack. Nonzero = diagnostics; temp dirs KEPT.

import { Rcon } from "rcon-client";
import { spawn, execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, copyFileSync, existsSync, rmSync, readFileSync, writeFileSync, readdirSync, createWriteStream } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const MC_VERSION = "1.21.1";
const RCON_PASS = "blockdream-music-e2e";
const NS = "blockdream_3d"; // the voxel3d target's namespace (datapack target uses "blockdream")
const GRID = { w: 12, h: 12 };
const FRAMES = 3;

// ephemeral free port - concurrent e2e runs must not race a hardcoded port (the loser's
// RCON would reach the winner's server). freePort has a check-then-use race, so boot retries.
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

// replace-or-APPEND a server.properties key (bootstrap props are minimal; a bare replace on
// an absent key is a silent no-op and the server binds the default port).
function setProp(text, key, val) {
  const re = new RegExp(`^${key.replace(/\./g, "\\.")}=.*$`, "m");
  return re.test(text) ? text.replace(re, `${key}=${val}`) : `${text.replace(/\n?$/, "\n")}${key}=${val}\n`;
}

const log = (m) => console.log(`[music-e2e] ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// apply setblock/fill/function lines to a sparse world map (the emitter's intent, from the artifact)
function applyFunctionFile(fnDir, ref, world) {
  const rel = ref.split(":")[1];
  const text = readFileSync(join(fnDir, `${rel}.mcfunction`), "utf8");
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    let m;
    if ((m = /^setblock (-?\d+) (-?\d+) (-?\d+) (\S+)(?: \w+)?$/.exec(line))) {
      world.set(`${m[1]},${m[2]},${m[3]}`, m[4]);
    } else if ((m = /^fill (-?\d+) (-?\d+) (-?\d+) (-?\d+) (-?\d+) (-?\d+) (\S+)(?: \w+)?$/.exec(line))) {
      const [x0, y0, z0, x1, y1, z1] = m.slice(1, 7).map(Number);
      for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++)
        for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++)
          for (let z = Math.min(z0, z1); z <= Math.max(z0, z1); z++)
            world.set(`${x},${y},${z}`, m[7]);
    } else if ((m = /^function (\S+)$/.exec(line))) {
      applyFunctionFile(fnDir, m[1], world);
    }
  }
  return world;
}

let server = null, rconClient = null;
let cleaned = false;
async function cleanup() {
  if (cleaned) return; cleaned = true;
  if (rconClient) await rconClient.end().catch(() => {});
  if (server && server.exitCode === null) {
    server.kill("SIGTERM");
    const dead = await Promise.race([new Promise((r) => server.once("exit", () => r(true))), sleep(5000)]);
    if (dead !== true) server.kill("SIGKILL");
  }
}
process.on("SIGINT", () => { log("SIGINT - cleaning up"); cleanup().finally(() => process.exit(130)); });

const t0 = Date.now();
const dir = mkdtempSync(join(tmpdir(), "bd-music-e2e-"));
const work = mkdtempSync(join(tmpdir(), "bd-music-e2e-work-"));
try {
  // ---- 1. real clip WITH a 440Hz audio track (so analyzeAudio yields >=1 note event) ----
  const ffmpeg = process.env.BLOCKDREAM_FFMPEG || "ffmpeg";
  const clip = join(work, "clip.mp4");
  const ff = spawnSync(ffmpeg, ["-v", "error",
    "-f", "lavfi", "-i", `testsrc2=size=${GRID.w * 4}x${GRID.h * 4}:rate=4:duration=1.5`,
    "-f", "lavfi", "-i", "sine=frequency=440:duration=1.5",
    "-shortest", "-y", clip]);
  if (ff.status !== 0) throw new Error(`ffmpeg clip gen failed: ${ff.stderr?.toString().slice(0, 300)}`);
  log(`test clip (video + 440Hz audio) generated: ${clip}`);

  // ---- 2. render voxel3d WITH MUSIC through the REAL CLI (the exact command a user runs) ----
  const outDir = join(work, "out");
  const tsx = join(ROOT, "node_modules/.bin/tsx");
  const cliArgs = ["packages/cli/src/index.ts", "render", clip, "--target", "voxel3d", "--music", "on",
    "--grid", `${GRID.w}x${GRID.h}`, "--max-frames", String(FRAMES), "--out", outDir];
  log(`rendering: blockdream render clip.mp4 --target voxel3d --music on --grid ${GRID.w}x${GRID.h} --max-frames ${FRAMES}`);
  const cli = spawnSync(existsSync(tsx) ? tsx : "npx", existsSync(tsx) ? cliArgs : ["tsx", ...cliArgs],
    { cwd: ROOT, encoding: "utf8" });
  if (cli.status !== 0) throw new Error(`CLI render failed (${cli.status}): ${cli.stderr?.slice(0, 500)}`);
  process.stdout.write(cli.stdout.split("\n").map((l) => `[cli] ${l}`).join("\n") + "\n");
  const zip = join(outDir, `${NS}.zip`);
  if (!existsSync(zip)) throw new Error(`CLI did not write ${zip}`);

  // ---- 3. parse the EMITTED artifact: the note-block placement + music wiring (no hardcoded coords) ----
  const fnDir = join(outDir, "data", NS, "function");
  const setupText = readFileSync(join(fnDir, "setup.mcfunction"), "utf8");
  const nbMatch = /^setblock (-?\d+) (-?\d+) (-?\d+) (minecraft:note_block\S*)/m.exec(setupText);
  if (!nbMatch) throw new Error("setup.mcfunction emitted no note_block setblock - music keyboard missing");
  const NB = { x: +nbMatch[1], y: +nbMatch[2], z: +nbMatch[3] };
  const baseMatch = new RegExp(`^setblock ${NB.x} ${NB.y - 1} ${NB.z} (\\S+)`, "m").exec(setupText);
  if (!baseMatch) throw new Error(`no instrument base block under the note block at ${NB.x} ${NB.y - 1} ${NB.z}`);
  const baseBlock = baseMatch[1];
  const mtcount = +(/scoreboard players set #mtcount ma (\d+)/.exec(setupText)?.[1] ?? -1);
  const count = +(/scoreboard players set #count ma (\d+)/.exec(setupText)?.[1] ?? -1);
  if (mtcount <= 0) throw new Error(`#mtcount not wired in setup (got ${mtcount}) - music loop length missing`);
  if (count !== FRAMES) throw new Error(`#count is ${count}, expected ${FRAMES} build frames (music broke the build wiring)`);
  // the music entry MUST be in the tick tag or the sequencer never runs
  const tick = JSON.parse(readFileSync(join(outDir, "data/minecraft/tags/function/tick.json"), "utf8"));
  if (!tick.values?.includes(`${NS}:music`)) throw new Error(`#minecraft:tick missing ${NS}:music: ${JSON.stringify(tick.values)}`);
  // a sampled SOLID build voxel from frame 0, to prove the 3D build still loads alongside music
  const frame0 = applyFunctionFile(fnDir, `${NS}:frames/0`, new Map());
  const solid = [...frame0.entries()].filter(([, v]) => v !== "minecraft:air" && !/air/.test(v)).sort();
  if (solid.length === 0) throw new Error("frame 0 placed no solid voxels - build is empty");
  const sampleVoxel = solid[Math.floor(solid.length / 2)];
  log(`artifact parsed: note_block@${NB.x},${NB.y},${NB.z} on ${baseBlock}, #mtcount=${mtcount}, #count=${count}, ${solid.length} solid voxels, ${NS}:music in tick tag`);

  // ---- 4. throwaway vanilla server with the datapack pre-installed (boot-load path) ----
  for (const cache of ["/tmp/bd-server-d2", join(ROOT, ".vanilla-server")]) {
    if (existsSync(join(cache, "server.jar")) && existsSync(join(cache, "server.jar.sha1"))) {
      copyFileSync(join(cache, "server.jar"), join(dir, "server.jar"));
      copyFileSync(join(cache, "server.jar.sha1"), join(dir, "server.jar.sha1"));
      log(`seeded cached server.jar from ${cache}`);
      break;
    }
  }
  log(`bootstrapping vanilla ${MC_VERSION} in ${dir} (music datapack pre-installed)`);
  execFileSync("bash", [join(ROOT, "scripts/vanilla-server.sh"), "--dir", dir, "--rcon-pass", RCON_PASS,
    "--datapack", zip, "--no-start"], { stdio: "inherit" });

  const javaHome = execFileSync("/usr/libexec/java_home", ["-v", "21"]).toString().trim();
  const propsPath = join(dir, "server.properties");
  let RCON_PORT;
  for (let attempt = 1; ; attempt++) {
    const SERVER_PORT = await freePort();
    RCON_PORT = await freePort();
    writeFileSync(propsPath,
      setProp(setProp(readFileSync(propsPath, "utf8"), "server-port", SERVER_PORT), "rcon.port", RCON_PORT));
    log(`starting server (java 21, ports: server ${SERVER_PORT}, rcon ${RCON_PORT}) - waiting for RCON (<=180 s)`);
    server = spawn(join(javaHome, "bin", "java"), ["-Xmx2G", "-jar", "server.jar", "nogui"], {
      cwd: dir, env: { ...process.env, JAVA_HOME: javaHome }, stdio: ["ignore", "pipe", "pipe"],
    });
    const bootLog = createWriteStream(join(dir, "boot-stdout.log"));
    server.stdout.pipe(bootLog); server.stderr.pipe(bootLog);
    let bootBuf = "";
    try {
      await new Promise((res, rej) => {
        const timer = setTimeout(() => rej(new Error(`server not ready after 180 s - see ${dir}/boot-stdout.log`)), 180_000);
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
      break;
    } catch (bootErr) {
      if (attempt < 3 && /Address already in use/.test(bootBuf)) {
        log(`port collision on boot (attempt ${attempt}) - retrying with fresh ports`);
        continue;
      }
      throw bootErr;
    }
  }

  rconClient = await Rcon.connect({ host: "127.0.0.1", port: RCON_PORT, password: RCON_PASS });
  const rcon = (cmd) => rconClient.send(cmd);

  // ---- 5. pack enabled at boot AND survives /reload (proves music functions parse clean) ----
  let packs = await rcon("datapack list enabled");
  if (!packs.includes(`${NS}.zip`)) throw new Error(`music datapack not enabled at boot: ${packs}`);
  log(`pack enabled at boot: file/${NS}.zip`);
  await rcon("reload");
  await sleep(1500);
  packs = await rcon("datapack list enabled");
  if (!packs.includes(`${NS}.zip`)) throw new Error(`music datapack lost after /reload (a music command failed to parse?): ${packs}`);
  log("pack still enabled after /reload - all music functions (playsound/note_block/scoreboard) parsed clean");

  // ---- 6. setup places the physical note block + base, wires the clock, build intact ----
  await rcon(`forceload add ${NB.x} ${NB.z} ${NB.x} ${NB.z}`);
  const setupOut = await rcon(`function ${NS}:setup`);
  if (/error|failed|unknown/i.test(setupOut)) throw new Error(`/function ${NS}:setup failed: ${setupOut}`);
  const nbCheck = await rcon(`execute if block ${NB.x} ${NB.y} ${NB.z} minecraft:note_block`);
  if (!/passed/i.test(nbCheck)) throw new Error(`note block NOT placed at ${NB.x} ${NB.y} ${NB.z}: ${nbCheck.trim()}`);
  const baseCheck = await rcon(`execute if block ${NB.x} ${NB.y - 1} ${NB.z} ${baseBlock}`);
  if (!/passed/i.test(baseCheck)) throw new Error(`instrument base ${baseBlock} NOT placed under the note block: ${baseCheck.trim()}`);
  const [vx, vy, vz] = sampleVoxel[0].split(",");
  const voxelCheck = await rcon(`execute if block ${vx} ${vy} ${vz} ${sampleVoxel[1]}`);
  if (!/passed/i.test(voxelCheck)) throw new Error(`build voxel ${sampleVoxel[1]} missing at ${vx} ${vy} ${vz} - music broke the build: ${voxelCheck.trim()}`);
  log(`setup OK: note block + ${baseBlock} placed, sampled build voxel ${sampleVoxel[1]} present (music is additive)`);

  // ---- 7. :start drives the music clock (#mt advances via the tick tag); :stop freezes it ----
  await rcon(`function ${NS}:start`);
  // POLL CADENCE: the music loop is #mtcount*50ms; poll co-prime (90ms) so reads sweep all
  // phases and never phase-lock on the wrap-to-zero tick (the goal-028 false-fail trap).
  const seen = new Set();
  const tPoll = Date.now();
  while (Date.now() - tPoll < 15_000) {
    const m = /has (-?\d+)/.exec(await rcon("scoreboard players get #mt ma"));
    if (m) seen.add(Number(m[1]));
    if ([...seen].some((v) => v > 0)) break;
    await sleep(90);
  }
  if (![...seen].some((v) => v > 0)) {
    throw new Error(`#mt never advanced after :start - the ${NS}:music tick entry is not executing (saw #mt in {${[...seen].join(",") || "empty"}})`);
  }
  log(`music clock live: #mt advanced after :start (sampled {${[...seen].sort((a, b) => a - b).join(",")}})`);
  await rcon(`function ${NS}:stop`);
  const readMt = async () => {
    const m = /has (-?\d+)/.exec(await rcon("scoreboard players get #mt ma"));
    if (!m) throw new Error("could not read #mt after :stop");
    return Number(m[1]);
  };
  const M = await readMt();
  await sleep(700); // > a dozen ticks - if :stop didn't take, #mt (advances every tick) would move
  if ((await readMt()) !== M) throw new Error(`:stop did not freeze the music - #mt still advancing past ${M}`);
  log(`:stop froze the music clock at #mt=${M} (frozen across 700 ms)`);

  await cleanup();
  rmSync(dir, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
  log(`PASS in ${((Date.now() - t0) / 1000).toFixed(1)} s - vanilla server loaded, reloaded, placed the note-block music area, and DROVE the music clock (temp dirs removed)`);
  process.exit(0);
} catch (e) {
  console.error(`[music-e2e] FAIL: ${e.message}`);
  console.error(`[music-e2e] dirs KEPT for debugging: server=${dir} work=${work} (boot log: ${dir}/boot-stdout.log)`);
  await cleanup();
  process.exit(1);
}
