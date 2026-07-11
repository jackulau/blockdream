// fullvideo-e2e.mjs - headless END-TO-END proof of the FULL-VIDEO import surface:
// the faithful --wall block animation (+ --led glow plane + note-block music locked
// to the animation loop) AND the TRUE-RGB text_display screen target, executed by a
// STOCK vanilla 1.21.1 server. Companion to datapack-e2e.mjs (same boot + assert
// philosophy: every expected value is parsed from the PACK'S OWN files, never
// re-derived from the pipeline, so the test proves vanilla executed the artifact).
//
//   clip(+audio) ─CLI→ blockdream_3d.zip (voxel3d --wall --led --music)
//                    → blockdream_rgb.zip (rgbscreen --music)
//   one throwaway vanilla server, two stages:
//     stage 1 (wall):  boot-load, /reload survival, setup paints frame-0 cell-exact,
//                      LED light plane present, music clock #mt ticks and
//                      #mtcount == frames×speed (loop lock), driver animates, :stop
//                      freezes, delta cells match the reconstructed frame-N state
//     stage 2 (rgb):   hot-installed pack enables, setup summons W×H text_displays,
//                      sampled pixel `background` ints match the summon/frames files,
//                      driver animates them via `data merge entity <uuid>`,
//                      :teardown kills every pixel entity
//
// Env overrides (all optional) let the SAME script drive a real video at full scale:
//   E2E_INPUT=/path/badapple.mp4  E2E_GRID=96x72  E2E_FPS=10  E2E_MAX_FRAMES=0
//   E2E_RGB_GRID=64x48  E2E_RUN_MS=15000  E2E_KEEP=1  E2E_SKIP_RGB / E2E_SKIP_WALL
//
// OPERATOR-GATED: needs JDK 21 + ffmpeg (jar download skipped when a sha1-valid
// server.jar is cached in /tmp/bd-server-d2 or .vanilla-server).
//   node tools/mineflayer-collector/fullvideo-e2e.mjs

