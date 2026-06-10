// datapack-e2e.mjs — headless END-TO-END proof of Blockdream's OFFLINE vanilla import path.
//
// The static validators prove our .mcfunction files LOOK right; this proves a STOCK
// vanilla server actually EXECUTES them. One command, no mods, no Microsoft account:
// renders a real ffmpeg clip → Java datapack via the REAL CLI (packages/cli), installs
// the .zip into a throwaway vanilla 1.21.1 world (scripts/vanilla-server.sh --datapack),
// boots the server, then asserts over RCON that:
//
//   1. the pack is ENABLED (boot-load) and SURVIVES /reload — the exact path a user
//      takes dropping blockdream.zip into world/datapacks/ (supported_formats honored:
//      the pack is stamped pack_format 48, the 1.21.1 server wants 57)
//   2. /function blockdream:setup paints frame 0 CELL-EXACTLY as the emitter intended
//      (sampled `execute if block` asserts against the parsed frames/0.mcfunction)
//   3. /function blockdream:start really animates: the tick-tag driver advances the
//      scoreboard frame counter and the vanilla MACRO dispatch ($function with storage)
//      executes delta frames — after :stop at frame N, sampled delta cells match the
//      cumulative frame-N state reconstructed from the pack's own function files
//
//   clip.mp4 ─CLI→ blockdream.zip ─vanilla-server.sh→ world/datapacks/ ─RCON→ asserts
//
// OPERATOR-GATED: needs JDK 21 + ffmpeg; the one-time ~50MB Mojang jar download is
// skipped when a sha1-valid server.jar is cached in /tmp/bd-server-d2 or .vanilla-server.
//   node tools/mineflayer-collector/datapack-e2e.mjs
// Exit 0 = vanilla executed the datapack correctly. Nonzero = diagnostics; the temp
// server dir is KEPT for debugging.

