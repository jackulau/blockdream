// redstone-music-e2e.mjs - headless END-TO-END proof that Blockdream's REDSTONE music
// engine (--music-engine redstone) builds a PHYSICAL note-block instrument that a stock
// vanilla server actually drives. The playsound engine has its own e2e
// (music-datapack-e2e.mjs); this proves the redstone delay-line CONDUCTS on real hardware.
//
// One command, no mods: renders a real ffmpeg clip with a MULTI-TONE audio track (so the
// transcription yields several notes at different ticks → a repeater delay-line with real
// repeaters) → voxel3d datapack with `--music on --music-engine redstone` (REAL CLI),
// installs it into a throwaway vanilla 1.21.1 world, boots it, then asserts over RCON:
//
//   1. the pack is ENABLED at boot AND SURVIVES /reload - reload re-parses every function,
//      so a clean reload proves the repeater[facing=west,delay=N] / redstone_wire /
//      redstone_block / note_block blockstates the redstone path emits are vanilla-LEGAL
//   2. :setup builds the physical track - tuned note blocks + their instrument bases + the
//      redstone spine (dust) + the repeater delay-line - and leaves the BUILD intact
//   3. THE ENGINE CONDUCTS: forcing the input redstone_block ON, the pulse propagates the
//      full length of the delay-line and the LAST repeater latches powered=true. This is
//      the redstone analog of "the music clock advances" - it proves the note blocks are
//      actually wired to be struck in onset order (and validates repeater facing on a real
//      server, not from memory).
//   4. :start re-pulses the line each loop (#mt advances via the tick tag); :stop freezes it
//
//   clip(+multitone audio) ─CLI(--music-engine redstone)→ blockdream_3d.zip ─server→ RCON asserts
//
// OPERATOR-GATED (like music-datapack-e2e): needs JDK 21 + ffmpeg; the one-time ~50MB Mojang
// jar download is skipped when a sha1-valid server.jar is cached in /tmp/bd-server-d2 or
// .vanilla-server. In verify-all it is `node --check`ed always and run live under BLOCKDREAM_E2E=1.
//   node tools/mineflayer-collector/redstone-music-e2e.mjs
// Exit 0 = vanilla drove the redstone instrument. Nonzero = diagnostics; temp dirs KEPT.

import { Rcon } from "rcon-client";
import { spawn, execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, copyFileSync, existsSync, rmSync, readFileSync, writeFileSync, createWriteStream } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const MC_VERSION = "1.21.1";
const RCON_PASS = "blockdream-redstone-e2e";
const NS = "blockdream_3d";
const GRID = { w: 12, h: 12 };
const FRAMES = 3;

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

