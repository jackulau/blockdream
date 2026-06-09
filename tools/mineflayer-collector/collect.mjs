// Mineflayer data collector for the Blockdream world model — the "comma.ai for Minecraft" path.
//
// comma trains driving models on real fleet footage. The analogue here: drive a Mineflayer bot
// through each MOVEMENT TYPE on a real Minecraft server, record the bot's first-person view (via
// prismarine-viewer headless -> an mp4 per skill) alongside the per-tick ACTION (controls) and
// PHYSICS telemetry (position, velocity, on-ground, in-water, ...). A Python importer
// (ml/scripts/import_mineflayer.py) then aligns the mp4 frames with the action+physics logs into
// the tagged on-disk pool format the trainer consumes — so the world model learns REAL per-skill
// dynamics instead of synthetic stand-ins.
//
// OPERATOR-GATED: needs a reachable Minecraft server + Node deps. Cannot run in the build sandbox.
//   cd tools/mineflayer-collector && npm install        # mineflayer, prismarine-viewer, mineflayer-pathfinder
//   node collect.mjs --host <server> --port 25565 --skills walk,sprint,jump,swim,boat,elytra,pig,minecart --seconds 30
// Output: ./out/<skill>.mp4 + ./out/<skill>.json   (one per skill)
// Then:   ml/.venv/bin/python ml/scripts/import_mineflayer.py --in tools/mineflayer-collector/out --out ml/data
//
// NOTE: server rules/anti-cheat may restrict some movements; run on your own creative/flat server.

import { createBot } from "mineflayer";
import * as THREE from "three";
import { Worker } from "node:worker_threads";
import viewerPkg from "prismarine-viewer/viewer/index.js"; // CJS — default import then destructure
import canvasWebgl from "node-canvas-webgl";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { Rcon } from "rcon-client"; // deterministic world setup (fill water / summon saddled mobs)
import { createRequire } from "node:module"; // setupSkill needs require() (prismarine-item / vec3) in ESM
const require = createRequire(import.meta.url);

const RCON_PORT = parseInt(argvRcon(), 10);
function argvRcon () { const i = process.argv.indexOf("--rcon-port"); return i >= 0 ? process.argv[i + 1] : "25575"; }
const RCON_PASS = (() => { const i = process.argv.indexOf("--rcon-pass"); return i >= 0 ? process.argv[i + 1] : "blockdream"; })();
let _rcon = null;
async function rcon (command) {
  if (!_rcon) _rcon = await Rcon.connect({ host: HOST, port: RCON_PORT, password: RCON_PASS });
  return _rcon.send(command);
}

// prismarine-viewer's worker + mesher read these off the global scope at runtime (lazily, after import).
global.THREE = THREE;
global.Worker = Worker;
const { Viewer, WorldView } = viewerPkg;
const { createCanvas } = canvasWebgl;

const argv = Object.fromEntries(
  process.argv.slice(2).map((a, i, arr) => (a.startsWith("--") ? [a.slice(2), arr[i + 1]] : [null, null])).filter(([k]) => k),
);
const HOST = argv.host || "localhost";
const PORT = parseInt(argv.port || "25565", 10);
const SKILLS = (argv.skills || "walk,sprint,jump,swim,boat,elytra,pig,minecart").split(",");
const SECONDS = parseInt(argv.seconds || "30", 10);
const FPS = parseInt(argv.fps || "10", 10);
const SIZE = parseInt(argv.size || "128", 10);
const OUT = argv.out || "./out";
mkdirSync(OUT, { recursive: true });

// Per-skill control script: which buttons to hold while recording.
const SKILL_CONTROLS = {
  walk: { forward: true },
  sprint: { forward: true, sprint: true },
  jump: { forward: true, jump: true },
  swim: { forward: true }, // submerged (setupSkill builds a water column)
  boat: { forward: true }, // mounted on a boat (setupSkill places + mounts)
  elytra: {}, // airborne flight drives motion (sustainSkill), not ground controls
  pig: { forward: true }, // riding a saddled pig (setupSkill spawns + saddles + mounts)
  minecart: {}, // rolling in a minecart (setupSkill lays rails + mounts)
};

