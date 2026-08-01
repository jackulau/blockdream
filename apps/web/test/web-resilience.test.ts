import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  SECTION3_CONTROL_IDS,
  viewer3dUnavailableText,
  AUDIO_BLOCKED_TEXT,
  settingsChangeNote,
  blockArtExportText,
  resetDisabled,
} from "../src/ui-feedback";
import { ClipAudio } from "../src/clip-audio";
import { NotePreview } from "../src/note-preview";

// Web resilience batch (goal 088 D11). Every silent failure mode gets an honest surface:
// WebGL-unavailable, sample-404, exports-before-frames, disconnected resets, autoplay-blocked
// audio, animated-GIF single-frame exports, and mid-clip fps/res changes. Pure decisions are
// unit-tested from ui-feedback.ts; the showcase/tester wiring is locked at source level
// (nav-ring.test.ts house pattern - no jsdom in this repo).

const read = (p: string): string => readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8");
const showcase = read("../src/showcase.ts");
const index = read("../index.html");

describe("(a) WebGL-unavailable fallback", () => {
  it("setup3dViewer is awaited with a .catch - never a fire-and-forget void", () => {
    expect(showcase).toContain("setup3dViewer().catch(");
    expect(showcase).not.toContain("void setup3dViewer()");
  });

  it("the fallback text names the reason and the requirement", () => {
    const t = viewer3dUnavailableText("Error creating WebGL context");
    expect(t).toContain("3D viewer unavailable");
    expect(t).toContain("Error creating WebGL context");
    expect(t).toContain("WebGL required");
  });

  it("every SECTION3_CONTROL_IDS entry is a real control on index.html, and the catch disables them", () => {
    expect(SECTION3_CONTROL_IDS.length).toBeGreaterThanOrEqual(15);
    for (const id of SECTION3_CONTROL_IDS) expect(index, id).toContain(`id="${id}"`);
    expect(showcase).toContain("for (const id of SECTION3_CONTROL_IDS)");
  });
});

describe("(b) sample-image failure", () => {
  it("the 3D sample img has an onerror that writes a clear HUD message", () => {
    expect(showcase).toContain("img.onerror = () => {");
    expect(showcase).toContain("couldn't load the sample /test-assets/pixelart.png");
  });
});

describe("(c) GIF/PNG export buttons", () => {
  it("ship disabled in index.html (they silently no-op'd before frames existed)", () => {
    expect(index).toMatch(/id="v3-gif"[^>]*disabled/);
    expect(index).toMatch(/id="v3-png"[^>]*disabled/);
  });

  it("are enabled together with the datapack button everywhere frames appear (5 sites)", () => {
    const sites = showcase.match(/enable3dExports\(\);/g) ?? [];
    expect(sites.length).toBeGreaterThanOrEqual(5);
    // no stray datapack-only enable outside the helper's own definition
    const bare = showcase.match(/\$<HTMLButtonElement>\("v3-download"\)\.disabled = false/g) ?? [];
    expect(bare.length).toBe(0);
    expect(showcase).toContain('for (const id of ["v3-download", "v3-gif", "v3-png"])');
  });
});

describe("(d) reset buttons surface connection state", () => {
  it("resetDisabled follows the pill: enabled only while live", () => {
    expect(resetDisabled("ok")).toBe(false);
    expect(resetDisabled("err")).toBe(true);
    expect(resetDisabled("idle")).toBe(true);
  });

  it("all 4 reset buttons ship disabled and are wired to the connect/disconnect transitions", () => {
    expect(index).toMatch(/id="mc-reset"[^>]*disabled/);
    expect(index).toMatch(/id="dr-reset"[^>]*disabled/);
    expect(read("../world-model.html")).toMatch(/id="reset"[^>]*disabled/);
    expect(read("../driving.html")).toMatch(/id="reset"[^>]*disabled/);
    expect(showcase).toContain('$<HTMLButtonElement>("mc-reset").disabled = resetDisabled(cls)');
    expect(showcase).toContain('$<HTMLButtonElement>("dr-reset").disabled = resetDisabled(cls)');
    expect(read("../src/world-model.ts")).toContain("resetBtn.disabled = resetDisabled(cls)");
    expect(read("../src/drive.ts")).toContain('$<HTMLButtonElement>("reset").disabled = resetDisabled(cls)');
  });
});

