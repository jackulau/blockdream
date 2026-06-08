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
import { createRequire } from "node:module"; // setupSkill needs require() (prismarine-item / vec3) in ESM
const require = createRequire(import.meta.url);

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
  elytra: { forward: true }, // gliding (setupSkill equips elytra + gains altitude)
  pig: { forward: true }, // riding a saddled pig (setupSkill spawns + saddles + mounts)
  minecart: {}, // rolling in a minecart (setupSkill lays rails + mounts)
};

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

// Set up the world/bot for a skill in CREATIVE (no op/commands needed). Best-effort: each step is
// guarded so a partial failure still records whatever the bot ends up doing. Operator-gated render
// (prismarine-viewer headless) is the only piece this can't self-verify — the setup logic itself is
// pure mineflayer creative API (give / placeBlock / mount / equip / flyTo).
async function setupSkill (bot, skill) {
  const { Vec3 } = require('vec3');
  const at = (dx, dy, dz) => bot.entity.position.offset(dx, dy, dz).floored();
  const placeAt = async (pos, item) => {
    await give(bot, item);
    const ref = bot.blockAt(pos.offset(0, -1, 0));
    if (ref) await bot.placeBlock(ref, new Vec3(0, 1, 0)).catch(() => {});
  };
  try {
    if (skill === 'swim' || skill === 'boat') {
      // carve a 2-deep pit and fill with water so the bot is submerged / a boat floats
      for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy >= -2; dy--) {
        const b = bot.blockAt(at(dx, dy, dz));
        if (b && b.name !== 'air') await bot.dig(b, true).catch(() => {});
      }
      await give(bot, 'water_bucket');
      await bot.lookAt(at(0, -2, 0), true);
      await bot.activateItem(); // empty bucket → water source
      await sleep(500);
      if (skill === 'boat') {
        await give(bot, 'oak_boat');
        await bot.lookAt(at(0, -1, 0), true);
        await bot.activateItem(); // place boat on the water
        await sleep(500);
        const boat = Object.values(bot.entities).find((e) => /boat/.test(e.name || '') && e.position.distanceTo(bot.entity.position) < 4);
        if (boat) await bot.mount(boat);
      }
    } else if (skill === 'pig') {
      await give(bot, 'pig_spawn_egg');
      await bot.lookAt(at(1, -1, 0), true);
      await bot.activateItem(); // spawn a pig
      await sleep(700);
      const pig = Object.values(bot.entities).find((e) => e.name === 'pig' && e.position.distanceTo(bot.entity.position) < 5);
      if (pig) {
        await give(bot, 'saddle');
        await bot.useOn(pig).catch(() => {}); // saddle it
        await sleep(300);
        await bot.mount(pig);
        await give(bot, 'carrot_on_a_stick'); // steers a saddled pig forward
      }
    } else if (skill === 'minecart') {
      for (let i = 0; i < 8; i++) await placeAt(at(0, -1, i), 'rail'); // lay a short track
      await placeAt(at(0, 0, 0), 'minecart');
      await sleep(400);
      const cart = Object.values(bot.entities).find((e) => /minecart/.test(e.name || '') && e.position.distanceTo(bot.entity.position) < 4);
      if (cart) await bot.mount(cart);
    } else if (skill === 'elytra') {
      await give(bot, 'elytra');
      await bot.equip(bot.registry.itemsByName.elytra.id, 'torso').catch(() => {});
      await give(bot, 'firework_rocket', 64);
      await bot.creative.flyTo(bot.entity.position.offset(0, 30, 0)).catch(() => {}); // gain altitude, then glide
      await sleep(500);
    }
  } catch (e) {
    console.error(`[collect] ${skill} setup partial: ${e.message}`);
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

  // per-tick action + physics telemetry, aligned to wall time so the importer can resample to FPS
  const log = [];
  const t0 = Date.now();
  const onTick = () => {
    const e = bot.entity;
    if (!e) return;
    log.push({
      t: (Date.now() - t0) / 1000,
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
        inWater: !!bot.entity.isInWater,
        speed: Math.hypot(e.velocity.x, e.velocity.z),
      },
    });
  };
  bot.on("physicsTick", onTick);

  // perform the movement while capturing PNG frames at FPS
  for (const [k, v] of Object.entries(controls)) bot.setControlState(k, v);
  const frameDir = join(OUT, `_${skill}_frames`);
  rmSync(frameDir, { recursive: true, force: true });
  mkdirSync(frameDir, { recursive: true });
  const nFrames = SECONDS * FPS;
  for (let f = 0; f < nFrames; f++) {
    await wv.updatePosition(bot.entity.position); // load chunks the bot moved into
    aimCamera();
    viewer.update();
    renderer.render(viewer.scene, viewer.camera);
    writeFileSync(join(frameDir, `f${String(f).padStart(5, "0")}.png`), canvas.toBuffer("image/png"));
    await sleep(1000 / FPS);
  }
  for (const k of Object.keys(controls)) bot.setControlState(k, false);
  bot.removeListener("physicsTick", onTick);

  // assemble PNG frames → mp4 (explicit args — reliable, unlike the headless stdin pipe)
  const mp4 = join(OUT, `${skill}.mp4`);
  execFileSync("ffmpeg", ["-y", "-framerate", String(FPS), "-i", join(frameDir, "f%05d.png"), "-pix_fmt", "yuv420p", mp4], { stdio: "ignore" });
  rmSync(frameDir, { recursive: true, force: true });
  writeFileSync(join(OUT, `${skill}.json`), JSON.stringify({ skill, fps: FPS, size: SIZE, seconds: SECONDS, ticks: log }, null, 0));
  console.log(`[collect] ${skill}: wrote ${log.length} ticks + ${mp4}`);
  bot.quit();
  await sleep(1500);
}

for (const skill of SKILLS) {
  try {
    await recordSkill(skill.trim());
  } catch (e) {
    console.error(`[collect] ${skill} FAILED: ${e.message}`);
  }
}
console.log("[collect] done. Import with ml/scripts/import_mineflayer.py");
process.exit(0);
