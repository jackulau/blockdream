import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { decodeVideo, importAbortError } from "../src/video";
import { decodeGif, plannedGifFrames, GIF_DECODE_PIXEL_BUDGET } from "../src/gif";
import { IMPORT_TRIGGER_IDS, importBusyText, IMPORT_CANCELLED_TEXT, gifCapNote } from "../src/ui-feedback";

// Import robustness (goal 089 D9).
// (a) importFiles has three fire-and-forget entry points (picker, drop, URL) and no
//     re-entrancy guard: two interleaved imports raced the state reset against the other's
//     post-decode writes and corrupted the flatVolFrames/flatDurationsMs pairing.
// (b) No cancel existed anywhere: decodeVideo's bare seek loop can be tens of thousands of
//     seeks (maxFrames = fps × 660), each with a 2 s stall fallback - worst case hours with
//     every control live and no way out but closing the tab.
// (c) The GIF path retained a full-resolution canvas per frame UNCAPPED (a 600-frame 1080p
//     GIF ≈ 5 GB) while the video path already had a budget + honest "capped" HUD note.

const read = (p: string): string => readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8");

// --- fakes: a controllable <video> + canvas pair so the REAL decode loop runs in node -----

class FakeVideo extends EventTarget {
  muted = false;
  playsInline = false;
  preload = "";
  duration = 2;
  videoWidth = 64;
  videoHeight = 48;
  seeksServed = 0;
  stallAfter = Infinity; // after this many seeks, `seeked` never fires (stalled decoder)
  private _src = "";
  set src(v: string) {
    this._src = v;
    queueMicrotask(() => this.dispatchEvent(new Event("loadedmetadata")));
  }
  get src(): string {
    return this._src;
  }
  set currentTime(_t: number) {
    if (this.seeksServed >= this.stallAfter) return; // never fires seeked again
    this.seeksServed++;
    this.dispatchEvent(new Event("seeked"));
  }
  get currentTime(): number {
    return 0;
  }
}

const fakeCanvas = (): unknown => ({ width: 0, height: 0, getContext: () => ({ drawImage: () => {} }) });

function stubVideoDom(video: FakeVideo): { restore: () => void } {
  vi.stubGlobal("document", {
    createElement: (tag: string) => (tag === "video" ? video : fakeCanvas()),
  });
  const createObjectURL = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:fake");
  const revokeObjectURL = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  return {
    restore: () => {
      createObjectURL.mockRestore();
      revokeObjectURL.mockRestore();
      vi.unstubAllGlobals();
    },
  };
}

const videoFile = (): File => new File([1 as unknown as BlobPart], "clip.mp4", { type: "video/mp4" });

describe("(b) decodeVideo carries an AbortSignal through the seek loop", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("decodes normally when never aborted (control case)", async () => {
    const video = new FakeVideo();
    const dom = stubVideoDom(video);
    try {
      let frames = 0;
      const { durationsMs } = await decodeVideo(videoFile(), {
        fps: 5,
        onFrame: () => frames++,
        signal: new AbortController().signal,
      });
      expect(frames).toBe(11); // 2 s at 5 fps → floor(2*5)+1
      expect(durationsMs.length).toBe(11);
    } finally {
      dom.restore();
    }
  });

  it("an abort mid-decode rejects with AbortError, stops the frame stream, and skips the 2 s stall fallback", async () => {
    const video = new FakeVideo();
    video.stallAfter = 3; // the 4th seek never fires `seeked` - a stalled decoder
    const dom = stubVideoDom(video);
    try {
      const controller = new AbortController();
      let frames = 0;
      const t0 = performance.now();
      const decode = decodeVideo(videoFile(), {
        fps: 5,
        onFrame: () => {
          frames++;
          if (frames === 3) setTimeout(() => controller.abort(), 10); // abort DURING the stalled seek
        },
        signal: controller.signal,
      });
      await expect(decode).rejects.toMatchObject({ name: "AbortError" });
      expect(frames).toBe(3); // no frame after the abort - the caller's state write never runs
      expect(performance.now() - t0).toBeLessThan(1500); // did not sit out the 2000 ms fallback
    } finally {
      dom.restore();
    }
  });

  it("importAbortError is AbortError-named so hosts can tell a cancel from a failure", () => {
    const e = importAbortError();
    expect(e.name).toBe("AbortError");
    expect(e.message).toContain("cancelled");
  });
});

// --- (c) GIF decode memory budget ----------------------------------------------------------

class FakeImage {
  constructor(
    public displayWidth: number,
    public displayHeight: number,
    public duration: number | null = 40000,
  ) {}
  close(): void {}
}