const log = (m) => console.log(`[redstone-e2e] ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
const dir = mkdtempSync(join(tmpdir(), "bd-redstone-e2e-"));
const work = mkdtempSync(join(tmpdir(), "bd-redstone-e2e-work-"));
try {
  // ---- 1. clip with a MULTI-TONE audio track (stepped sines → several distinct-tick notes) ----
  const ffmpeg = process.env.BLOCKDREAM_FFMPEG || "ffmpeg";
  const clip = join(work, "clip.mp4");
  const ff = spawnSync(ffmpeg, ["-v", "error",
    "-f", "lavfi", "-i", `testsrc2=size=${GRID.w * 4}x${GRID.h * 4}:rate=4:duration=2`,
    "-f", "lavfi", "-i", "sine=frequency=330:duration=0.5",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=0.5",
    "-f", "lavfi", "-i", "sine=frequency=554:duration=0.5",
    "-f", "lavfi", "-i", "sine=frequency=660:duration=0.5",
    "-filter_complex", "[1][2][3][4]concat=n=4:v=0:a=1[a]",
    "-map", "0:v", "-map", "[a]", "-shortest", "-y", clip]);
  if (ff.status !== 0) throw new Error(`ffmpeg clip gen failed: ${ff.stderr?.toString().slice(0, 300)}`);
  log(`test clip (video + 4 stepped tones) generated: ${clip}`);

  // ---- 2. render voxel3d with --music-engine redstone through the REAL CLI ----
  const outDir = join(work, "out");
  const tsx = join(ROOT, "node_modules/.bin/tsx");
  const cliArgs = ["packages/cli/src/index.ts", "render", clip, "--target", "voxel3d",
    "--music", "on", "--music-engine", "redstone",
    "--grid", `${GRID.w}x${GRID.h}`, "--max-frames", String(FRAMES), "--out", outDir];
  log(`rendering: blockdream render clip.mp4 --target voxel3d --music on --music-engine redstone`);
  const cli = spawnSync(existsSync(tsx) ? tsx : "npx", existsSync(tsx) ? cliArgs : ["tsx", ...cliArgs],
    { cwd: ROOT, encoding: "utf8" });
  if (cli.status !== 0) throw new Error(`CLI render failed (${cli.status}): ${cli.stderr?.slice(0, 500)}`);
  process.stdout.write(cli.stdout.split("\n").map((l) => `[cli] ${l}`).join("\n") + "\n");
  const zip = join(outDir, `${NS}.zip`);
  if (!existsSync(zip)) throw new Error(`CLI did not write ${zip}`);

  // ---- 3. parse the EMITTED artifact: note blocks, the repeater delay-line, the pulse input ----
  const fnDir = join(outDir, "data", NS, "function");
  const setupText = readFileSync(join(fnDir, "setup.mcfunction"), "utf8");
  const musicText = readFileSync(join(fnDir, "music.mcfunction"), "utf8");

  // redstone mode MUST NOT emit playsound (the melody is physical, not a sound effect)
  if (/playsound/.test(musicText)) throw new Error("redstone engine emitted a playsound - it should be physical");

  const noteBlocks = [...setupText.matchAll(/^setblock (-?\d+) (-?\d+) (-?\d+) (minecraft:note_block\S*)/mg)]
    .map((m) => ({ x: +m[1], y: +m[2], z: +m[3], block: m[4] }));
  if (noteBlocks.length === 0) throw new Error("setup emitted no note_block - redstone track missing");

  const repeaters = [...setupText.matchAll(/^setblock (-?\d+) (-?\d+) (-?\d+) (minecraft:repeater\S*)/mg)]
    .map((m) => ({ x: +m[1], y: +m[2], z: +m[3], block: m[4] }));
  if (repeaters.length === 0) throw new Error("setup emitted no repeater - the multi-tone clip should yield a delay-line");

  const dust = [...setupText.matchAll(/^setblock (-?\d+) (-?\d+) (-?\d+) minecraft:redstone_wire/mg)]
    .map((m) => ({ x: +m[1], y: +m[2], z: +m[3] }));
  if (dust.length === 0) throw new Error("setup emitted no redstone_wire spine");

  // the input the metronome toggles (authoritative pulse position) - from music.mcfunction
  const inMatch = /setblock (-?\d+) (-?\d+) (-?\d+) minecraft:redstone_block/.exec(musicText);
  if (!inMatch) throw new Error("music.mcfunction has no redstone_block re-pulse - the engine can't be triggered");
  const INPUT = { x: +inMatch[1], y: +inMatch[2], z: +inMatch[3] };

  // the LAST repeater (max X = farthest down the +X delay-line) is the propagation target
  const lastRep = repeaters.reduce((a, b) => (b.x > a.x ? b : a));
  const mtcount = +(/scoreboard players set #mtcount ma (\d+)/.exec(setupText)?.[1] ?? -1);
  const count = +(/scoreboard players set #count ma (\d+)/.exec(setupText)?.[1] ?? -1);
  if (mtcount <= 0) throw new Error(`#mtcount not wired (got ${mtcount})`);
  if (count !== FRAMES) throw new Error(`#count is ${count}, expected ${FRAMES} (music broke the build wiring)`);
  // track bounding box for forceload
  const all = [...noteBlocks, ...repeaters, ...dust, INPUT];
  const bb = all.reduce((a, p) => ({
    x0: Math.min(a.x0, p.x), z0: Math.min(a.z0, p.z), x1: Math.max(a.x1, p.x), z1: Math.max(a.z1, p.z),
  }), { x0: Infinity, z0: Infinity, x1: -Infinity, z1: -Infinity });
  log(`artifact parsed: ${noteBlocks.length} note blocks, ${repeaters.length} repeaters, input@${INPUT.x},${INPUT.y},${INPUT.z}, lastRepeater@${lastRep.x},${lastRep.y},${lastRep.z}, #mtcount=${mtcount}`);

  // ---- 4. throwaway vanilla server with the redstone datapack pre-installed ----
  for (const cache of ["/tmp/bd-server-d2", join(ROOT, ".vanilla-server")]) {
    if (existsSync(join(cache, "server.jar")) && existsSync(join(cache, "server.jar.sha1"))) {
      copyFileSync(join(cache, "server.jar"), join(dir, "server.jar"));
      copyFileSync(join(cache, "server.jar.sha1"), join(dir, "server.jar.sha1"));
      log(`seeded cached server.jar from ${cache}`);
      break;
    }
  }
  log(`bootstrapping vanilla ${MC_VERSION} in ${dir} (redstone datapack pre-installed)`);
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

  // ---- 5. pack enabled at boot AND survives /reload (proves redstone blockstates parse) ----
  let packs = await rcon("datapack list enabled");
  if (!packs.includes(`${NS}.zip`)) throw new Error(`redstone datapack not enabled at boot: ${packs}`);
  await rcon("reload");
  await sleep(1500);
  packs = await rcon("datapack list enabled");
  if (!packs.includes(`${NS}.zip`)) throw new Error(`redstone datapack lost after /reload (a blockstate failed to parse?): ${packs}`);
  log("pack still enabled after /reload - repeater/redstone_wire/redstone_block/note_block blockstates all parsed clean");

  // ---- 6. setup builds the physical track (note blocks + repeaters), build intact ----
  await rcon(`forceload add ${bb.x0} ${bb.z0} ${bb.x1} ${bb.z1}`);
  const setupOut = await rcon(`function ${NS}:setup`);
  if (/error|failed|unknown/i.test(setupOut)) throw new Error(`/function ${NS}:setup failed: ${setupOut}`);
  const nb0 = noteBlocks[0];
  const nbCheck = await rcon(`execute if block ${nb0.x} ${nb0.y} ${nb0.z} minecraft:note_block`);
  if (!/passed/i.test(nbCheck)) throw new Error(`note block NOT placed at ${nb0.x} ${nb0.y} ${nb0.z}: ${nbCheck.trim()}`);
  const repCheck = await rcon(`execute if block ${lastRep.x} ${lastRep.y} ${lastRep.z} minecraft:repeater`);
  if (!/passed/i.test(repCheck)) throw new Error(`last repeater NOT placed at ${lastRep.x} ${lastRep.y} ${lastRep.z}: ${repCheck.trim()}`);
  log(`setup OK: ${noteBlocks.length} note blocks + ${repeaters.length} repeaters placed`);

  // ---- 7. THE ENGINE CONDUCTS: force the input ON, the pulse must reach the LAST repeater ----
  // Sustained ON (not the metronome's short pulse) so propagation is deterministic to sample:
  // the ON-front travels the whole +X delay-line and latches every repeater powered=true. If
  // repeater facing were wrong, the signal would never reach lastRep and this would fail.
  await rcon(`setblock ${INPUT.x} ${INPUT.y} ${INPUT.z} minecraft:redstone_block replace`);
  // wait > total delay-line length (mtcount game ticks ≈ propagation time) for the front to arrive
  const waitMs = Math.min(8000, Math.max(2000, mtcount * 50 + 1500));
  await sleep(waitMs);
  // diagnostic sweep west→east: which repeaters latched? localises where propagation dies.
  const sortedReps = [...repeaters].sort((a, b) => a.x - b.x);
  const profile = [];
  for (const r of sortedReps) {
    const on = /passed/i.test(await rcon(`execute if block ${r.x} ${r.y} ${r.z} minecraft:repeater[powered=true]`));
    profile.push(`${r.x}:${on ? "ON" : "off"}`);
  }
  const firstDustOn = /passed/i.test(await rcon(`execute if block ${INPUT.x + 1} ${INPUT.y} ${INPUT.z} minecraft:redstone_wire[power=15]`));
  log(`propagation profile (firstDust@${INPUT.x + 1} pwr15=${firstDustOn}) repeaters[${profile.join(" ")}]`);
  const poweredCheck = await rcon(`execute if block ${lastRep.x} ${lastRep.y} ${lastRep.z} minecraft:repeater[powered=true]`);
  if (!/passed/i.test(poweredCheck)) {
    throw new Error(`redstone pulse did NOT reach the last repeater@${lastRep.x},${lastRep.y},${lastRep.z} after ${waitMs}ms `
      + `(facing/propagation wrong?): ${poweredCheck.trim()}`);
  }
  log(`engine conducts: pulse propagated the full delay-line - last repeater latched powered=true (facing=west confirmed)`);
  await rcon(`setblock ${INPUT.x} ${INPUT.y} ${INPUT.z} minecraft:air replace`);

  // ---- 8. :start re-pulses the line each loop (#mt advances); :stop freezes it ----
  await rcon(`function ${NS}:start`);
  const seen = new Set();
  const tPoll = Date.now();
  while (Date.now() - tPoll < 15_000) {
    const m = /has (-?\d+)/.exec(await rcon("scoreboard players get #mt ma"));
    if (m) seen.add(Number(m[1]));
    if ([...seen].some((v) => v > 0)) break;
    await sleep(90);
  }
  if (![...seen].some((v) => v > 0)) {
    throw new Error(`#mt never advanced after :start - the ${NS}:music re-pulse metronome is not executing (saw {${[...seen].join(",") || "empty"}})`);
  }
  log(`re-pulse metronome live: #mt advanced after :start (sampled {${[...seen].sort((a, b) => a - b).join(",")}})`);
  await rcon(`function ${NS}:stop`);
  const readMt = async () => {
    const m = /has (-?\d+)/.exec(await rcon("scoreboard players get #mt ma"));
    if (!m) throw new Error("could not read #mt after :stop");
    return Number(m[1]);
  };
  const M = await readMt();
  await sleep(700);
  if ((await readMt()) !== M) throw new Error(`:stop did not freeze the metronome - #mt still advancing past ${M}`);
  log(`:stop froze the metronome at #mt=${M} (frozen across 700 ms)`);

  await cleanup();
  rmSync(dir, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
  log(`PASS in ${((Date.now() - t0) / 1000).toFixed(1)} s - vanilla built the redstone instrument and the delay-line CONDUCTED the pulse end-to-end (temp dirs removed)`);
  process.exit(0);
} catch (e) {
  console.error(`[redstone-e2e] FAIL: ${e.message}`);
  console.error(`[redstone-e2e] dirs KEPT for debugging: server=${dir} work=${work} (boot log: ${dir}/boot-stdout.log)`);
  await cleanup();
  process.exit(1);
}
