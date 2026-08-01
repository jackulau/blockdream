import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  createBlockArt,
  wireBlockArtDrop,
  paletteForChoice,
  type BlockArtEls,
} from "../src/blockart-core";
import { resolveBlock } from "../src/resolve-block";
import { DATAPACK_PALETTE_NOTE } from "../src/ui-feedback";

// blockart.html tester revival (goal 088 D10). The standalone page used to load two BLANK
// canvases (no preload), navigate away when a file was dropped (no drop handlers), and ship a
// palette select wired to nothing. Locked here: (a) main.ts preloads the same sample as §02,
// (b) the extracted shared drop helper routes files exactly like the §02 zone, (c) the palette
// select genuinely switches quantization palettes (map 244 vs placeable solid gamut).
//
// House pattern: no jsdom in this repo - EventTarget/fake shims (see import-feedback.test.ts)
// plus a fake document/canvas pair that returns deterministic gradient pixels so the REAL
// quantize path runs end to end in node.

const read = (p: string): string => readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8");

describe("standalone page wiring (source-level)", () => {
  it("main.ts preloads the sample image and wires the shared drop helper + palette select", () => {
    const main = read("../src/main.ts");
    expect(main).toContain('loadUrl("/test-assets/pixelart.png")');
    expect(main).toContain("wireBlockArtDrop(");
    expect(main).toContain('palette: $<HTMLSelectElement>("palette")');
  });

  it("blockart.html has the drop zone, both palette options, and the drag highlight style", () => {
    const html = read("../blockart.html");
    expect(html).toContain('id="drop"');
    expect(html).toContain('<option value="map">');
    expect(html).toContain('<option value="block">');
    expect(html).toContain("#drop.drag");
  });

  it("showcase.ts §02 uses the SAME shared helper (no duplicated inline drop wiring)", () => {
    const showcase = read("../src/showcase.ts");
    expect(showcase).toContain('wireBlockArtDrop($<HTMLDivElement>("ba-drop")');
    expect(showcase).not.toContain('baDrop.addEventListener("drop"'); // the old inline copy is gone
  });
});

// --- shared drop helper: routes exactly like the old §02 inline wiring ---------------------

class FakeZone extends EventTarget {
  classes = new Set<string>();
  classList = {
    add: (c: string) => this.classes.add(c),
    remove: (c: string) => this.classes.delete(c),
  };
}

function dropEvent(type: string, files: File[] = []): Event {
  return Object.assign(new Event(type), { dataTransfer: { files } });
}

describe("wireBlockArtDrop (shared §02 / standalone routing)", () => {
  it("highlights on dragover and clears on dragleave/drop", () => {
    const zone = new FakeZone();
    wireBlockArtDrop(zone as unknown as HTMLElement, { textContent: "" }, async () => {});
    zone.dispatchEvent(dropEvent("dragover"));
    expect(zone.classes.has("drag")).toBe(true);
    zone.dispatchEvent(dropEvent("dragleave"));
    expect(zone.classes.has("drag")).toBe(false);
  });

  it("an image drop calls loadFile; the stats line stays untouched", () => {
    const zone = new FakeZone();
    const stats = { textContent: "" as string | null };
    const loaded: string[] = [];
    wireBlockArtDrop(zone as unknown as HTMLElement, stats, async (f) => {
      loaded.push(f.name);
    });
    zone.dispatchEvent(dropEvent("drop", [new File([1 as unknown as BlobPart], "photo.png", { type: "image/png" })]));
    expect(loaded).toEqual(["photo.png"]);
    expect(stats.textContent).toBe("");
  });

  it("a video drop writes the section-03 routing message instead of loading (same as §02)", () => {
    const zone = new FakeZone();
    const stats = { textContent: "" as string | null };
    const loaded: string[] = [];
    wireBlockArtDrop(zone as unknown as HTMLElement, stats, async (f) => {
      loaded.push(f.name);
    });
    zone.dispatchEvent(dropEvent("drop", [new File([1 as unknown as BlobPart], "clip.mp4", { type: "video/mp4" })]));
    expect(loaded).toEqual([]);
    expect(stats.textContent).toContain("clip.mp4");
    expect(stats.textContent).toContain("section 03");
  });

  it("an unknown file gets the helpful drop-an-image message; an empty drop is a no-op", () => {
    const zone = new FakeZone();
    const stats = { textContent: "" as string | null };
    wireBlockArtDrop(zone as unknown as HTMLElement, stats, async () => {});
    zone.dispatchEvent(dropEvent("drop", [new File([1 as unknown as BlobPart], "notes.txt", { type: "text/plain" })]));
    expect(stats.textContent).toContain("drop an image");
    stats.textContent = "";
    zone.dispatchEvent(dropEvent("drop", []));
    expect(stats.textContent).toBe("");
  });
});

