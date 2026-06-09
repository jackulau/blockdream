// Contract-drift guard: the driving WM's physical telemetry bounds are hardcoded INDEPENDENTLY
// on both sides of the wire —
//   model side: ml/src/blockdream_wm/drive/transition.py  (bound_tel's per-channel scale*tanh)
//   web side:   apps/web/src/drive.ts + apps/web/src/showcase.ts  (HUD clamps on speed / yaw-rate)
// If someone changes one side, the other silently drifts (e.g. model allows 80 m/s but the HUD
// clamps to 60 → live values get clipped). This test reads all three SOURCE files and asserts the
// web clamps are equal to or LOOSER than the model's physical bounds for each channel.
//
// Telemetry layout (6-channel): [vx/30, vy/15, r, speed/30, sin(yaw), cos(yaw)]
//   channel 2 = yaw-rate r, already physical (rad/s) → model bound = tel_scale[2]
//   channel 3 = speed/30, normalized → model bound (m/s) = tel_scale[3] * 30
//
// Every extraction FAILS LOUDLY if its pattern stops matching, so a refactor can't silently
// disable the guard — it forces whoever refactors to update this test (and re-check the contract).

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..");

const TRANSITION_PY = join(REPO, "ml", "src", "blockdream_wm", "drive", "transition.py");
const DRIVE_TS = join(REPO, "apps", "web", "src", "drive.ts");
const SHOWCASE_TS = join(REPO, "apps", "web", "src", "showcase.ts");

const transitionPy = readFileSync(TRANSITION_PY, "utf8");
const driveTs = readFileSync(DRIVE_TS, "utf8");
const showcaseTs = readFileSync(SHOWCASE_TS, "utf8");

const HOW_TO_FIX =
  "If that code was refactored, update the extraction regex in apps/web/test/telemetry-bounds.test.ts " +
  "AND re-verify the model-side bounds vs web-side clamps still agree — this guard must never be " +
  "silently disabled.";

function mustMatch(src: string, re: RegExp, what: string, file: string): RegExpMatchArray {
  const m = src.match(re);
  if (!m) {
    throw new Error(
      `telemetry-bounds guard: could not find ${what} in ${file} (pattern ${re}). ${HOW_TO_FIX}`,
    );
  }
  return m;
}

const NUM = String.raw`(-?\d+(?:\.\d+)?)`;

// --- model side: per-channel tanh scales + the speed normalization factor ----------------------

function extractModelBounds(): { speedMs: number; yawRateRadS: number; speedDenorm: number } {
  // default_scale = torch.tensor([2.0, 2.0, 3.0, 2.0, 1.5, 1.5])
  const scaleM = mustMatch(
    transitionPy,
    /default_scale\s*=\s*torch\.tensor\(\s*\[([^\]]+)\]\s*\)/,
    "the bound_tel per-channel scale tensor (default_scale = torch.tensor([...]))",
    "ml/src/blockdream_wm/drive/transition.py",
  );
  const scales = scaleM[1]!.split(",").map((s) => Number.parseFloat(s.trim()));
  if (scales.length !== 6 || scales.some((v) => !Number.isFinite(v))) {
    throw new Error(
      `telemetry-bounds guard: expected 6 finite per-channel scales in transition.py, got [${scaleM[1]}]. ` +
        `The 6-channel layout [vx/30, vy/15, r, speed/30, sin(yaw), cos(yaw)] is baked into this test ` +
        `(yaw-rate = channel 2, speed = channel 3). ${HOW_TO_FIX}`,
    );
  }

  // The speed channel is normalized; the divisor is documented in the layout comment ("speed/30").
  const denormM = mustMatch(
    transitionPy,
    /speed\s*\/\s*(\d+(?:\.\d+)?)/,
    'the speed normalization factor (the "speed/30" telemetry-layout documentation)',
    "ml/src/blockdream_wm/drive/transition.py",
  );
  const speedDenorm = Number.parseFloat(denormM[1]!);

  return {
    yawRateRadS: scales[2]!, // channel 2 (r) is already physical rad/s
    speedMs: scales[3]! * speedDenorm, // channel 3 is speed/denorm → physical m/s
    speedDenorm,
  };
}

// --- web side: HUD clamps in drive.ts and showcase.ts -------------------------------------------
// Two accepted shapes (both must extract: multiplier where applicable + lo/hi clamp):
//   finiteClamp((tel[3] ?? 0) * 30, 0, 60)            / finiteClamp(tel[2] ?? 0, -6, 6)
//   Math.min(60, Math.max(0, (tel[3] ?? 0) * 30))     / Math.min(6, Math.max(-6, tel[2] ?? 0))

interface WebClamps {
  speedMult: number;
  speedLo: number;
  speedHi: number;
  yawLo: number;
  yawHi: number;
}