import { Rcon } from "rcon-client";
import { spawn, execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, copyFileSync, existsSync, rmSync, readFileSync, readdirSync, createWriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const MC_VERSION = "1.21.1";
const RCON_PASS = "blockdream-dp-e2e";
const NS = "blockdream";
const GRID = { w: 32, h: 24 }; // wall size; emitter default origin {x:0,y:64,z:0}, +Z facing
const ORIGIN = { x: 0, y: 64, z: 0 };
const FRAMES = 4;

const log = (m) => console.log(`[datapack-e2e] ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- expected-state reconstruction from the pack's own function files ----------
// Parses setblock/fill/function lines (the only commands frame functions contain) and
// applies them to a sparse world map — the emitter's intent, straight from the artifact.
function applyFunctionFile(fnDir, ref, world) {
  // ref like "blockdream:frames/0" → <fnDir>/frames/0.mcfunction
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
      applyFunctionFile(fnDir, m[1], world); // split sub-functions (partK)
    }
  }
  return world;
}

// deterministic sample of a world map's cells: corners + an even stride, capped
function sampleCells(world, cap) {
  const keys = [...world.keys()].sort();
  if (keys.length <= cap) return keys;
  const stride = Math.ceil(keys.length / (cap - 2));
  const picked = new Set([keys[0], keys[keys.length - 1]]);
  for (let i = 0; i < keys.length && picked.size < cap; i += stride) picked.add(keys[i]);
  return [...picked];
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
process.on("SIGINT", () => { log("SIGINT — cleaning up"); cleanup().finally(() => process.exit(130)); });

const t0 = Date.now();
const dir = mkdtempSync(join(tmpdir(), "bd-datapack-e2e-"));
const work = mkdtempSync(join(tmpdir(), "bd-datapack-e2e-work-"));
try {
  // ---- 1. real input clip (ffmpeg testsrc2: SMPTE-like bars + motion → real frame deltas)
  const ffmpeg = process.env.BLOCKDREAM_FFMPEG || "ffmpeg";
  const clip = join(work, "clip.mp4");
  const ff = spawnSync(ffmpeg, ["-v", "error", "-f", "lavfi", "-i",
    `testsrc2=size=${GRID.w * 4}x${GRID.h * 4}:rate=4:duration=1`, "-y", clip]);
  if (ff.status !== 0) throw new Error(`ffmpeg clip gen failed: ${ff.stderr?.toString().slice(0, 300)}`);
  log(`test clip generated: ${clip}`);

  // ---- 2. render through the REAL CLI — the exact command a user runs
  const outDir = join(work, "out");
  const tsx = join(ROOT, "node_modules/.bin/tsx");
  const cliArgs = ["packages/cli/src/index.ts", "render", clip, "--target", "datapack",
    "--grid", `${GRID.w}x${GRID.h}`, "--max-frames", String(FRAMES), "--speed", "2", "--out", outDir];
  log(`rendering: blockdream render clip.mp4 --target datapack --grid ${GRID.w}x${GRID.h} --max-frames ${FRAMES} --speed 2`);
  const cli = spawnSync(existsSync(tsx) ? tsx : "npx", existsSync(tsx) ? cliArgs : ["tsx", ...cliArgs],
    { cwd: ROOT, encoding: "utf8" });
  if (cli.status !== 0) throw new Error(`CLI render failed (${cli.status}): ${cli.stderr?.slice(0, 500)}`);
  process.stdout.write(cli.stdout.split("\n").map((l) => `[cli] ${l}`).join("\n") + "\n");
  const zip = join(outDir, `${NS}.zip`);
  if (!existsSync(zip)) throw new Error(`CLI did not write ${zip}`);

  // ---- 3. reconstruct the emitter's intended wall states from the pack's own files
  const fnDir = join(outDir, "data", NS, "function");
  const frameFiles = readdirSync(join(fnDir, "frames")).filter((f) => /^\d+\.mcfunction$/.test(f));
  if (frameFiles.length !== FRAMES) throw new Error(`expected ${FRAMES} frame functions, found ${frameFiles.length}`);
  const stateAt = []; // stateAt[N] = world map after dispatching frames 0..N (frame 0 = keyframe)
  let world = new Map();
  for (let i = 0; i < FRAMES; i++) {
    world = applyFunctionFile(fnDir, `${NS}:frames/${i}`, new Map(world));
    stateAt.push(world);
  }
  log(`expected states reconstructed: keyframe ${stateAt[0].size} cells, deltas ${stateAt.slice(1).map((s, i) => {
    let d = 0; for (const [k, v] of s) if (stateAt[i].get(k) !== v) d++; return d;
  }).join("/")} changed cells`);
  if (stateAt[0].size !== GRID.w * GRID.h) throw new Error(`keyframe covers ${stateAt[0].size} cells, want ${GRID.w * GRID.h}`);

  // ---- 4. throwaway vanilla server with the datapack installed PRE-BOOT (boot-load path)
  for (const cache of ["/tmp/bd-server-d2", join(ROOT, ".vanilla-server")]) {
    if (existsSync(join(cache, "server.jar")) && existsSync(join(cache, "server.jar.sha1"))) {
      copyFileSync(join(cache, "server.jar"), join(dir, "server.jar"));
      copyFileSync(join(cache, "server.jar.sha1"), join(dir, "server.jar.sha1"));
      log(`seeded cached server.jar from ${cache}`);
      break;
    }
  }
  log(`bootstrapping vanilla ${MC_VERSION} in ${dir} (datapack pre-installed)`);
  execFileSync("bash", [join(ROOT, "scripts/vanilla-server.sh"), "--dir", dir, "--rcon-pass", RCON_PASS,
    "--datapack", zip, "--no-start"], { stdio: "inherit" });

  const javaHome = execFileSync("/usr/libexec/java_home", ["-v", "21"]).toString().trim();
  log(`starting server (java 21 @ ${javaHome}) — waiting for RCON (≤180 s)`);
  server = spawn(join(javaHome, "bin", "java"), ["-Xmx2G", "-jar", "server.jar", "nogui"], {
    cwd: dir, env: { ...process.env, JAVA_HOME: javaHome }, stdio: ["ignore", "pipe", "pipe"],
  });
  const bootLog = createWriteStream(join(dir, "boot-stdout.log"));
  server.stdout.pipe(bootLog); server.stderr.pipe(bootLog);
  await new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error(`server not ready after 180 s — see ${dir}/boot-stdout.log`)), 180_000);
    let buf = "";
    const onData = (d) => {
      buf += d.toString();
      if (/RCON running on/.test(buf)) {
        server.stdout.off("data", onData); clearTimeout(timer);
        log("server ready (RCON listening)"); res();
      }
    };
    server.stdout.on("data", onData);
    server.once("exit", (code) => { clearTimeout(timer); rej(new Error(`server exited early (code ${code}) — see ${dir}/boot-stdout.log`)); });
  });

  rconClient = await Rcon.connect({ host: "127.0.0.1", port: 25575, password: RCON_PASS });
  const rcon = (cmd) => rconClient.send(cmd);

  // ---- 5. pack is enabled at boot AND survives /reload (the documented user flow)
  let packs = await rcon("datapack list enabled");
  if (!packs.includes(`${NS}.zip`)) throw new Error(`datapack not enabled at boot: ${packs}`);
  log(`pack enabled at boot: file/${NS}.zip (server pack_format 57, pack stamped 48 + supported_formats)`);
  await rcon("reload");
  await sleep(1500); // reload is async on the server thread
  packs = await rcon("datapack list enabled");
  if (!packs.includes(`${NS}.zip`)) throw new Error(`datapack lost after /reload: ${packs}`);
  log("pack still enabled after /reload");

  // ---- 6. setup paints frame 0 — cell-exact against the emitter's intent
  // (setup forceloads the wall strip itself; clear the plane first so stale terrain
  //  can never fake a pass, then assert EXACT expected blocks, air included)
  await rcon(`forceload add ${ORIGIN.x} ${ORIGIN.z} ${ORIGIN.x + GRID.w - 1} ${ORIGIN.z}`);
  await rcon(`fill ${ORIGIN.x} ${ORIGIN.y} ${ORIGIN.z} ${ORIGIN.x + GRID.w - 1} ${ORIGIN.y + GRID.h - 1} ${ORIGIN.z} minecraft:air`);
  const setupOut = await rcon(`function ${NS}:setup`);
  if (/error|failed|unknown/i.test(setupOut)) throw new Error(`/function ${NS}:setup failed: ${setupOut}`);
  const count = await rcon("scoreboard players get #count ma");
  if (!count.includes(` ${FRAMES} `) && !count.includes(`has ${FRAMES}`)) {
    throw new Error(`setup scoreboard wiring wrong — #count: ${count}`);
  }

  const assertCells = async (state, keys, label) => {
    let pass = 0;
    const fails = [];
    for (const k of keys) {
      const [x, y, z] = k.split(",");
      const want = state.get(k);
      const r = await rcon(`execute if block ${x} ${y} ${z} ${want}`);
      if (/passed/i.test(r)) pass++;
      else fails.push(`(${k}) want ${want} → ${r.trim() || "(empty)"}`);
    }
    log(`${label}: ${pass}/${keys.length} sampled cells exact-match`);
    for (const f of fails.slice(0, 6)) log(`  ✗ ${f}`);
    if (pass !== keys.length) throw new Error(`${label}: ${fails.length} cell(s) wrong — vanilla did not execute the pack as emitted`);
  };
  await assertCells(stateAt[0], sampleCells(stateAt[0], 24), "frame-0 (setup keyframe)");

  // ---- 7. start → the tick driver + vanilla MACRO dispatch must really animate
  await rcon(`function ${NS}:start`);
  let fLine = "";
  const tPoll = Date.now();
  let advanced = false;
  while (Date.now() - tPoll < 15_000) {
    await sleep(400);
    fLine = await rcon("scoreboard players get #f ma");
    const m = /has (\d+)/.exec(fLine);
    if (m && Number(m[1]) > 0) { advanced = true; break; }
  }
  if (!advanced) throw new Error(`frame counter never advanced after :start — macro driver not ticking (last: ${fLine})`);
  await rcon(`function ${NS}:stop`);
  const mF = /has (\d+)/.exec(await rcon("scoreboard players get #f ma"));
  if (!mF) throw new Error("could not read #f after :stop");
  const N = Number(mF[1]);
  if (N < 0 || N >= FRAMES) throw new Error(`#f out of range after stop: ${N}`);
  log(`animation ran and stopped deterministically at frame ${N}`);

  // assert the cells that CHANGED in deltas 1..N (the macro-dispatched ones); at N=0
  // (wrapped a whole loop) the keyframe repaint makes frame-0 state the truth again
  const changed = new Set();
  for (let i = 1; i <= N; i++) for (const [k, v] of stateAt[i]) if (stateAt[i - 1].get(k) !== v) changed.add(k);
  const animKeys = changed.size > 0 ? sampleCells(new Map([...changed].map((k) => [k, 1])), 16) : sampleCells(stateAt[0], 8);
  await assertCells(stateAt[N], animKeys, `frame-${N} (after macro-dispatched deltas)`);

  await cleanup();
  rmSync(dir, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
  log(`PASS in ${((Date.now() - t0) / 1000).toFixed(1)} s — vanilla server loaded, reloaded, painted and ANIMATED the generated datapack (temp dirs removed)`);
  process.exit(0);
} catch (e) {
  console.error(`[datapack-e2e] FAIL: ${e.message}`);
  console.error(`[datapack-e2e] dirs KEPT for debugging: server=${dir} work=${work} (boot log: ${dir}/boot-stdout.log)`);
  await cleanup();
  process.exit(1);
}