// The state that DEFINES a skill — used to VERIFY setup worked and to score each clip (skill_ok).
function inExpectedState (bot, skill) {
  const e = bot.entity;
  if (!e) return false;
  if (skill === "swim") return !!e.isInWater;
  if (skill === "elytra") return !e.onGround;
  if (skill === "boat" || skill === "pig" || skill === "minecart") return !!bot.vehicle;
  return true; // walk/sprint/jump: always "in state"
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// give an item to the (creative) bot's hotbar slot 36 and return the Item
async function give (bot, name, count = 1, nbt = undefined) {
  const mcData = bot.registry;
  const id = mcData.itemsByName[name]?.id;
  if (id == null) throw new Error(`unknown item ${name}`);
  const Item = require('prismarine-item')(bot.version);
  const item = new Item(id, count, undefined, nbt);
  await bot.creative.setInventorySlot(36, item);
  return item;
}

// Set up the world/bot so it GENUINELY performs the skill (pure mineflayer creative API — give /
// placeBlock / mount / equip / flyTo). Each mount is VERIFIED (bot.vehicle) with retries; setup
// returns once the bot is in the skill's defining state (or best-effort after retries).
async function setupSkill (bot, skill) {
  const { Vec3 } = require('vec3');
  const at = (dx, dy, dz) => bot.entity.position.offset(dx, dy, dz).floored();
  const near = (re) => Object.values(bot.entities).find((e) => re.test(e.name || "") && e.position && e.position.distanceTo(bot.entity.position) < 6);
  const placeAt = async (pos, item) => {
    await give(bot, item);
    const ref = bot.blockAt(pos.offset(0, -1, 0));
    if (ref) await bot.placeBlock(ref, new Vec3(0, 1, 0)).catch(() => {});
  };
  const useItem = () => { try { bot.activateItem(); } catch {} }; // activateItem() is void here (no .catch)
  // mount the nearest matching entity, retrying until bot.vehicle is set
  const mountVerified = async (re, tries = 4) => {
    for (let i = 0; i < tries && !bot.vehicle; i++) {
      const ent = near(re);
      if (ent) { try { bot.mount(ent); } catch {} await sleep(700); }
      else await sleep(350);
    }
    return !!bot.vehicle;
  };
  const P = bot.entity.position;
  const [X, Y, Z] = [Math.floor(P.x), Math.floor(P.y), Math.floor(P.z)]; // bot coords for RCON
  try {
    if (skill === "swim") {
      // RCON: fill a BIG deep water box so the bot stays submerged (inWater) through the clip and
      // can't swim out the edge. peaceful = no drowning.
      await rcon(`fill ${X - 7} ${Y - 4} ${Z - 7} ${X + 7} ${Y + 3} ${Z + 7} minecraft:water`);
      await sleep(900);
    } else if (skill === "boat") {
      await rcon(`fill ${X - 4} ${Y - 2} ${Z - 4} ${X + 4} ${Y + 1} ${Z + 4} minecraft:water`); // pond
      await sleep(500);
      await rcon(`summon minecraft:boat ${X} ${Y} ${Z}`); // floats on the pond
      await sleep(600);
      await mountVerified(/boat/);
    } else if (skill === "pig") {
      await rcon(`summon minecraft:pig ${X} ${Y} ${Z} {Saddle:1b}`); // saddled → rideable
      await sleep(800);
      await mountVerified(/pig/);
      await give(bot, "carrot_on_a_stick"); // held → steers the saddled pig forward
    } else if (skill === "minecart") {
      await rcon(`fill ${X} ${Y} ${Z} ${X} ${Y} ${Z + 9} minecraft:rail`); // rail line at feet level
      await sleep(300);
      await rcon(`summon minecraft:minecart ${X} ${Y} ${Z}`); // snaps onto the rail
      await sleep(600);
      await mountVerified(/minecart/);
    } else if (skill === "elytra") {
      await give(bot, "elytra");
      await bot.equip(bot.registry.itemsByName.elytra.id, "torso").catch(() => {});
      await give(bot, "firework_rocket", 64);
      await bot.creative.flyTo(bot.entity.position.offset(0, 40, 0)).catch(() => {}); // gain altitude
      await sleep(400);
    }
  } catch (e) {
    console.error(`[collect] ${skill} setup partial: ${e.message}`);
  }
}

// Keep the skill's state alive DURING recording (called each frame). elytra: fly forward at altitude
// so the bot stays airborne with an aerial POV (flyTo re-targets ahead every ~1s). Mounts persist
// on their own. Returns nothing; best-effort + non-blocking.
let _lastFly = 0;
function sustainSkill (bot, skill, frame) {
  if (skill === "elytra" && frame - _lastFly >= 10) {
    _lastFly = frame;
    const p = bot.entity.position;
    const ahead = p.offset(-Math.sin(bot.entity.yaw) * 16, 0, Math.cos(bot.entity.yaw) * 16);
    bot.creative.flyTo(ahead).catch(() => {}); // keep aloft + moving forward
  }
}

async function recordSkill(skill) {
  const controls = SKILL_CONTROLS[skill] || { forward: true };
  console.log(`[collect] ${skill}: connecting ${HOST}:${PORT}`);
  const bot = createBot({ host: HOST, port: PORT, username: `blockdream_${skill}`.slice(0, 16) });
  await new Promise((res, rej) => {
    bot.once("spawn", res);
    bot.once("error", rej);
    bot.once("end", () => rej(new Error("disconnected before spawn")));
  });

  await sleep(2500); // let chunks load
  await setupSkill(bot, skill); // creative: give item / place water·rails / mount / equip elytra
  await sleep(500);

  // Offscreen first-person renderer. We roll our own capture (not prismarine-viewer's headless(),
  // whose ffmpeg-stdin pipe finalised empty here): render each frame into a node-canvas-webgl canvas
  // and write PNGs, then assemble with ffmpeg. Camera is set DIRECTLY (setFirstPersonCamera tweens
  // over 50ms — re-calling it per frame restarts the tween so the camera never reaches the bot).
  const canvas = createCanvas(SIZE, SIZE);
  const renderer = new THREE.WebGLRenderer({ canvas });
  const viewer = new Viewer(renderer);
  viewer.setVersion(bot.version);
  const wv = new WorldView(bot.world, 6, bot.entity.position);
  viewer.listen(wv);
  wv.listenToBot(bot); // stream new chunks + entities as the bot moves
  await wv.init(bot.entity.position);
  const aimCamera = () => {
    const p = bot.entity.position;
    viewer.camera.position.set(p.x, p.y + 1.6, p.z); // eye height
    viewer.camera.rotation.set(bot.entity.pitch, bot.entity.yaw, 0, "ZYX"); // the bot's real look
  };
  // warm up the chunk-mesh workers so geometry exists before frame 0
  for (let i = 0; i < 150; i++) { aimCamera(); viewer.update(); renderer.render(viewer.scene, viewer.camera); await sleep(15); }

  // telemetry logged PER FRAME — NOT physicsTick, which stops firing while the bot rides a vehicle
  // (boat/pig/minecart), which previously left those clips with 0 telemetry ticks.
  const log = [];
  const t0 = Date.now();
  const snapshot = () => {
    const e = bot.entity;
    if (!e) return;
    log.push({
      t: (Date.now() - t0) / 1000,
      inState: inExpectedState(bot, skill), // is the bot actually DOING this skill right now?
      buttons: {
        forward: !!controls.forward, back: false, left: false, right: false,
        jump: !!controls.jump, sneak: false, sprint: !!controls.sprint, use: false, attack: false,
      },
      camera: [e.yaw, e.pitch],
      physics: {
        pos: [e.position.x, e.position.y, e.position.z],
        vel: [e.velocity.x, e.velocity.y, e.velocity.z],
        yaw: e.yaw, pitch: e.pitch,
        onGround: !!e.onGround,
        inWater: !!e.isInWater,
        mounted: !!bot.vehicle,
        speed: Math.hypot(e.velocity.x, e.velocity.z),
      },
    });
  };

  // perform the movement while capturing PNG frames + per-frame telemetry at FPS
  for (const [k, v] of Object.entries(controls)) bot.setControlState(k, v);
  const frameDir = join(OUT, `_${skill}_frames`);
  rmSync(frameDir, { recursive: true, force: true });
  mkdirSync(frameDir, { recursive: true });
  const nFrames = SECONDS * FPS;
  for (let f = 0; f < nFrames; f++) {
    sustainSkill(bot, skill, f); // keep elytra aloft / skill state alive
    await wv.updatePosition(bot.entity.position); // load chunks the bot moved into
    aimCamera();
    viewer.update();
    renderer.render(viewer.scene, viewer.camera);
    writeFileSync(join(frameDir, `f${String(f).padStart(5, "0")}.png`), canvas.toBuffer("image/png"));
    snapshot(); // telemetry aligned with this frame (works while mounted)
    await sleep(1000 / FPS);
  }
  for (const k of Object.keys(controls)) bot.setControlState(k, false);

  // assemble PNG frames → mp4 (explicit args — reliable, unlike the headless stdin pipe)
  const mp4 = join(OUT, `${skill}.mp4`);
  execFileSync("ffmpeg", ["-y", "-framerate", String(FPS), "-i", join(frameDir, "f%05d.png"), "-pix_fmt", "yuv420p", mp4], { stdio: "ignore" });
  rmSync(frameDir, { recursive: true, force: true });
  // skill_ok = fraction of ticks the bot was genuinely in the skill state (inWater / mounted / airborne)
  const skillOk = log.length ? log.filter((t) => t.inState).length / log.length : 0;
  writeFileSync(join(OUT, `${skill}.json`), JSON.stringify({ skill, fps: FPS, size: SIZE, seconds: SECONDS, skill_ok: skillOk, ticks: log }, null, 0));
  console.log(`[collect] ${skill}: wrote ${log.length} ticks + ${mp4}  skill_ok=${(skillOk * 100).toFixed(0)}%`);
  bot.quit();
  await sleep(1500);
  return skillOk;
}

// Run every skill, continuing past per-skill failures, but TRACK each outcome so a bad run can't
// masquerade as a good one (previously this always exited 0, even if every skill failed).
const SKILL_OK_MIN = 0.8; // a clip that was in-state < 80% of ticks is not trustworthy training data
const results = []; // { skill, status: "ok" | "low_score" | "failed", skillOk?, error? }
for (const skill of SKILLS) {
  const name = skill.trim();
  try {
    const skillOk = await recordSkill(name);
    results.push({ skill: name, status: skillOk >= SKILL_OK_MIN ? "ok" : "low_score", skillOk });
  } catch (e) {
    console.error(`[collect] ${name} FAILED: ${e.message}`);
    results.push({ skill: name, status: "failed", error: e.message });
  }
}
if (_rcon) await _rcon.end().catch(() => {}); // close the shared RCON socket so the process can exit

// Final summary: one line per skill, then exit nonzero if ANY skill failed or self-verified weakly.
console.log("\n[collect] ===== summary =====");
console.log(`  ${"skill".padEnd(10)} ${"status".padEnd(10)} skill_ok`);
for (const r of results) {
  const score = r.skillOk != null ? `${(r.skillOk * 100).toFixed(0)}%` : "-";
  const detail = r.status === "failed" ? `  (${r.error})` : r.status === "low_score" ? `  (< ${SKILL_OK_MIN * 100}%)` : "";
  console.log(`  ${r.skill.padEnd(10)} ${r.status.padEnd(10)} ${score}${detail}`);
}
const failures = results.filter((r) => r.status !== "ok");
if (failures.length) {
  console.error(`[collect] ${failures.length}/${results.length} skill(s) failed or scored skill_ok < ${SKILL_OK_MIN} — NOT a clean run.`);
} else {
  console.log("[collect] all skills ok. Import with ml/scripts/import_mineflayer.py");
}
process.exit(failures.length ? 1 : 0);