function stubGifDom(frameCount: number, w: number, h: number): void {
  class FakeImageDecoder {
    tracks = { ready: Promise.resolve(), selectedTrack: { frameCount } };
    decode({ frameIndex }: { frameIndex: number }): Promise<{ image: FakeImage }> {
      void frameIndex;
      return Promise.resolve({ image: new FakeImage(w, h) });
    }
  }
  vi.stubGlobal("window", { ImageDecoder: FakeImageDecoder });
  vi.stubGlobal("document", { createElement: () => fakeCanvas() });
}

const gifFile = (): File => new File([1 as unknown as BlobPart], "big.gif", { type: "image/gif" });

describe("(c) decodeGif budgets retained pixels like the video path", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("plannedGifFrames: pure budget math, never below 1 frame, never above the clip", () => {
    expect(plannedGifFrames(40, 2000, 2000, 2000 * 2000 * 10)).toBe(10);
    expect(plannedGifFrames(5, 100, 100)).toBe(5); // small clip: untouched by the default budget
    expect(plannedGifFrames(3, 1e9, 1)).toBe(1); // degenerate huge frame still keeps one
    // the default budget keeps every reasonable GIF whole (480×360 → 740 frames)
    expect(plannedGifFrames(600, 480, 360)).toBe(600);
    expect(plannedGifFrames(9999, 480, 360)).toBe(Math.floor(GIF_DECODE_PIXEL_BUDGET / (480 * 360)));
  });

  it("an over-budget GIF keeps the first N frames and reports the cap", async () => {
    stubGifDom(40, 2000, 2000);
    const out = await decodeGif(gifFile(), { pixelBudget: 2000 * 2000 * 10 });
    expect(out.canvases.length).toBe(10);
    expect(out.durationsMs.length).toBe(10);
    expect(out.capped).toEqual({ kept: 10, total: 40 });
  });

  it("a within-budget GIF decodes whole with no cap note", async () => {
    stubGifDom(12, 100, 100);
    const out = await decodeGif(gifFile());
    expect(out.canvases.length).toBe(12);
    expect(out.capped).toBeUndefined();
    expect(gifCapNote(out.capped)).toBe("");
  });

  it("an aborted GIF decode rejects with AbortError", async () => {
    stubGifDom(12, 100, 100);
    const controller = new AbortController();
    controller.abort();
    await expect(decodeGif(gifFile(), { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
  });

  it("the cap note is the honest video-path pattern", () => {
    expect(gifCapNote({ kept: 10, total: 40 })).toBe(" · capped at 10/40 frames (memory)");
  });
});

// --- (a) re-entrancy guard + cancel wiring (source level - house pattern, no jsdom) --------

describe("(a) importFiles re-entrancy guard + cancel control", () => {
  const showcase = read("../src/showcase.ts");
  const index = read("../index.html");

  it("a second import while one runs is refused with a clear HUD line, never interleaved", () => {
    expect(showcase).toContain("if (importing) {");
    expect(showcase).toContain("importBusyText(files[0]!.name");
    expect(importBusyText("b.mp4")).toContain("already running");
    expect(importBusyText("b.mp4")).toContain("b.mp4");
  });

  it("the guard + triggers + cancel visibility reset in finally (also on failure/abort)", () => {
    expect(showcase).toMatch(/finally \{\s*importing = false;\s*importAbort = null;\s*setImportBusy\(false\);/);
    expect(showcase).toContain("setImportBusy(true)");
    expect(showcase).toContain("for (const id of IMPORT_TRIGGER_IDS)");
  });

  it("every import trigger is a real control on index.html", () => {
    for (const id of IMPORT_TRIGGER_IDS) expect(index, id).toContain(`id="${id}"`);
  });

  it("the visible cancel control exists (hidden until an import runs) and aborts the controller", () => {
    expect(index).toMatch(/id="v3-cancel"[^>]*hidden/);
    expect(showcase).toContain('cancelBtn.addEventListener("click", () => importAbort?.abort())');
    expect(showcase).toContain("cancelBtn.hidden = !busy");
  });

  it("both decoders receive the signal; a cancel lands as the honest cancelled HUD line", () => {
    expect(showcase).toContain("decodeGif(gif, { signal })");
    expect(showcase).toMatch(/decodeVideo\(video, \{[^}]*signal,/s);
    expect(showcase).toContain('(err as Error).name === "AbortError"');
    expect(showcase).toContain("IMPORT_CANCELLED_TEXT");
    expect(IMPORT_CANCELLED_TEXT).toContain("cancelled");
  });
});
