// Redstone-played note-block music: instead of driving the melody with `playsound`
// from a tick function (see note-sequencer.ts), this builds a PHYSICAL redstone
// machine — a repeater delay-line that powers tuned note blocks in onset order so
// the note blocks themselves play the song. Pure string-building, no node/DOM
// imports — safe to bundle into the browser datapack-export path.
//
// Design — a self-resetting pulse on a repeater "spine":
//   * A short redstone pulse enters at `inputPos`. Its rising-edge front travels
//     east (+X) down a line of repeaters. Each repeater adds delay; the cumulative
//     delay at each note's "tap cell" equals that note's onset, so the note block
//     beside the tap fires (rising edge = one play) exactly on time.
//   * Onsets are quantised to the redstone grid (1 redstone tick = 2 game ticks);
//     the inter-note delay is realised by repeaters (delay 1..4 rt each, chained
//     for longer gaps). Simultaneous notes become adjacent 0-delay dust taps that
//     energise on the same tick (dust is instantaneous within a 15-block run).
//   * Each note block sits on its instrument-selecting base block with AIR above,
//     so it is audible and correctly tuned (note=N blockstate).
//   * The pulse is short (ON then OFF a couple ticks later), so an OFF-front trails
//     the ON-front and resets every cell — the line is clear for the next loop.
//
// The datapack folds `blocks` into setup, runs `musicLines` every tick (a tiny
// re-pulse metronome that re-arms the line each `#mtcount`), and toggles `inputPos`
// on start/stop. The melody TIMING is redstone; only the once-per-loop re-pulse is
// a command.

import type { NoteEvent } from "@blockdream/audio";
import { noteTimelineTicks } from "@blockdream/audio";
import { INSTRUMENT_BASE, type Vec3 } from "./note-sequencer";

/** 1 redstone tick = 2 game ticks. Onsets quantise to this grid. */
const GAME_TICKS_PER_REDSTONE_TICK = 2;
/** A repeater's `delay` blockstate is 1..4 redstone ticks. */
const MAX_REPEATER_DELAY = 4;

export interface RedstoneSequencerOptions {
  /** World position of the track origin (note 0's tap cell). Input is at x-1. */
  musicOrigin?: Vec3;
  /** Silent tail ticks before the line re-pulses (default 20 = 1s). */
  loopTailTicks?: number;
  /** Cap on emitted notes so the build stays bounded (default 800). */
  maxNotes?: number;
  /** Conductor/floor block under the spine + note-block bases (default smooth_stone). */
  trackBlock?: string;
}

export interface RedstoneSequencer {
  /** `/setblock` commands building the physical redstone track (fold into setup). */
  blocks: string[];
  /** Body lines of `music.mcfunction` — the once-per-loop re-pulse metronome. */
  musicLines: string[];
  /** Scoreboard init lines to fold into the pack's setup function. */
  setupScores: string[];
  /** Loop length in game ticks (`#mtcount`); 0 when there are no notes. */
  loopTicks: number;
  /** Notes actually emitted (after the maxNotes cap). */
  noteCount: number;
  /** Where start/stop toggles the redstone-block pulse. */
  inputPos: Vec3;
  /** Track footprint in cells along +X. */
  length: number;
}

/** Split a redstone-tick delay into repeater `delay` values (each 1..4), in order. */
export function distributeDelay(redstoneTicks: number): number[] {
  let remaining = Math.max(0, Math.floor(redstoneTicks));
  const out: number[] = [];
  while (remaining > 0) {
    const step = Math.min(MAX_REPEATER_DELAY, remaining);
    out.push(step);
    remaining -= step;
  }
  return out;
}