// --- palette select: really switches the quantization palette ------------------------------

/** Deterministic wide-gamut gradient RGBA - covers enough of the color cube that the 244-colour
 *  map palette and the smaller solid-block gamut produce visibly different quantizations. */
function gradientRgba(w: number, h: number): Uint8ClampedArray {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let p = 0; p < w * h; p++) {
    const o = p * 4;
    data[o] = (p * 7) % 256;
    data[o + 1] = (p * 13) % 256;
    data[o + 2] = (p * 29) % 256;
    data[o + 3] = 255;
  }
  return data;
}

function fakeCanvas(): Record<string, unknown> {
  const c: Record<string, unknown> = {
    width: 0,
    height: 0,
    style: {},
    toDataURL: () => "data:image/png;base64,swatch",
  };
  c.getContext = () => ({
    imageSmoothingEnabled: true,
    drawImage: () => {},
    getImageData: (_x: number, _y: number, w: number, h: number) => ({ data: gradientRgba(w, h) }),
    createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }),
    putImageData: () => {},
  });
  return c;
}

class FakeNode {
  children: FakeNode[] = [];
  innerHTML = "";
  className = "";
  alt = "";
  src = "";
  onerror: unknown = null;
  constructor(public tag: string) {}
  append(...els: FakeNode[]): void {
    this.children.push(...els);
  }
  appendChild(el: FakeNode): FakeNode {
    this.children.push(el);
    return el;
  }
}

let images: Array<{ onload: (() => void) | null; naturalWidth: number; naturalHeight: number }> = [];
class FakeImage {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  crossOrigin = "";
  naturalWidth = 8;
  naturalHeight = 8;
  src = "";
  constructor() {
    images.push(this);
  }
}

function fullEls(): { els: BlockArtEls; stats: { textContent: string }; palette: EventTarget & { value: string } } {
  const stats = { textContent: "" };
  const palette = Object.assign(new EventTarget(), { value: "map" });
  const canvasEl = (): unknown => Object.assign(new EventTarget(), fakeCanvas());
  const els = {
    file: new EventTarget() as unknown as HTMLInputElement,
    grid: Object.assign(new EventTarget(), { value: "32" }) as unknown as HTMLInputElement,
    gridVal: { textContent: "" } as unknown as HTMLElement,
    dither: Object.assign(new EventTarget(), { value: "floyd-steinberg" }) as unknown as HTMLSelectElement,
    stats: stats as unknown as HTMLElement,
    src: canvasEl() as HTMLCanvasElement,
    out: canvasEl() as HTMLCanvasElement,
    bom: new FakeNode("ul") as unknown as HTMLElement,
    tooltip: { style: {} } as unknown as HTMLElement,
    palette: palette as unknown as HTMLSelectElement,
  };
  return { els, stats, palette };
}

