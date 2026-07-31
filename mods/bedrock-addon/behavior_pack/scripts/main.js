import { world, system, BlockPermutation } from "@minecraft/server";
import { POOL } from "./frames.js";

/**
 * blockdream Block-Art Player (Bedrock Script API).
 *
 * Plays POOL (see frames.js) on a solid-block wall. Frame 0 is a full keyframe;
 * later frames are deltas (only changed cells), matching the renderer's
 * delta encoding. Advances every POOL.speedTicks game ticks.
 *
 * Controls (chat): `!mw start`, `!mw stop`, `!mw reset`.
 */

let frameIndex = 0;
let tickCounter = 0;
let playing = POOL.autoplay ?? false;

function dim() {
  return world.getDimension(POOL.dimension ?? "overworld");
}

function applyFrame(f) {
  const d = dim();
  const cells = POOL.frames[f];
  // Count resolve failures (stale/unregistered block ids) and surface ONE
  // warning per frame - never per cell.
  let failed = 0;
  const failedIds = [];
  for (let i = 0; i < cells.length; i++) {
    const c = cells[i]; // [x, y, paletteIndex]
    const blockId = POOL.palette[c[2]];
    if (!blockId) continue;
    const loc = {
      x: POOL.origin.x + c[0],
      y: POOL.origin.y + (POOL.height - 1 - c[1]), // image row 0 at top
      z: POOL.origin.z,
    };
    const block = d.getBlock(loc);
    if (!block) continue;
    try {
      block.setPermutation(BlockPermutation.resolve(blockId));
    } catch {
      failed++;
      if (failedIds.length < 3 && !failedIds.includes(blockId)) failedIds.push(blockId);
    }
  }
  if (failed > 0) {
    console.warn("[blockdream] frame " + f + ": " + failed + " cell(s) failed BlockPermutation.resolve (bad ids: " + failedIds.join(", ") + ")");
  }
}

function reset() {
  frameIndex = 0;
  tickCounter = 0;
  applyFrame(0);
}

system.runInterval(() => {
  if (!playing || POOL.frames.length === 0) return;
  if (++tickCounter < POOL.speedTicks) return;
  tickCounter = 0;
  frameIndex = (frameIndex + 1) % POOL.frames.length;
  applyFrame(frameIndex);
});

// Draw the keyframe once on load (deferred a tick so the world is ready) so
// autoplay starts from frame 0 instead of applying frame 1's delta onto an
// empty wall. Manual `!mw start` calls reset() itself.
system.run(() => {
  if (playing) reset();
});

world.afterEvents.chatSend?.subscribe((ev) => {
  const msg = ev.message.trim();
  if (!msg.startsWith("!mw")) return;
  const cmd = msg.slice(3).trim();
  if (cmd === "start") {
    reset();
    playing = true;
    ev.sender.sendMessage("§a[blockdream] playing");
  } else if (cmd === "stop") {
    playing = false;
    ev.sender.sendMessage("§e[blockdream] stopped");
  } else if (cmd === "reset") {
    reset();
    ev.sender.sendMessage("§b[blockdream] reset to frame 0");
  }
});
