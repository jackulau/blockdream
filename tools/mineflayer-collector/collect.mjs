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
import { headless } from "prismarine-viewer";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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

// Per-skill control script: which buttons to hold. The bot loops these while we record.
// (boat/pig/minecart/elytra need the right vehicle/item on the server; documented in README.)
const SKILL_CONTROLS = {
  walk: { forward: true },
  sprint: { forward: true, sprint: true },
  jump: { forward: true, jump: true },
  swim: { forward: true }, // run in water
  boat: { forward: true }, // mount a boat first
  elytra: { forward: true, jump: true }, // glide
  pig: { forward: true }, // ride a saddled pig
  minecart: {}, // sit in a moving minecart
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function recordSkill(skill) {
  const controls = SKILL_CONTROLS[skill] || { forward: true };
  console.log(`[collect] ${skill}: connecting ${HOST}:${PORT}`);
  const bot = createBot({ host: HOST, port: PORT, username: `blockdream_${skill}`.slice(0, 16) });
  await new Promise((res, rej) => {
    bot.once("spawn", res);
    bot.once("error", rej);
    bot.once("end", () => rej(new Error("disconnected before spawn")));
  });

  // headless POV recorder -> mp4 (prismarine-viewer renders the bot's first-person view offscreen)
  const mp4 = join(OUT, `${skill}.mp4`);
  headless(bot, { output: mp4, frames: SECONDS * FPS, width: SIZE, height: SIZE, viewDistance: 6, firstPerson: true });

  // per-tick action + physics telemetry, aligned to wall time so the importer can resample to FPS
  const log = [];
  const t0 = Date.now();
  const onTick = () => {
    const e = bot.entity;
    if (!e) return;
    log.push({
      t: (Date.now() - t0) / 1000,
      // action (buttons) — what we commanded this tick
      buttons: {
        forward: !!controls.forward, back: false, left: false, right: false,
        jump: !!controls.jump, sneak: false, sprint: !!controls.sprint, use: false, attack: false,
      },
      camera: [e.yaw, e.pitch],
      // PHYSICS telemetry (the "comma signals") — real ground-truth dynamics
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

  // perform the movement
  for (const [k, v] of Object.entries(controls)) bot.setControlState(k, v);
  await sleep(SECONDS * 1000);
  for (const k of Object.keys(controls)) bot.setControlState(k, false);
  bot.removeListener("physicsTick", onTick);

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