describe("(e) autoplay-policy rejections are surfaced, not swallowed", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("ClipAudio fires onAutoplayBlocked when play() rejects", async () => {
    const el = {
      preload: "",
      paused: true,
      currentTime: 0,
      pause: () => {},
      play: () => Promise.reject(new Error("NotAllowedError")),
      src: "",
    };
    vi.stubGlobal("Audio", function Audio(this: unknown) {
      return el;
    });
    const createObjectURL = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:fake");
    const revokeObjectURL = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    try {
      const audio = new ClipAudio();
      let blocked = 0;
      audio.onAutoplayBlocked = () => blocked++;
      audio.load(new File([1 as unknown as BlobPart], "clip.mp4", { type: "video/mp4" }), [100, 100]);
      audio.frameShown(0, true); // paused → play() → rejected by the autoplay policy
      await new Promise((r) => setTimeout(r, 0));
      expect(blocked).toBe(1);
      audio.dispose();
    } finally {
      createObjectURL.mockRestore();
      revokeObjectURL.mockRestore();
    }
  });

  it("NotePreview fires onAutoplayBlocked while the context is suspended and schedules nothing", () => {
    let oscillators = 0;
    class FakeCtx {
      state = "suspended";
      currentTime = 0;
      destination = {};
      resume(): Promise<void> {
        return Promise.resolve();
      }
      close(): Promise<void> {
        return Promise.resolve();
      }
      createOscillator(): never {
        oscillators++;
        throw new Error("must not schedule while suspended");
      }
      createGain(): unknown {
        return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect: () => ({ connect() {} }) };
      }
    }
    vi.stubGlobal("AudioContext", FakeCtx);
    const preview = new NotePreview();
    let blocked = 0;
    preview.onAutoplayBlocked = () => blocked++;
    preview.setEvents([{ tick: 0, note: 12, instrument: "harp", velocity: 0.8 }]);
    preview.frameShown(0, 2);
    expect(blocked).toBe(1);
    expect(oscillators).toBe(0); // no blast of stale notes queued into the suspended context
    preview.stop();
  });

  it("the showcase routes both callbacks into the HUD with one honest message", () => {
    expect(AUDIO_BLOCKED_TEXT).toBe("audio blocked by the browser - click play again to enable sound");
    expect(showcase).toContain("clipAudio.onAutoplayBlocked = notePreview.onAutoplayBlocked");
    expect(showcase).toContain("AUDIO_BLOCKED_TEXT");
  });
});

describe("(f) animated GIF exports one frame - and says so", () => {
  it("a still keeps the honest 1-frame text; a clip explains the single-frame export", () => {
    expect(blockArtExportText(64, 48, 1)).toBe("64×48 = 3072 blocks · 1 frame");
    const animated = blockArtExportText(64, 48, 12);
    expect(animated).toContain("64×48 = 3072 blocks");
    expect(animated).toContain("animated GIF: exporting the current frame only - use section 03 for the full animation");
    expect(animated).not.toContain("· 1 frame");
  });

  it("the §02 status line is driven by the real frame count (getFrameCount)", () => {
    expect(showcase).toContain("blockArtExportText(q.width, q.height, ba.getFrameCount())");
  });
});

describe("(g) fps/resolution selects say when they apply", () => {
  it("mid-clip changes get the re-import note; with nothing loaded there is nothing to explain", () => {
    expect(settingsChangeNote(true)).toBe("fps/resolution applies on the next import - re-import to apply");
    expect(settingsChangeNote(false)).toBeNull();
  });

  it("both selects are wired to the note in the showcase", () => {
    expect(showcase).toContain("for (const sel of [fpsSel, resSel])");
    expect(showcase).toContain("settingsChangeNote(!!flatVolFrames)");
  });
});
