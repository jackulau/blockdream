import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { PreparedPalette, QuantizedFrame } from "@blockdream/color-core";
import { paintQuantized, paletteForChoice, createBomRenderer } from "../src/blockart-core";

// §02 pixel-loop perf (goal 088 D18) - visual output unchanged. The render loop used to do a
// two-level `pal.entries[idx]!.color` deref plus counts-Map get/set PER PIXEL, per animated-GIF
// frame, on the rAF thread. paintQuantized reads flat per-palette typed arrays and materializes
// the counts Map after the loop in first-seen order. Locked here:
//  1. RGBA bytes are IDENTICAL to the retained verbatim reference loop,
//  2. the counts Map has identical entries in the identical (first-seen) insertion order,
//  3. BOM markup rendered from both Maps is byte-identical (stable sort ties break by insertion),
//  4. the stats-line ingredient (counts.size) matches,
//  5. same-run interleaved A/B: the optimized loop beats the reference.

/** The OLD render loop, kept VERBATIM (deref + per-pixel Map ops) - the byte-identity reference. */
function paintReference(q: QuantizedFrame, pal: PreparedPalette, out: Uint8ClampedArray): Map<number, number> {
  const counts = new Map<number, number>();
  for (let p = 0; p < q.width * q.height; p++) {
    const c = pal.entries[q.paletteIndex[p]!]!.color;
    const o = p * 4;
    out[o] = c.r;
    out[o + 1] = c.g;
    out[o + 2] = c.b;
    out[o + 3] = 255;
    counts.set(c.baseId, (counts.get(c.baseId) ?? 0) + 1);
  }
  return counts;
}

/** Deterministic "animated clip": varied per-frame palette indices, mixing runs (block-art-like)
 *  with noise, over the REAL prepared palette's full entry range. */
function clipFrames(pal: PreparedPalette, frames: number, w: number, h: number): QuantizedFrame[] {
  let seed = 0xc0ffee;
  const rand = (): number => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed;
  };
  const out: QuantizedFrame[] = [];
  for (let f = 0; f < frames; f++) {
    const paletteIndex = new Int32Array(w * h);
    const mapColorId = new Uint8Array(w * h);
    for (let p = 0; p < w * h; p++) {
      const roll = rand() % 100;
      const i = roll < 60 ? ((((p / w) | 0) + f * 7) % pal.entries.length) : rand() % pal.entries.length;
      paletteIndex[p] = i;
      mapColorId[p] = pal.entries[i]!.color.mapColorId & 0xff;
    }
    out.push({ width: w, height: h, paletteIndex, mapColorId });
  }
  return out;
}

// minimal DOM fakes so createBomRenderer output can be serialized + compared (bom-render.test.ts style)
class FakeNode {
  children: FakeNode[] = [];
  className = "";
  alt = "";
  src = "";
  onerror: unknown = null;
  private html = "";
  constructor(public tag: string) {}
  set innerHTML(v: string) {
    this.html = v;
    this.children = [];
  }
  get innerHTML(): string {
    return this.children.length ? this.children.map(serialize).join("") : this.html;
  }
  append(...els: FakeNode[]): void {
    for (const e of els) this.appendChild(e);
  }
  appendChild(el: FakeNode): FakeNode {
    const i = this.children.indexOf(el);
    if (i >= 0) this.children.splice(i, 1);
    this.children.push(el);
    return el;
  }
}
function serialize(n: FakeNode): string {
  const attrs = [
    n.className ? ` class="${n.className}"` : "",
    n.alt ? ` alt="${n.alt}"` : "",
    n.src ? ` src="${n.src}"` : "",
  ].join("");
  return `<${n.tag}${attrs}>${n.innerHTML}</${n.tag}>`;
}
function fakeCanvas(): unknown {
  return {
    width: 0,
    height: 0,
    getContext: () => ({
      createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }),
      putImageData: () => {},
    }),
    toDataURL: () => "data:image/png;base64,swatch",
  };
}

describe("paintQuantized vs retained reference (byte-identical)", () => {
  beforeEach(() => {
    vi.stubGlobal("document", { createElement: (tag: string) => (tag === "canvas" ? fakeCanvas() : new FakeNode(tag)) });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("RGBA bytes, counts order, BOM markup, and the stats count all match across animated frames", () => {
    const pal = paletteForChoice("map");
    const frames = clipFrames(pal, 6, 96, 72);
    const bomOpt = new FakeNode("ul");
    const bomRef = new FakeNode("ul");
    const renderOpt = createBomRenderer(bomOpt as unknown as HTMLElement);
    const renderRef = createBomRenderer(bomRef as unknown as HTMLElement);
    for (const [f, q] of frames.entries()) {
      const outOpt = new Uint8ClampedArray(q.width * q.height * 4);
      const outRef = new Uint8ClampedArray(q.width * q.height * 4);
      const countsOpt = paintQuantized(q, pal, outOpt);
      const countsRef = paintReference(q, pal, outRef);
      // 1. identical pixels
      expect(Buffer.compare(Buffer.from(outOpt.buffer), Buffer.from(outRef.buffer)), `frame ${f} RGBA`).toBe(0);
      // 2. identical Map entries in identical first-seen insertion order
      expect([...countsOpt.entries()], `frame ${f} counts`).toEqual([...countsRef.entries()]);
      // 4. stats-line ingredient
      expect(countsOpt.size).toBe(countsRef.size);
      // 3. byte-identical BOM markup through the SAME renderer contract
      renderOpt(countsOpt, q.width * q.height);
      renderRef(countsRef, q.width * q.height);
      expect(bomOpt.innerHTML, `frame ${f} BOM`).toBe(bomRef.innerHTML);
    }
  });

  it("also byte-identical on the solid-block palette (the tester's second palette)", () => {
    const pal = paletteForChoice("block");
    const q = clipFrames(pal, 1, 64, 64)[0]!;
    const outOpt = new Uint8ClampedArray(q.width * q.height * 4);
    const outRef = new Uint8ClampedArray(q.width * q.height * 4);
    const a = paintQuantized(q, pal, outOpt);
    const b = paintReference(q, pal, outRef);
    expect(Buffer.compare(Buffer.from(outOpt.buffer), Buffer.from(outRef.buffer))).toBe(0);
    expect([...a.entries()]).toEqual([...b.entries()]);
  });

  it("optimized paint beats the reference (same-run interleaved A/B, min of rounds)", { timeout: 60000, retry: 2 }, () => {
    const pal = paletteForChoice("map");
    const frames = clipFrames(pal, 8, 256, 256); // §02's max grid on a big animated GIF
    const out = new Uint8ClampedArray(256 * 256 * 4);
    // warm both paths (JIT + the flat-palette memo build)
    for (const q of frames) {
      paintReference(q, pal, out);
      paintQuantized(q, pal, out);
    }
    let refMs = Infinity;
    let optMs = Infinity;
    for (let round = 0; round < 9; round++) {
      let t = performance.now();
      for (const q of frames) paintReference(q, pal, out);
      refMs = Math.min(refMs, performance.now() - t);
      t = performance.now();
      for (const q of frames) paintQuantized(q, pal, out);
      optMs = Math.min(optMs, performance.now() - t);
    }
    const speedup = refMs / optMs;
    console.log(
      `paintQuantized A/B (min of 9 rounds, 8×256×256 px): reference ${refMs.toFixed(2)} ms, optimized ${optMs.toFixed(2)} ms, speedup ${speedup.toFixed(2)}x`,
    );
    expect(speedup, `optimized must beat the reference (measured ${speedup.toFixed(2)}x)`).toBeGreaterThan(1.15);
  });
});