/** Build a redstone-played note-block music track for a note timeline. */
export function redstoneSequencer(
  notes: NoteEvent[],
  opts: RedstoneSequencerOptions = {},
): RedstoneSequencer {
  const origin = opts.musicOrigin ?? { x: 0, y: 64, z: 0 };
  const floor = opts.trackBlock ?? "minecraft:smooth_stone";
  const maxNotes = Math.max(0, Math.floor(opts.maxNotes ?? 800));
  const sorted = [...notes].sort((a, b) => a.tick - b.tick);
  const used = sorted.length > maxNotes ? sorted.slice(0, maxNotes) : sorted;

  const inputPos: Vec3 = { x: origin.x - 1, y: origin.y, z: origin.z };
  const blocks: string[] = [];

  if (!used.length) {
    return {
      blocks,
      musicLines: [
        `# redstone-music re-pulse - no notes`,
        `execute unless score #play ma matches 1 run return 0`,
      ],
      setupScores: [],
      loopTicks: 0,
      noteCount: 0,
      inputPos,
      length: 0,
    };
  }

  const y = origin.y;
  const z = origin.z;
  // The note-block tap row sits one block north (+Z) of the spine.
  const tapZ = z + 1;

  // Floor + input cell (start/stop drops a redstone_block here; air by default).
  blocks.push(`setblock ${inputPos.x} ${y - 1} ${z} ${floor} replace`);
  blocks.push(`setblock ${inputPos.x} ${y} ${z} minecraft:air replace`);

  let cx = origin.x; // spine cursor along +X
  let prevRt = 0; // quantised onset of the previous note (input pulse = rt 0)

  for (const e of used) {
    const rt = Math.round(e.tick / GAME_TICKS_PER_REDSTONE_TICK);
    const delay = Math.max(0, rt - prevRt);
    prevRt = rt;

    // Delay segment: repeaters facing east carry + delay the pulse to this note.
    for (const d of distributeDelay(delay)) {
      blocks.push(`setblock ${cx} ${y - 1} ${z} ${floor} replace`);
      blocks.push(`setblock ${cx} ${y} ${z} minecraft:repeater[facing=east,delay=${d}] replace`);
      blocks.push(`setblock ${cx} ${y + 1} ${z} minecraft:air replace`);
      cx += 1;
    }

    // Tap cell: dust on the spine, with the tuned note block beside it (+Z).
    const base = INSTRUMENT_BASE[e.instrument] ?? INSTRUMENT_BASE["harp"]!;
    blocks.push(`setblock ${cx} ${y - 1} ${z} ${floor} replace`);
    blocks.push(`setblock ${cx} ${y} ${z} minecraft:redstone_wire replace`);
    blocks.push(`setblock ${cx} ${y + 1} ${z} minecraft:air replace`);
    blocks.push(`setblock ${cx} ${y - 1} ${tapZ} ${base} replace`);
    blocks.push(
      `setblock ${cx} ${y} ${tapZ} minecraft:note_block[note=${e.note},instrument=${e.instrument}] replace`,
    );
    blocks.push(`setblock ${cx} ${y + 1} ${tapZ} minecraft:air replace`);
    cx += 1;
  }

  const length = cx - origin.x;
  const loopTicks = noteTimelineTicks(used) + Math.max(1, opts.loopTailTicks ?? 20);

  // music.mcfunction: a tiny metronome that re-arms the physical line each loop.
  // ON at #mt 0 starts the pulse front; OFF at #mt 2 trails it (self-reset); the
  // melody between plays entirely in redstone.
  const musicLines: string[] = [
    `# redstone-music re-pulse - runs every tick from #minecraft:tick`,
    `execute unless score #play ma matches 1 run return 0`,
    `execute if score #mt ma matches 0 run setblock ${inputPos.x} ${inputPos.y} ${inputPos.z} minecraft:redstone_block replace`,
    `execute if score #mt ma matches 2 run setblock ${inputPos.x} ${inputPos.y} ${inputPos.z} minecraft:air replace`,
    `scoreboard players add #mt ma 1`,
    `execute if score #mt ma >= #mtcount ma run scoreboard players set #mt ma 0`,
    "",
  ];

  const setupScores = [
    `scoreboard players set #mt ma 0`,
    `scoreboard players set #mtcount ma ${loopTicks}`,
  ];

  return { blocks, musicLines, setupScores, loopTicks, noteCount: used.length, inputPos, length };
}
