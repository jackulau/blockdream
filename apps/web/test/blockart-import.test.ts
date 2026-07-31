import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createBlockArt, type BlockArtEls } from "../src/blockart-core";

// Regression: selecting the IDENTICAL file twice must invoke the import pipeline twice.
// Browsers only fire "change" when the input's value CHANGES, so if the handler never
// clears els.file.value, re-picking the same file (e.g. retrying after a failed import)
// silently does nothing. The fix resets value to "" after each change.
//
// Like the other web tests (see audio.test.ts / video-decode.test.ts), the full DOM can't
// run here (no jsdom dependency in this repo), so the injectable els contract is exercised
// with EventTarget-backed fakes. The fake input mimics the browser's file-input semantics:
// picking a file sets files + a fakepath value and fires "change" ONLY if the value changed.

class FakeFileInput extends EventTarget {
  value = "";
  files: FileList | null = null;
  /** Simulate the user picking `file`. Returns whether a "change" event fired (browser rule:
   *  only when the input's value actually changes). */
  selectFile(file: File): boolean {
    const nextValue = `C:\\fakepath\\${file.name}`;
    if (this.value === nextValue) return false; // same value: real browsers fire no event
    Object.defineProperty(this, "files", { configurable: true, writable: true, value: [file] });
    this.value = nextValue;
    this.dispatchEvent(new Event("change"));
    return true;
  }
}

function makeEls(): { els: BlockArtEls; file: FakeFileInput } {
  const file = new FakeFileInput();
  const els = {
    file: file as unknown as HTMLInputElement,
    grid: Object.assign(new EventTarget(), { value: "64" }) as unknown as HTMLInputElement,
    gridVal: { textContent: "" } as unknown as HTMLElement,
    dither: Object.assign(new EventTarget(), { value: "floyd-steinberg" }) as unknown as HTMLSelectElement,
    stats: { textContent: "" } as unknown as HTMLElement,
    src: new EventTarget() as unknown as HTMLCanvasElement,
    out: new EventTarget() as unknown as HTMLCanvasElement,
    bom: {} as unknown as HTMLElement,
    tooltip: { style: {} } as unknown as HTMLElement,
  };
  return { els, file };
}

// The static-image path of loadFile synchronously does `new Image()` + `URL.createObjectURL`,
// so counting Image loads counts pipeline invocations (onload never fires; render is not needed).
let imageLoads = 0;
class FakeImage {
  onload: (() => void) | null = null;
  crossOrigin = "";
  set src(_v: string) {
    imageLoads++;
  }
}

describe("blockart file input", () => {
  let createObjectURL: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    imageLoads = 0;
    vi.stubGlobal("Image", FakeImage);
    createObjectURL = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:fake");
  });
  afterEach(() => {
    createObjectURL.mockRestore();
    vi.unstubAllGlobals();
  });

  it("clears the input value after handling a change", () => {
    const { els, file } = makeEls();
    createBlockArt(els);
    const png = new File([new Uint8Array([1, 2, 3])], "retry.png", { type: "image/png" });
    expect(file.selectFile(png)).toBe(true);
    expect(file.value).toBe(""); // reset so the next pick of the same file re-fires "change"
    expect(imageLoads).toBe(1);
  });

  it("selecting the SAME file twice runs the import pipeline twice", () => {
    const { els, file } = makeEls();
    createBlockArt(els);
    const png = new File([new Uint8Array([1, 2, 3])], "retry.png", { type: "image/png" });
    expect(file.selectFile(png)).toBe(true);
    expect(file.selectFile(png)).toBe(true); // would be false (no event at all) without the reset
    expect(imageLoads).toBe(2);
    expect(createObjectURL).toHaveBeenCalledTimes(2);
    expect(file.value).toBe("");
  });

  it("a change with no file selected is a no-op but still resets the value", () => {
    const { els, file } = makeEls();
    createBlockArt(els);
    file.value = "stale";
    file.dispatchEvent(new Event("change")); // files is still null
    expect(imageLoads).toBe(0);
    expect(file.value).toBe("");
  });
});
