// @blockdream/audio — pure, deterministic conversion of an audio signal into a
// timeline of Minecraft note-block events. No ffmpeg, no Web Audio, no DOM: the
// caller decodes audio to mono PCM (ffmpeg on the CLI, AudioContext in the browser)
// and hands the Float32Array here. The result drives the note-block "music area"
// and the datapack tick-sequencer (see @blockdream/emit-commands).
//
// Minecraft note blocks span exactly two octaves, F#3..F#5, addressed by the
// `note` blockstate 0..24. The `playsound` pitch parameter for that range is
// 0.5..2.0, with note 12 (F#4) = pitch 1.0.

/** One note-block trigger on the game-tick timeline (20 ticks per second). */
export interface NoteEvent {
  /** Game-tick offset from the start of the clip (default 20 tps). */
  tick: number;
  /** Minecraft note-block `note` blockstate, 0..24 (F#3..F#5). */
  note: number;
  /** Note-block instrument, e.g. "harp" — see NOTE_BLOCK_INSTRUMENTS. */
  instrument: string;
  /** Loudness 0..1 (peak-normalised RMS of the onset window). */
  velocity: number;
}

export interface AnalyzeOptions {
  /** Analysis hop in milliseconds (default 50 ≈ 1 tick) — timeline resolution. */
  hopMs?: number;
  /** Analysis window in milliseconds (default 46) — frequency resolution. */
  windowMs?: number;
  /** Game ticks per second the `tick` field is quantised to (default 20). */
  ticksPerSecond?: number;
  /** Instrument stamped on every emitted note (default "harp"). */
  instrument?: string;
  /** Lowest pitch the detector searches, Hz (default 110). */
  minHz?: number;
  /** Highest pitch the detector searches, Hz (default 1200). */
  maxHz?: number;
  /** Silence gate as a fraction of the clip's peak amplitude (default 0.04). */
  rmsGate?: number;
  /** Minimum autocorrelation clarity 0..1 to accept a hop as voiced (default 0.6). */
  minClarity?: number;
  /** Collapse a sustained pitch into a single onset (default true). */
  mergeRepeats?: boolean;
}

/** The 16 note-block instruments (the block beneath the note block selects it). */
export const NOTE_BLOCK_INSTRUMENTS = [
  "harp", "bass", "basedrum", "snare", "hat", "bell", "flute", "chime",
  "guitar", "xylophone", "iron_xylophone", "cow_bell", "didgeridoo", "bit",
  "banjo", "pling",
] as const;

export type NoteBlockInstrument = (typeof NOTE_BLOCK_INSTRUMENTS)[number];

/** MIDI note number of note-block note 0 (F#3). */
export const NOTE_BLOCK_BASE_MIDI = 54;

/** Number of distinct note-block pitches (0..24 inclusive). */
export const NOTE_BLOCK_RANGE = 25;

/**
 * `playsound` pitch parameter for a given note-block `note` (0..24).
 * note 0 → 0.5, note 12 → 1.0, note 24 → 2.0.
 */
export function noteBlockPitch(note: number): number {
  return 2 ** ((note - 12) / 12);
}

/**
 * Nearest note-block `note` index (0..24) for a frequency in Hz, octave-folded
 * into the two-octave F#3..F#5 window so any audible pitch maps to a real block.
 */
export function hzToNoteIndex(hz: number): number {
  if (!(hz > 0)) return 0;
  const midi = Math.round(69 + 12 * Math.log2(hz / 440));
  let n = midi - NOTE_BLOCK_BASE_MIDI;
  while (n < 0) n += 12;
  while (n > 24) n -= 12;
  return n;
}

export interface PitchResult {
  /** Detected fundamental in Hz, or 0 when unvoiced. */
  hz: number;
  /** Autocorrelation clarity 0..1 (1 = perfectly periodic). */
  clarity: number;
  /** RMS amplitude of the window. */
  rms: number;
}

/**
 * Single-window fundamental-frequency estimate via normalised autocorrelation
 * with parabolic interpolation. Pure; safe to call from anywhere.
 */
