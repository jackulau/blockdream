import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createBomRenderer, distinctByteCount } from "../src/blockart-core";
import { blockForBase, swatchDataUrl, localTextureUrl, hasLocalTextures } from "../src/blocks";

// BOM render perf (goal 087 D14) - visual output unchanged. Three claims locked here:
//  1. swatchDataUrl memoizes: the canvas.toDataURL PNG encode runs once per unique block id,
//     not once per BOM row per animated frame.
//  2. distinctByteCount (the 256-flag histogram) == new Set(bytes).size on arbitrary data.
//  3. createBomRenderer's keyed diff produces markup IDENTICAL to the old full innerHTML
//     rebuild for the same inputs, while KEEPING the <li> nodes across same-set renders.
//
// No DOM in this repo's test env, so a minimal element fake serializes both the new renderer's
// and the old rebuild's output through the same code path - equality is therefore meaningful.

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
    if (i >= 0) this.children.splice(i, 1); // a re-appended child MOVES, like the real DOM
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

let toDataUrlCalls = 0;
function fakeCanvas(): unknown {
  return {
    width: 0,
    height: 0,
    getContext: () => ({
      createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }),
      putImageData: () => {},
    }),
    toDataURL: () => {
      toDataUrlCalls++;
      return "data:image/png;base64,swatch";
    },
  };
}

// The OLD renderBom, verbatim behavior (full clear + rebuild every call) - the reference the
// keyed renderer must stay byte-identical to.
function renderBomOld(bomEl: FakeNode, counts: Map<number, number>, total: number): void {
  const rows = [...counts.entries()]
    .map(([baseId, n]) => ({ info: blockForBase(baseId), n }))
    .filter((r): r is { info: NonNullable<ReturnType<typeof blockForBase>>; n: number } => !!r.info)
    .sort((a, b) => b.n - a.n);
  const useTex = hasLocalTextures();
  bomEl.innerHTML = "";
  for (const { info, n } of rows) {
    const li = new FakeNode("li");
    const ic = new FakeNode("img");
    ic.className = "ic";
    ic.alt = info.name;
    const swatch = swatchDataUrl(info);
    const real = useTex ? localTextureUrl(info.id) : null;
    ic.src = real ?? swatch;
    const nm = new FakeNode("div");
    nm.className = "nm";
    nm.innerHTML = `${info.name}<br><small>${info.id}</small>`;
    const ct = new FakeNode("div");
    ct.className = "ct";
    ct.innerHTML = `${n}<small>${((100 * n) / total).toFixed(1)}%</small>`;
    li.append(ic, nm, ct);
    bomEl.appendChild(li);
  }
}

describe("BOM render perf", () => {
  beforeEach(() => {
    vi.stubGlobal("document", { createElement: (tag: string) => (tag === "canvas" ? fakeCanvas() : new FakeNode(tag)) });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("swatchDataUrl encodes each (id, size) once - repeat calls hit the cache", () => {
    const info = blockForBase(1)!;
    const before = toDataUrlCalls;
    const a = swatchDataUrl(info);
    const b = swatchDataUrl(info);
    expect(a).toBe(b);
    expect(toDataUrlCalls - before).toBeLessThanOrEqual(1); // 0 if an earlier test already cached id 1
    const c = swatchDataUrl(info);
    expect(c).toBe(a);
    expect(toDataUrlCalls - before).toBeLessThanOrEqual(1); // and never again
  });

  it("distinctByteCount matches new Set(bytes).size on random data", () => {
    expect(distinctByteCount(new Uint8Array(0))).toBe(0);
    expect(distinctByteCount(new Uint8Array([7, 7, 7]))).toBe(1);
    let seed = 12345;
    const rnd = (): number => ((seed = (Math.imul(seed, 48271) >>> 0) % 2147483647), seed);
    for (const [len, range] of [
      [4096, 256],
      [4096, 5],
      [50, 256],
      [1, 256],
    ] as const) {
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) bytes[i] = rnd() % range;
      expect(distinctByteCount(bytes)).toBe(new Set(bytes).size);
    }
  });

  it("keyed renderer output is IDENTICAL to the old full rebuild across count changes, reorders, and set changes", () => {
    const ids = [1, 2, 3].filter((id) => blockForBase(id));
    expect(ids).toHaveLength(3);
    const bomNew = new FakeNode("ul");
    const bomOld = new FakeNode("ul");
    const render = createBomRenderer(bomNew as unknown as HTMLElement);

    // initial render
    const c1 = new Map([
      [ids[0]!, 50],
      [ids[1]!, 30],
      [ids[2]!, 20],
    ]);
    render(c1, 100);
    renderBomOld(bomOld, c1, 100);
    expect(bomNew.innerHTML).toBe(bomOld.innerHTML);
    const keptLi = bomNew.children[0]!;

    // same set, counts change AND the sort order flips → text + order must match a fresh rebuild
    const c2 = new Map([
      [ids[0]!, 10],
      [ids[1]!, 60],
      [ids[2]!, 30],
    ]);
    render(c2, 100);
    renderBomOld(bomOld, c2, 100);
    expect(bomNew.innerHTML).toBe(bomOld.innerHTML);
    // …but the <li> nodes were KEPT (diffed), not recreated - that's the whole optimization
    expect(bomNew.children).toContain(keptLi);

    // repeated identical render is stable
    render(c2, 100);
    expect(bomNew.innerHTML).toBe(bomOld.innerHTML);

    // block SET changes → full rebuild, still identical to the reference
    const c3 = new Map([
      [ids[1]!, 90],
      [ids[2]!, 10],
    ]);
    render(c3, 100);
    renderBomOld(bomOld, c3, 100);
    expect(bomNew.innerHTML).toBe(bomOld.innerHTML);
    expect(bomNew.children).not.toContain(keptLi); // ids[0] left the set
  });

  it("same-set re-renders never re-encode swatches (no swatchDataUrl work per animated frame)", () => {
    const ids = [4, 5, 6].filter((id) => blockForBase(id));
    expect(ids.length).toBeGreaterThan(0);
    const bom = new FakeNode("ul");
    const render = createBomRenderer(bom as unknown as HTMLElement);
    render(new Map(ids.map((id, i) => [id, 10 + i])), 100);
    const after = toDataUrlCalls;
    for (let f = 0; f < 25; f++) render(new Map(ids.map((id, i) => [id, 10 + ((i + f) % 7)])), 100);
    expect(toDataUrlCalls).toBe(after); // zero encodes across 25 animated frames
  });
});
