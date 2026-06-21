// Note-block music: turn an analyzed note timeline (@blockdream/audio) into a
// physical, tunable "music area" of note blocks PLUS a tick-driven datapack
// sequencer that plays the melody with `playsound`. Pure string-building, no
// node/DOM imports — safe to bundle into the browser datapack-export path.
//
// Two parts are emitted:
//   * keyboard  — `/setblock` commands placing one tuned `note_block` per distinct
//                 pitch (atop the block that selects its instrument). This is the
//                 visible thing the canvas-mod lets the user drag.
//   * music     — an mcfunction that, every game tick, plays the notes due at the
//                 current music-tick via positional `playsound`, then loops.

import type { NoteEvent } from "@blockdream/audio";
import { noteBlockPitch, noteTimelineTicks } from "@blockdream/audio";

/** The block placed directly beneath a note block selects its instrument. */
export const INSTRUMENT_BASE: Record<string, string> = {
  harp: "minecraft:dirt",
  bass: "minecraft:oak_planks",
  basedrum: "minecraft:stone",
  snare: "minecraft:sand",
  hat: "minecraft:glass",
  bell: "minecraft:gold_block",
  flute: "minecraft:clay",
  chime: "minecraft:packed_ice",
  guitar: "minecraft:white_wool",
  xylophone: "minecraft:bone_block",
  iron_xylophone: "minecraft:iron_block",
  cow_bell: "minecraft:soul_sand",
  didgeridoo: "minecraft:pumpkin",
  bit: "minecraft:emerald_block",
  banjo: "minecraft:hay_block",
  pling: "minecraft:glowstone",
};

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface NoteSequencerOptions {
  /** World position of the music area (keyboard origin + playsound source). */
  musicOrigin?: Vec3;
  /** Silent tail ticks before the melody repeats (default 20 = 1s). */
  loopTailTicks?: number;
  /** Place the physical tunable note-block keyboard (default true). */
  placeKeyboard?: boolean;
  /** playsound mixer category (default "record" — the note-block song convention). */
  soundCategory?: string;
  /** Base playsound volume, scaled per-note by velocity (default 3). */
  volume?: number;
  /** Cap on emitted notes so music.mcfunction stays under the command limit (default 1500). */
  maxNotes?: number;
}

export interface NoteSequencer {
  /** `/setblock` commands placing the physical, tuned music area. */
  keyboard: string[];
  /** Body lines of `music.mcfunction` (play-due-notes, advance, loop). */
  musicLines: string[];
  /** Scoreboard init lines to fold into the pack's setup function. */
  setupScores: string[];
  /** Loop length in game ticks (`#mtcount`); 0 when there are no notes. */
  loopTicks: number;
  /** Notes actually emitted (after the maxNotes cap). */
  noteCount: number;
}

function fmt(n: number): string {
  return (Math.round(n * 100000) / 100000).toString();
}

/** Build the note-block music area + datapack sequencer for a note timeline. */
export function noteSequencer(notes: NoteEvent[], opts: NoteSequencerOptions = {}): NoteSequencer {
  const origin = opts.musicOrigin ?? { x: 0, y: 64, z: 0 };
  const cat = opts.soundCategory ?? "record";
  const baseVol = opts.volume ?? 3;
  const placeKeyboard = opts.placeKeyboard ?? true;
  const maxNotes = Math.max(0, Math.floor(opts.maxNotes ?? 1500));
  const used = notes.length > maxNotes ? notes.slice(0, maxNotes) : notes;

  const loopTicks = used.length ? noteTimelineTicks(used) + Math.max(1, opts.loopTailTicks ?? 20) : 0;

  // Physical keyboard: one tuned note block per distinct (instrument, note),
  // laid out ascending along +X, each on its instrument-selecting base block.
  const keyboard: string[] = [];
  if (placeKeyboard && used.length) {
    const seen = new Set<string>();
    const distinct: Array<{ note: number; instrument: string }> = [];
    for (const e of used) {
      const key = `${e.instrument}:${e.note}`;
      if (!seen.has(key)) {
        seen.add(key);
        distinct.push({ note: e.note, instrument: e.instrument });
      }
    }
    distinct.sort((a, b) =>
      a.instrument === b.instrument ? a.note - b.note : a.instrument < b.instrument ? -1 : 1,
    );
    distinct.forEach((d, i) => {
      const x = origin.x + i;
      const base = INSTRUMENT_BASE[d.instrument] ?? INSTRUMENT_BASE["harp"]!;
      keyboard.push(`setblock ${x} ${origin.y - 1} ${origin.z} ${base} replace`);
      keyboard.push(
        `setblock ${x} ${origin.y} ${origin.z} minecraft:note_block[note=${d.note},instrument=${d.instrument}] replace`,
      );
    });
  }

  // music.mcfunction: play notes due this music-tick, then advance + wrap.
  const musicLines: string[] = [
    `# note-block music sequencer - runs every tick from #minecraft:tick`,
    `execute unless score #play ma matches 1 run return 0`,
  ];
  for (const e of used) {
    const vol = Math.max(0.5, Math.min(baseVol, baseVol * e.velocity));
    musicLines.push(
      `execute if score #mt ma matches ${e.tick} run playsound minecraft:block.note_block.${e.instrument} ${cat} @a ${origin.x} ${origin.y} ${origin.z} ${fmt(vol)} ${fmt(noteBlockPitch(e.note))}`,
    );
  }
  musicLines.push(`scoreboard players add #mt ma 1`);
  musicLines.push(`execute if score #mt ma >= #mtcount ma run scoreboard players set #mt ma 0`);
  musicLines.push("");

  const setupScores = used.length
    ? [`scoreboard players set #mt ma 0`, `scoreboard players set #mtcount ma ${loopTicks}`]
    : [];

  return { keyboard, musicLines, setupScores, loopTicks, noteCount: used.length };
}