export function detectPitchHz(
  window: Float32Array,
  sampleRate: number,
  minHz: number,
  maxHz: number,
): PitchResult {
  const n = window.length;
  if (n < 4) return { hz: 0, clarity: 0, rms: 0 };

  // Prefix sums of squares → O(1) window energy for any lag alignment.
  const sq = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) sq[i + 1] = sq[i]! + window[i]! * window[i]!;
  const totalEnergy = sq[n]!;
  const rms = Math.sqrt(totalEnergy / n);
  if (rms < 1e-7) return { hz: 0, clarity: 0, rms };

  const minLag = Math.max(2, Math.floor(sampleRate / maxHz));
  const maxLag = Math.min(n - 2, Math.ceil(sampleRate / minHz));
  if (maxLag <= minLag) return { hz: 0, clarity: 0, rms };

  const nc = new Float64Array(maxLag + 2); // normalised correlation by lag
  let globalMax = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let corr = 0;
    for (let i = 0; i + lag < n; i++) corr += window[i]! * window[i + lag]!;
    // Energy of the two aligned half-windows: leading [0,n-lag), trailing [lag,n).
    const e0 = sq[n - lag]!;
    const e1 = totalEnergy - sq[lag]!;
    const denom = Math.sqrt(e0 * e1);
    const c = denom > 1e-12 ? corr / denom : 0;
    nc[lag] = c;
    if (c > globalMax) globalMax = c;
  }
  if (globalMax <= 0) return { hz: 0, clarity: 0, rms };

  // Octave-error fix: a pure tone autocorrelates equally at every multiple of its
  // true period, so the global peak is ambiguous (it can land on a subharmonic an
  // octave+ too low). Pick the SHORTEST-lag local maximum within 90% of the global
  // peak — that is the fundamental, not a subharmonic (YIN-style absolute threshold).
  const threshold = 0.9 * globalMax;
  let bestLag = -1;
  for (let lag = minLag + 1; lag < maxLag; lag++) {
    if (nc[lag]! >= threshold && nc[lag]! >= nc[lag - 1]! && nc[lag]! >= nc[lag + 1]!) {
      bestLag = lag;
      break;
    }
  }
  if (bestLag < 0) {
    for (let lag = minLag; lag <= maxLag; lag++) {
      if (nc[lag]! === globalMax) {
        bestLag = lag;
        break;
      }
    }
  }
  const bestCorr = nc[bestLag]!;

  // Parabolic interpolation around the peak for sub-sample lag accuracy.
  let refined = bestLag;
  if (bestLag > minLag && bestLag < maxLag) {
    const lo = nc[bestLag - 1]!;
    const mid = nc[bestLag]!;
    const hi = nc[bestLag + 1]!;
    const denom = lo - 2 * mid + hi;
    if (denom !== 0) {
      let shift = (0.5 * (lo - hi)) / denom;
      if (shift > 1) shift = 1;
      else if (shift < -1) shift = -1;
      refined = bestLag + shift;
    }
  }
  return { hz: sampleRate / refined, clarity: bestCorr, rms };
}

/**
 * Convert mono PCM into a Minecraft note-block timeline. Windows the signal at
 * `hopMs`, estimates the dominant pitch per hop, gates out silence/noise, and
 * (by default) collapses a sustained pitch into a single onset.
 */
export function analyzeAudio(
  pcm: Float32Array,
  sampleRate: number,
  opts: AnalyzeOptions = {},
): NoteEvent[] {
  if (!(sampleRate > 0) || pcm.length === 0) return [];

  const hopMs = opts.hopMs ?? 50;
  const windowMs = opts.windowMs ?? 46;
  const tps = opts.ticksPerSecond ?? 20;
  const instrument = opts.instrument ?? "harp";
  const minHz = opts.minHz ?? 110;
  const maxHz = opts.maxHz ?? 1200;
  const minClarity = opts.minClarity ?? 0.6;
  const mergeRepeats = opts.mergeRepeats ?? true;

  const hop = Math.max(1, Math.round((hopMs / 1000) * sampleRate));
  // Window sets frequency resolution and is decoupled from the hop: short enough
  // not to straddle note boundaries, long enough for ~5 periods of the lowest pitch.
  const winLen = Math.min(
    pcm.length,
    Math.max(256, Math.round((windowMs / 1000) * sampleRate)),
  );

  let peak = 0;
  for (let i = 0; i < pcm.length; i++) {
    const a = Math.abs(pcm[i]!);
    if (a > peak) peak = a;
  }
  if (peak <= 0) return [];
  const rmsGate = (opts.rmsGate ?? 0.04) * peak;

  const events: NoteEvent[] = [];
  let lastNote = -1;
  for (let start = 0; start + winLen <= pcm.length; start += hop) {
    const win = pcm.subarray(start, start + winLen);
    const { hz, clarity, rms } = detectPitchHz(win, sampleRate, minHz, maxHz);
    if (rms < rmsGate || clarity < minClarity || hz <= 0) {
      lastNote = -1; // a gap re-arms the next identical pitch as a fresh onset
      continue;
    }
    const note = hzToNoteIndex(hz);
    if (mergeRepeats && note === lastNote) continue; // sustain — don't re-trigger
    const tick = Math.round((start / sampleRate) * tps);
    const velocity = Math.min(1, rms / peak);
    events.push({
      tick,
      note,
      instrument,
      velocity: Math.round(velocity * 1000) / 1000,
    });
    lastNote = note;
  }
  return events;
}

/** Total game-tick length of a note timeline (last onset tick, or 0 when empty). */
export function noteTimelineTicks(events: NoteEvent[]): number {
  let max = 0;
  for (const e of events) if (e.tick > max) max = e.tick;
  return max;
}