function extractWebClamps(src: string, file: string): WebClamps {
  // speed: telemetry channel 3, denormalized by a multiplier, then clamped
  const speedClampRe = new RegExp(
    String.raw`finiteClamp\(\s*\(\s*\w+\[3\]\s*\?\?\s*0\s*\)\s*\*\s*${NUM}\s*,\s*${NUM}\s*,\s*${NUM}\s*\)`,
  );
  const speedMinMaxRe = new RegExp(
    String.raw`Math\.min\(\s*${NUM}\s*,\s*Math\.max\(\s*${NUM}\s*,\s*\(\s*\w+\[3\]\s*\?\?\s*0\s*\)\s*\*\s*${NUM}\s*\)\s*\)`,
  );
  let speedMult: number, speedLo: number, speedHi: number;
  const sc = src.match(speedClampRe);
  if (sc) {
    [speedMult, speedLo, speedHi] = [+sc[1]!, +sc[2]!, +sc[3]!];
  } else {
    const sm = mustMatch(src, speedMinMaxRe, "the speed (telemetry[3]) HUD clamp", file);
    [speedHi, speedLo, speedMult] = [+sm[1]!, +sm[2]!, +sm[3]!];
  }

  // yaw-rate: telemetry channel 2, physical units, clamped directly (no multiplier)
  const yawClampRe = new RegExp(
    String.raw`finiteClamp\(\s*\(?\s*\w+\[2\]\s*\?\?\s*0\s*\)?\s*,\s*${NUM}\s*,\s*${NUM}\s*\)`,
  );
  const yawMinMaxRe = new RegExp(
    String.raw`Math\.min\(\s*${NUM}\s*,\s*Math\.max\(\s*${NUM}\s*,\s*\(?\s*\w+\[2\]\s*\?\?\s*0\s*\)?\s*\)\s*\)`,
  );
  let yawLo: number, yawHi: number;
  const yc = src.match(yawClampRe);
  if (yc) {
    [yawLo, yawHi] = [+yc[1]!, +yc[2]!];
  } else {
    const ym = mustMatch(src, yawMinMaxRe, "the yaw-rate (telemetry[2]) HUD clamp", file);
    [yawHi, yawLo] = [+ym[1]!, +ym[2]!];
  }

  return { speedMult, speedLo, speedHi, yawLo, yawHi };
}

// --- the contract --------------------------------------------------------------------------------

describe("driving telemetry bounds: model (transition.py) vs web HUD clamps", () => {
  const model = extractModelBounds();
  const webFiles: Array<[string, WebClamps]> = [
    ["apps/web/src/drive.ts", extractWebClamps(driveTs, "apps/web/src/drive.ts")],
    ["apps/web/src/showcase.ts", extractWebClamps(showcaseTs, "apps/web/src/showcase.ts")],
  ];

  it("model-side bounds are physically sane", () => {
    expect(model.speedMs).toBeGreaterThan(0);
    expect(model.yawRateRadS).toBeGreaterThan(0);
    expect(model.speedDenorm).toBeGreaterThan(0);
  });

  for (const [file, web] of webFiles) {
    describe(file, () => {
      it("denormalizes speed with the same factor the model layout uses", () => {
        // If these disagree, the HUD's m/s display is wrong even when clamps look fine.
        expect(
          web.speedMult,
          `${file} multiplies telemetry[3] by ${web.speedMult}, but transition.py documents the ` +
            `layout as speed/${model.speedDenorm} — the displayed m/s would be wrong. ${HOW_TO_FIX}`,
        ).toBe(model.speedDenorm);
      });

      it(`speed clamp is not tighter than the model bound (${model.speedMs} m/s)`, () => {
        expect(
          web.speedHi,
          `${file} clamps speed to <= ${web.speedHi} m/s, tighter than the model's physical bound ` +
            `of ${model.speedMs} m/s (tel_scale[3] * ${model.speedDenorm}) — live values would be clipped. ${HOW_TO_FIX}`,
        ).toBeGreaterThanOrEqual(model.speedMs);
        // Speed is displayed as a non-negative magnitude; clamping its floor at 0 is intentional,
        // but the floor must never rise above 0.
        expect(
          web.speedLo,
          `${file} clamps speed to >= ${web.speedLo} m/s; the floor must be <= 0. ${HOW_TO_FIX}`,
        ).toBeLessThanOrEqual(0);
      });

      it(`yaw-rate clamp is not tighter than the model bound (±${model.yawRateRadS} rad/s)`, () => {
        expect(
          web.yawHi,
          `${file} clamps yaw-rate to <= ${web.yawHi} rad/s, tighter than the model's physical bound ` +
            `of ${model.yawRateRadS} rad/s (tel_scale[2]) — live values would be clipped. ${HOW_TO_FIX}`,
        ).toBeGreaterThanOrEqual(model.yawRateRadS);
        expect(
          web.yawLo,
          `${file} clamps yaw-rate to >= ${web.yawLo} rad/s, tighter than the model's physical bound ` +
            `of -${model.yawRateRadS} rad/s. ${HOW_TO_FIX}`,
        ).toBeLessThanOrEqual(-model.yawRateRadS);
      });
    });
  }
});