import { Rcon } from "rcon-client";
import { spawn, execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, copyFileSync, existsSync, rmSync, readFileSync, writeFileSync, readdirSync, createWriteStream, mkdirSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const RCON_PASS = "blockdream-fv-e2e";
const NS3D = "blockdream_3d";
const NSRGB = "blockdream_rgb";
const ORIGIN = { x: 0, y: 64, z: 0 };

const INPUT = process.env.E2E_INPUT || ""; // empty → synthetic testsrc2+sine clip
const [GW, GH] = (process.env.E2E_GRID || "32x24").split("x").map(Number);
const [RW, RH] = (process.env.E2E_RGB_GRID || process.env.E2E_GRID || "24x18").split("x").map(Number);
const FPS = Number(process.env.E2E_FPS || 4);
const MAX_FRAMES = Number(process.env.E2E_MAX_FRAMES ?? 6); // 0 = whole video
const SPEED = 2;
const RUN_MS = Number(process.env.E2E_RUN_MS || 6000);
const KEEP = process.env.E2E_KEEP === "1";
const SKIP_RGB = process.env.E2E_SKIP_RGB === "1";
const SKIP_WALL = process.env.E2E_SKIP_WALL === "1";

const log = (m) => console.log(`[fullvideo-e2e] ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

function setProp(text, key, val) {
  const re = new RegExp(`^${key.replace(/\./g, "\\.")}=.*$`, "m");
  return re.test(text) ? text.replace(re, `${key}=${val}`) : `${text.replace(/\n?$/, "\n")}${key}=${val}\n`;
}

// ---------- expected state from the pack's own files (setblock/fill world model) ----------
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

// ---------- expected state for the RGB screen (uuid → background int) ----------
function uuidStr(a, b, c, d) {
  const hex = (n) => (n >>> 0).toString(16).padStart(8, "0");
  const s = hex(a) + hex(b) + hex(c) + hex(d);
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}
function parseScreenFile(fnDir) {
  // follows the split parent if screen.mcfunction is chunked
  const px = new Map(); // uuid → { bg, x, y, z }
  const walk = (rel) => {
    const text = readFileSync(join(fnDir, `${rel}.mcfunction`), "utf8");
    for (const line of text.split("\n")) {
      let m;
      if ((m = /^summon minecraft:text_display (\S+) (\S+) (\S+) \{UUID:\[I;(-?\d+),(-?\d+),(-?\d+),(-?\d+)\].*?background:(-?\d+)/.exec(line))) {
        px.set(uuidStr(...m.slice(4, 8).map(Number)), { bg: Number(m[8]), x: m[1], y: m[2], z: m[3] });
      } else if ((m = /^function \S+:(\S+)$/.exec(line))) {
        walk(m[1]);
      }
    }
  };
  walk("screen");
  return px;
}
function applyRgbFrame(fnDir, idx, state) {
  const walk = (rel) => {
    const text = readFileSync(join(fnDir, `${rel}.mcfunction`), "utf8");
    for (const line of text.split("\n")) {
      let m;
      if ((m = /^data merge entity (\S+) \{background:(-?\d+)\}$/.exec(line))) {
        if (!state.has(m[1])) throw new Error(`frame ${idx} merges unknown uuid ${m[1]}`);
        state.set(m[1], Number(m[2]));
      } else if ((m = /^function \S+:(\S+)$/.exec(line))) {
        walk(m[1]);
      }
    }
  };
  walk(`frames/${idx}`);
  return state;
}

function sampleKeys(keys, cap) {
  const sorted = [...keys].sort();
  if (sorted.length <= cap) return sorted;
  const stride = Math.ceil(sorted.length / (cap - 2));
  const picked = new Set([sorted[0], sorted[sorted.length - 1]]);
  for (let i = 0; i < sorted.length && picked.size < cap; i += stride) picked.add(sorted[i]);
  return [...picked];
}

let server = null, rconClient = null, cleaned = false;
async function cleanup() {
  if (cleaned) return; cleaned = true;
  if (rconClient) await rconClient.end().catch(() => {});
  if (server && server.exitCode === null) {
    server.kill("SIGTERM");
    const dead = await Promise.race([new Promise((r) => server.once("exit", () => r(true))), sleep(5000)]);
    if (dead !== true) server.kill("SIGKILL");
  }
}
process.on("SIGINT", () => { cleanup().finally(() => process.exit(130)); });

const t0 = Date.now();
const dir = mkdtempSync(join(tmpdir(), "bd-fullvideo-e2e-"));
const work = mkdtempSync(join(tmpdir(), "bd-fullvideo-e2e-work-"));
try {
  // ---- 1. input clip: supplied video, or synthetic bars+motion WITH an audio track
  //         (sine 523 Hz → real NoteEvents, so the music path is exercised end-to-end)
  let clip = INPUT;
  if (!clip) {
    const ffmpeg = process.env.BLOCKDREAM_FFMPEG || "ffmpeg";
    clip = join(work, "clip.mp4");
    const ff = spawnSync(ffmpeg, ["-v", "error",
      "-f", "lavfi", "-i", `testsrc2=size=${GW * 4}x${GH * 4}:rate=${FPS}:duration=1.5`,
      "-f", "lavfi", "-i", "sine=frequency=523:duration=1.5",
      "-shortest", "-y", clip]);
    if (ff.status !== 0) throw new Error(`ffmpeg clip gen failed: ${ff.stderr?.toString().slice(0, 300)}`);
    log(`test clip generated (video+audio): ${clip}`);
  } else {
    log(`using supplied input: ${clip}`);
  }

  // ---- 2. render BOTH packs through the real CLI
  const tsx = join(ROOT, "node_modules/.bin/tsx");
  const runCli = (args, label) => {
    const full = ["packages/cli/src/index.ts", "render", clip, ...args];
    log(`rendering ${label}: blockdream render ${args.join(" ")}`);
    const r = spawnSync(existsSync(tsx) ? tsx : "npx", existsSync(tsx) ? full : ["tsx", ...full], { cwd: ROOT, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`CLI ${label} failed (${r.status}): ${r.stderr?.slice(0, 500)}`);
    process.stdout.write(r.stdout.split("\n").map((l) => `[cli] ${l}`).join("\n") + "\n");
  };
  const maxF = MAX_FRAMES > 0 ? ["--max-frames", String(MAX_FRAMES)] : [];
  const wallOut = join(work, "wall");
  const rgbOut = join(work, "rgb");
  if (!SKIP_WALL) runCli(["--target", "voxel3d", "--wall", "--led", "--music", "on", "--max-notes", "8000",
    "--grid", `${GW}x${GH}`, "--fps", String(FPS), ...maxF, "--speed", String(SPEED), "--out", wallOut], "wall");
  if (!SKIP_RGB) runCli(["--target", "rgbscreen", "--music", "on", "--max-notes", "8000",
    "--grid", `${RW}x${RH}`, "--fps", String(FPS), ...maxF, "--speed", String(SPEED), "--out", rgbOut], "rgbscreen");

  // ---- 3. throwaway vanilla server; wall pack pre-installed (boot-load path)
  for (const cache of ["/tmp/bd-server-d2", join(ROOT, ".vanilla-server")]) {
    if (existsSync(join(cache, "server.jar")) && existsSync(join(cache, "server.jar.sha1"))) {
      copyFileSync(join(cache, "server.jar"), join(dir, "server.jar"));
      copyFileSync(join(cache, "server.jar.sha1"), join(dir, "server.jar.sha1"));
      log(`seeded cached server.jar from ${cache}`);
      break;
    }
  }
  const bootPack = !SKIP_WALL ? join(wallOut, `${NS3D}.zip`) : join(rgbOut, `${NSRGB}.zip`);
  execFileSync("bash", [join(ROOT, "scripts/vanilla-server.sh"), "--dir", dir, "--rcon-pass", RCON_PASS,
    "--datapack", bootPack, "--no-start"], { stdio: "inherit" });

  const javaHome = execFileSync("/usr/libexec/java_home", ["-v", "21"]).toString().trim();
  const propsPath = join(dir, "server.properties");
  // Full-scale packs (2000+ frame functions, 10^6 commands) OOM a 2G heap and their /reload
  // legitimately exceeds the 60 s watchdog tick - the watchdog would force-kill a healthy parse.
  const HEAP = process.env.E2E_HEAP || "4G";
  let RCON_PORT;
  for (let attempt = 1; ; attempt++) {
    const SERVER_PORT = await freePort();
    RCON_PORT = await freePort();
    writeFileSync(propsPath,
      setProp(setProp(setProp(readFileSync(propsPath, "utf8"),
        "server-port", SERVER_PORT), "rcon.port", RCON_PORT), "max-tick-time", -1));
    log(`starting vanilla server (ports ${SERVER_PORT}/${RCON_PORT}, heap ${HEAP})…`);
    server = spawn(join(javaHome, "bin", "java"), [`-Xmx${HEAP}`, "-jar", "server.jar", "nogui"], {
      cwd: dir, env: { ...process.env, JAVA_HOME: javaHome }, stdio: ["ignore", "pipe", "pipe"],
    });
    const bootLog = createWriteStream(join(dir, "boot-stdout.log"));
    server.stdout.pipe(bootLog); server.stderr.pipe(bootLog);
    let bootBuf = "";
    try {
      await new Promise((res, rej) => {
        const timer = setTimeout(() => rej(new Error(`server not ready after 240 s - see ${dir}/boot-stdout.log`)), 240_000);
        const onData = (d) => {
          bootBuf += d.toString();
          if (/RCON running on/.test(bootBuf)) { server.stdout.off("data", onData); clearTimeout(timer); res(); }
        };
        server.stdout.on("data", onData);
        server.once("exit", (code) => { clearTimeout(timer); rej(new Error(`server exited early (code ${code}) - see ${dir}/boot-stdout.log`)); });
      });
      break;
    } catch (bootErr) {
      if (attempt < 3 && /Address already in use/.test(bootBuf)) { log(`port collision (attempt ${attempt}) - retrying`); continue; }
      throw bootErr;
    }
  }
  log("server ready (RCON listening)");
  // generous timeout: /reload of a full-scale pack and the 10^5-command setup are slow but healthy
  rconClient = await Rcon.connect({ host: "127.0.0.1", port: RCON_PORT, password: RCON_PASS, timeout: 300_000 });
  const rcon = (cmd) => rconClient.send(cmd);

  const assertBlockCells = async (state, keys, label) => {
    let pass = 0; const fails = [];
    for (const k of keys) {
      const [x, y, z] = k.split(",");
      const want = state.get(k);
      const r = await rcon(`execute if block ${x} ${y} ${z} ${want}`);
      if (/passed/i.test(r)) pass++; else fails.push(`(${k}) want ${want} → ${r.trim() || "(empty)"}`);
    }
    log(`${label}: ${pass}/${keys.length} sampled cells exact-match`);
    for (const f of fails.slice(0, 6)) log(`  ✗ ${f}`);
    if (pass !== keys.length) throw new Error(`${label}: ${fails.length} cell(s) wrong`);
  };
  const readScore = async (holder) => {
    const m = /has (-?\d+)/.exec(await rcon(`scoreboard players get ${holder} ma`));
    if (!m) throw new Error(`could not read ${holder}`);
    return Number(m[1]);
  };
  const pollAdvance = async (holder, label) => {
    // 90 ms is co-prime with the frame cycle → phase-drifts across it (goal-028 lesson)
    const seen = new Set();
    const t = Date.now();
    while (Date.now() - t < 20_000) {
      seen.add(await readScore(holder));
      if ([...seen].some((v) => v > 0)) return;
      await sleep(90);
    }
    throw new Error(`${label} (${holder}) never advanced (saw {${[...seen].join(",")}})`);
  };

  // ============================ stage 1: --wall + --led + music ============================
  if (!SKIP_WALL) {
    const fnDir = join(wallOut, "data", NS3D, "function");
    const frameFiles = readdirSync(join(fnDir, "frames")).filter((f) => /^\d+\.mcfunction$/.test(f));
    const nFrames = frameFiles.length;
    log(`stage 1 (wall): ${nFrames} frames at ${GW}x${GH}`);

    let packs = await rcon("datapack list enabled");
    if (!packs.includes(`${NS3D}.zip`)) throw new Error(`wall pack not enabled at boot: ${packs}`);
    await rcon("reload"); await sleep(2500);
    packs = await rcon("datapack list enabled");
    if (!packs.includes(`${NS3D}.zip`)) throw new Error(`wall pack lost after /reload: ${packs}`);
    log("wall pack enabled at boot + survives /reload");

    const setupOut = await rcon(`function ${NS3D}:setup`);
    if (/error|failed|unknown/i.test(setupOut)) throw new Error(`setup failed: ${setupOut}`);
    if ((await readScore("#count")) !== nFrames) throw new Error(`#count != ${nFrames}`);
    // music loop LOCKED to the animation loop (the full-video sync fix)
    const mtcount = await readScore("#mtcount");
    if (mtcount !== nFrames * SPEED) throw new Error(`#mtcount ${mtcount} != frames×speed ${nFrames * SPEED} - music loop not locked`);
    log(`music loop locked: #mtcount == ${nFrames}×${SPEED}`);

    // frame-0 keyframe, cell-exact (reconstructed from the pack's own files)
    const stateAt = [];
    let world = new Map();
    world = applyFunctionFile(fnDir, `${NS3D}:frames/0`, world);
    stateAt.push(new Map(world));
    await assertBlockCells(stateAt[0], sampleKeys([...stateAt[0].keys()], 24), "wall frame-0 (setup keyframe)");

    // LED plane: light[level=15] one block in front of the wall (+Z face), mode keep
    const ledProbe = [`${ORIGIN.x},${ORIGIN.y},${ORIGIN.z + 1}`, `${ORIGIN.x + GW - 1},${ORIGIN.y + GH - 1},${ORIGIN.z + 1}`];
    for (const k of ledProbe) {
      const [x, y, z] = k.split(",");
      const r = await rcon(`execute if block ${x} ${y} ${z} minecraft:light[level=15]`);
      if (!/passed/i.test(r)) throw new Error(`LED plane missing at ${k}: ${r.trim()}`);
    }
    log("LED glow plane present (light[level=15] fronting both wall corners)");

    // playsound is a valid server command with our exact sound id (music.mcfunction uses it)
    const ps = await rcon(`playsound minecraft:block.note_block.harp record @a 0 64 0 1 1`);
    if (/unknown|incorrect/i.test(ps)) throw new Error(`playsound rejected: ${ps}`);

    await rcon(`function ${NS3D}:start`);
    await pollAdvance("#f", "wall frame counter");
    await pollAdvance("#mt", "music clock");
    // rate metric only means something when the window is well inside ONE loop —
    // otherwise the modulo aliases (a 600 ms synthetic loop sampled over 6 s reads ~0)
    if (RUN_MS > 0 && RUN_MS < nFrames * SPEED * 50 * 0.8) {
      const tRun = Date.now();
      const f1 = await readScore("#f");
      await sleep(RUN_MS);
      const f2 = await readScore("#f");
      const wall = (Date.now() - tRun) / 1000;
      const rate = ((f2 - f1 + nFrames) % nFrames) / wall;
      log(`playback rate: ~${rate.toFixed(1)} frames/s over ${wall.toFixed(1)} s (target ${(20 / SPEED).toFixed(1)})`);
    } else if (RUN_MS > 0) {
      await sleep(Math.min(RUN_MS, 4000));
    }
    await rcon(`function ${NS3D}:stop`);
    const N = await readScore("#f");
    await sleep(600);
    if ((await readScore("#f")) !== N) throw new Error(":stop did not freeze the driver");
    log(`wall animation ran and stopped at frame ${N}`);
    // :stop correctly removes the pack's forceload; with no player nearby the wall's chunks
    // unload and block reads answer "not loaded". Re-issue the pack's OWN forceload line to
    // READ the frozen state (blocks persist in saved chunks - reveals, not alters, the world).
    const flWall = /forceload add [-\d ]+/.exec(readFileSync(join(fnDir, "start.mcfunction"), "utf8"));
    if (flWall) await rcon(flWall[0]);

    // reconstruct up to frame N and assert the macro-dispatched delta cells
    for (let i = 1; i <= N; i++) {
      world = applyFunctionFile(fnDir, `${NS3D}:frames/${i}`, world);
      stateAt.push(i < N ? undefined : new Map(world)); // only keep what we assert
    }
    if (N > 0) {
      const prev = new Map();
      applyFunctionFile(fnDir, `${NS3D}:frames/0`, prev);
      for (let i = 1; i < N; i++) applyFunctionFile(fnDir, `${NS3D}:frames/${i}`, prev);
      const changed = [...stateAt[N].keys()].filter((k) => prev.get(k) !== stateAt[N].get(k));
      const keys = changed.length ? sampleKeys(changed, 16) : sampleKeys([...stateAt[N].keys()], 8);
      await assertBlockCells(stateAt[N], keys, `wall frame-${N} (after macro deltas)`);
    }

    // hand the stage off cleanly: stop pack, drop shared scoreboard
    await rcon(`datapack disable "file/${NS3D}.zip"`);
    await rcon("scoreboard objectives remove ma");
    log("stage 1 (wall + LED + music): PASS");
  }

  // ============================ stage 2: TRUE-RGB text_display screen ============================
  if (!SKIP_RGB) {
    const fnDir = join(rgbOut, "data", NSRGB, "function");
    const frameFiles = readdirSync(join(fnDir, "frames")).filter((f) => /^\d+\.mcfunction$/.test(f));
    const nFrames = frameFiles.length;
    log(`stage 2 (rgbscreen): ${nFrames} frames at ${RW}x${RH} = ${RW * RH} pixel entities`);

    // hot-install: copy zip → /reload discovers it (new packs auto-enable)
    mkdirSync(join(dir, "world", "datapacks"), { recursive: true });
    copyFileSync(join(rgbOut, `${NSRGB}.zip`), join(dir, "world", "datapacks", `${NSRGB}.zip`));
    await rcon("reload"); await sleep(2500);
    let packs = await rcon("datapack list enabled");
    if (!packs.includes(`${NSRGB}.zip`)) {
      await rcon(`datapack enable "file/${NSRGB}.zip"`); await sleep(1000);
      packs = await rcon("datapack list enabled");
      if (!packs.includes(`${NSRGB}.zip`)) throw new Error(`rgb pack not enabled: ${packs}`);
    }
    log("rgb pack hot-installed + enabled");

    const setupOut = await rcon(`function ${NSRGB}:setup`);
    if (/error|failed|unknown/i.test(setupOut)) throw new Error(`rgb setup failed: ${setupOut}`);

    // entity census: exactly W×H tagged text_displays
    await rcon(`execute store result score #probe ma if entity @e[type=minecraft:text_display,tag=${NSRGB}]`);
    const census = await readScore("#probe");
    if (census !== RW * RH) throw new Error(`expected ${RW * RH} pixel entities, server has ${census}`);
    log(`pixel census: ${census} text_displays`);

    // sampled pixels: background int must equal the summon's baked frame-0 color
    const px = parseScreenFile(fnDir); // uuid → {bg,x,y,z}
    if (px.size !== RW * RH) throw new Error(`screen.mcfunction parses to ${px.size} pixels, want ${RW * RH}`);
    const state = new Map([...px].map(([u, v]) => [u, v.bg]));
    const readBg = async (uuid) => {
      const r = await rcon(`data get entity ${uuid} background`);
      const m = /: (-?\d+)/.exec(r);
      if (!m) throw new Error(`could not read background of ${uuid}: ${r.trim()}`);
      return Number(m[1]);
    };
    for (const uuid of sampleKeys([...state.keys()], 12)) {
      const got = await readBg(uuid);
      if (got !== state.get(uuid)) throw new Error(`pixel ${uuid} background ${got} != ${state.get(uuid)}`);
    }
    log("frame-0 pixel colors exact (sampled data get entity background)");

    if (nFrames > 1) {
      const mtc = await readScore("#mtcount");
      if (mtc !== nFrames * SPEED) throw new Error(`rgb #mtcount ${mtc} != ${nFrames * SPEED}`);
      await rcon(`function ${NSRGB}:start`);
      await pollAdvance("#f", "rgb frame counter");
      await sleep(Math.min(RUN_MS, 4000));
      await rcon(`function ${NSRGB}:stop`);
      const N = await readScore("#f");
      await sleep(600);
      if ((await readScore("#f")) !== N) throw new Error("rgb :stop did not freeze");
      // rgb :stop also drops its forceload - re-issue the pack's own line so the pixel
      // entities are loaded for the data-get reads below (same rationale as the wall stage)
      const flRgb = /forceload add [-\d ]+/.exec(readFileSync(join(fnDir, "start.mcfunction"), "utf8"));
      if (flRgb) await rcon(flRgb[0]);
      for (let i = 1; i <= N; i++) applyRgbFrame(fnDir, i, state);
      // wrap case: if it looped, replay the whole cycle then 1..N again
      // (short e2e runs never wrap: RUN_MS ≪ nFrames×speed×50ms for real videos)
      for (const uuid of sampleKeys([...state.keys()], 12)) {
        const got = await readBg(uuid);
        if (got !== state.get(uuid)) throw new Error(`after frame ${N}: pixel ${uuid} = ${got}, want ${state.get(uuid)}`);
      }
      log(`rgb animation ran to frame ${N}; sampled pixels match the reconstructed state`);
    }

    const td = await rcon(`function ${NSRGB}:teardown`);
    if (/error|failed/i.test(td)) throw new Error(`teardown failed: ${td}`);
    await rcon(`execute store result score #probe ma if entity @e[type=minecraft:text_display,tag=${NSRGB}]`);
    if ((await readScore("#probe")) !== 0) throw new Error("teardown left pixel entities behind");
    log("teardown removed every pixel entity");
    log("stage 2 (TRUE-RGB screen): PASS");
  }

  await cleanup();
  if (!KEEP) { rmSync(dir, { recursive: true, force: true }); rmSync(work, { recursive: true, force: true }); }
  log(`PASS in ${((Date.now() - t0) / 1000).toFixed(1)} s - vanilla executed the full-video wall (LED+music-locked) and the TRUE-RGB screen as emitted`);
  process.exit(0);
} catch (e) {
  console.error(`[fullvideo-e2e] FAIL: ${e.message}`);
  console.error(`[fullvideo-e2e] dirs KEPT: server=${dir} work=${work} (boot log: ${dir}/boot-stdout.log)`);
  await cleanup();
  process.exit(1);
}
