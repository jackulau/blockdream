import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createBlockArt, blockArtDropMessage, type BlockArtEls } from "../src/blockart-core";

// Import ERROR feedback (goal 087 D6). Before this, a corrupt/undecodable image was a TOTAL
// silent no-op: img.onload never fired, the previous image + stats stayed, and the object URL
// leaked. Now loadFile/loadUrl register onerror and say what happened; the §02 drop zone routes
// through blockArtDropMessage so non-images (and OS drags with an empty MIME type) get a message
// instead of being dropped on the floor.
//
// Same fake style as blockart-import.test.ts (no DOM in this repo's test env): FakeImage is
// extended with onerror so tests can make the decode fail.

let images: FakeImage[] = [];
class FakeImage {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  crossOrigin = "";
  src = "";
  constructor() {
    images.push(this);
  }
}

function makeEls(): { els: BlockArtEls; stats: { textContent: string } } {
  const stats = { textContent: "" };
  const els = {
    file: new EventTarget() as unknown as HTMLInputElement,
    grid: Object.assign(new EventTarget(), { value: "64" }) as unknown as HTMLInputElement,
    gridVal: { textContent: "" } as unknown as HTMLElement,
    dither: Object.assign(new EventTarget(), { value: "floyd-steinberg" }) as unknown as HTMLSelectElement,
    stats: stats as unknown as HTMLElement,
    src: new EventTarget() as unknown as HTMLCanvasElement,
    out: new EventTarget() as unknown as HTMLCanvasElement,
    bom: {} as unknown as HTMLElement,
    tooltip: { style: {} } as unknown as HTMLElement,
  };
  return { els, stats };
}

describe("import error feedback", () => {
  let createObjectURL: ReturnType<typeof vi.spyOn>;
  let revokeObjectURL: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    images = [];
    vi.stubGlobal("Image", FakeImage);
    createObjectURL = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:fake");
    revokeObjectURL = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  });
  afterEach(() => {
    createObjectURL.mockRestore();
    revokeObjectURL.mockRestore();
    vi.unstubAllGlobals();
  });

  it("a corrupt image writes a couldn't-decode message and revokes the object URL", async () => {
    const { els, stats } = makeEls();
    const art = createBlockArt(els);
    await art.loadFile(new File([new Uint8Array([9, 9, 9])], "broken.png", { type: "image/png" }));
    expect(images).toHaveLength(1);
    images[0]!.onerror!(); // the browser failed to decode it
    expect(stats.textContent).toContain("couldn't decode broken.png");
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:fake"); // no leak on the error path
  });

  it("a corrupt GIF falls back to the static path and still reports the failure", async () => {
    const { els, stats } = makeEls();
    const art = createBlockArt(els);
    // decodeGif throws here (no ImageDecoder in this env) → static-image fallback → onerror
    await art.loadFile(new File([new Uint8Array([1])], "broken.gif", { type: "image/gif" }));
    expect(images).toHaveLength(1);
    images[0]!.onerror!();
    expect(stats.textContent).toContain("couldn't decode broken.gif");
  });

  it("a failing sample URL writes a couldn't-load message instead of a silent empty section", () => {
    const { els, stats } = makeEls();
    const art = createBlockArt(els);
    art.loadUrl("/test-assets/pixelart.png");
    expect(images).toHaveLength(1);
    images[0]!.onerror!(); // 404 / undecodable
    expect(stats.textContent).toContain("couldn't load /test-assets/pixelart.png");
  });

  it("the success path still loads (onerror wiring does not disturb onload)", async () => {
    const { els, stats } = makeEls();
    const art = createBlockArt(els);
    await art.loadFile(new File([new Uint8Array([1, 2, 3])], "ok.png", { type: "image/png" }));
    expect(images[0]!.onload).toBeTypeOf("function");
    expect(images[0]!.onerror).toBeTypeOf("function");
    expect(stats.textContent).toBe(""); // no error text until an error actually happens
  });
});

describe("blockArtDropMessage (§02 drop-zone routing)", () => {
  it("accepts images and GIFs, including OS drags with an EMPTY MIME type (extension-first)", () => {
    expect(blockArtDropMessage({ name: "photo.png", type: "image/png" })).toBeNull();
    expect(blockArtDropMessage({ name: "photo.jpg", type: "" })).toBeNull(); // the old type-only check dropped this
    expect(blockArtDropMessage({ name: "loop.gif", type: "" })).toBeNull();
    expect(blockArtDropMessage({ name: "import", type: "image/webp" })).toBeNull(); // MIME fallback still works
  });

  it("routes a video to section 03 instead of silently ignoring it", () => {
    const msg = blockArtDropMessage({ name: "clip.mp4", type: "video/mp4" });
    expect(msg).toContain("clip.mp4");
    expect(msg).toContain("section 03");
    expect(blockArtDropMessage({ name: "clip.mp4", type: "" })).toContain("section 03"); // empty-MIME video too
  });

  it("routes a 3D model to section 03 and rejects everything else with a helpful message", () => {
    expect(blockArtDropMessage({ name: "chair.obj", type: "" })).toContain("section 03");
    const msg = blockArtDropMessage({ name: "notes.txt", type: "text/plain" });
    expect(msg).toContain("notes.txt");
    expect(msg).toContain("drop an image");
  });
});