describe("palette select (map vs solid-block gamut)", () => {
  beforeEach(() => {
    images = [];
    vi.stubGlobal("Image", FakeImage);
    // srcW/srcH discriminate Source via `instanceof HTMLImageElement` - point it at the fake
    vi.stubGlobal("HTMLImageElement", FakeImage);
    vi.stubGlobal("document", {
      createElement: (tag: string) => (tag === "canvas" ? fakeCanvas() : new FakeNode(tag)),
    });
  });
  afterEach(async () => {
    // let the async loadTextureManifest().then(render) settle while the stubs are still up
    await new Promise((r) => setTimeout(r, 0));
    vi.unstubAllGlobals();
  });

  it("prepared palettes differ: map has 244 entries, block is the smaller placeable gamut", () => {
    const map = paletteForChoice("map");
    const block = paletteForChoice("block");
    expect(map.entries.length).toBe(244);
    expect(block.entries.length).toBeGreaterThan(0);
    expect(block.entries.length).toBeLessThan(map.entries.length);
    // EVERY solid-palette entry resolves to a real placeable block - that is the point of it
    for (const e of block.entries) {
      expect(resolveBlock(e.color.mapColorId), `mapColorId ${e.color.mapColorId}`).not.toBe("minecraft:air");
    }
    // memoized: same prepared object on repeat calls (not per-render work)
    expect(paletteForChoice("block")).toBe(block);
  });

  it("onRender fires per (re)quantize - the hook both pages' export buttons ride on", () => {
    const { els, palette } = fullEls();
    const rendered: Array<{ w: number; h: number }> = [];
    const art = createBlockArt(els, { onRender: (q) => rendered.push({ w: q.width, h: q.height }) });
    art.loadUrl("/test-assets/pixelart.png");
    images.at(-1)!.onload!();
    expect(rendered.length).toBe(1);
    expect(rendered[0]!.w).toBeGreaterThan(0);
    palette.value = "block";
    palette.dispatchEvent(new Event("change")); // a palette switch re-renders → re-fires the hook
    expect(rendered.length).toBe(2);
  });

  it("changing the select re-quantizes against the chosen palette (block ⇒ zero air-resolving cells)", () => {
    const { els, stats, palette } = fullEls();
    const art = createBlockArt(els);
    art.loadUrl("/test-assets/pixelart.png");
    images.at(-1)!.onload!(); // render with the default map palette
    const mapFrame = art.getFrame();
    expect(mapFrame).not.toBeNull();
    const mapStats = stats.textContent;
    expect(mapStats).toContain("blocks");

    palette.value = "block";
    palette.dispatchEvent(new Event("change")); // wired handler must re-render
    const blockFrame = art.getFrame();
    expect(blockFrame).not.toBe(mapFrame); // a NEW quantization happened
    // every cell of the solid-palette frame resolves to a placeable block (never air)
    const solidIds = new Set(paletteForChoice("block").entries.map((e) => e.color.mapColorId));
    for (let p = 0; p < blockFrame!.mapColorId.length; p++) {
      expect(solidIds.has(blockFrame!.mapColorId[p]!), `cell ${p}`).toBe(true);
    }
    // and the stats line was rewritten for the new quantization
    expect(stats.textContent).toContain("blocks");
  });
});

// --- goal 089 D13: exports on the standalone page + §02 palette select ----------------------

describe("blockart.html exports (goal 089 D13)", () => {
  const main = read("../src/main.ts");
  const html = read("../blockart.html");

  it("blockart.html ships both export buttons disabled + an export status line", () => {
    expect(html).toMatch(/id="download"[^>]*disabled/);
    expect(html).toMatch(/id="png"[^>]*disabled/);
    expect(html).toContain('id="export"');
  });

  it("main.ts enables them together in onRender (previously never passed) via shared helpers", () => {
    expect(main).toContain("onRender: (q) => {");
    expect(main).toContain('$<HTMLButtonElement>("download").disabled = false');
    expect(main).toContain('$<HTMLButtonElement>("png").disabled = false');
    expect(main).toContain("blockArtExportText(q.width, q.height, ba.getFrameCount())");
  });

  it("the datapack handler re-quantizes via the page-agnostic quantizeForDatapack + zips via downloadDatapack", () => {
    expect(main).toContain("quantizeForDatapack(rgb,");
    expect(main).toContain("generateJavaDatapack([q], resolveBlock,");
    expect(main).toContain('downloadDatapack("blockdream-blockart-datapack", pack.files)');
  });

  it("the PNG handler uses the raster pipeline + honest reportPngDownload status", () => {
    expect(main).toContain("upscaleNearest(quantizedToRaster(q), fitScale(q.width, q.height, 512))");
    expect(main).toContain("reportPngDownload(");
    expect(main).toContain('downloadPng("blockdream-blockart.png", raster)');
  });

  it("both pages' datapack status lines state which palette the pack builds with", () => {
    expect(DATAPACK_PALETTE_NOTE).toContain("solid-block palette");
    expect(main).toContain("${DATAPACK_PALETTE_NOTE} · load /function blockdream:setup");
    const showcase = read("../src/showcase.ts");
    expect(showcase).toContain("${DATAPACK_PALETTE_NOTE} · load /function blockdream:setup");
  });
});

describe("index §02 palette select (goal 089 D13)", () => {
  it("index.html has the ba-palette select with both palette options", () => {
    const index = read("../index.html");
    expect(index).toContain('id="ba-palette"');
    expect(index).toMatch(/id="ba-palette"[\s\S]{0,120}<option value="map">/);
    expect(index).toMatch(/id="ba-palette"[\s\S]{0,220}<option value="block">/);
  });

  it("the showcase passes the select into createBlockArt (no longer pinned to map)", () => {
    const showcase = read("../src/showcase.ts");
    expect(showcase).toContain('palette: $<HTMLSelectElement>("ba-palette")');
  });
});
