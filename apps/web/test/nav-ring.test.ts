import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Nav ring + mobile CSS (goal 087 D9), string-level like checks.test.ts. The three standalone
// testers all link back to index.html; index.html must complete the ring by linking OUT to each
// of them, and its HUD/canvas CSS must not force horizontal scroll or squash on narrow phones.

const read = (p: string): string => readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8");
const index = read("../index.html");

describe("nav ring", () => {
  it("index.html links to all three standalone testers (the ring used to be one-way)", () => {
    expect(index).toContain('href="/world-model.html"');
    expect(index).toContain('href="/driving.html"');
    expect(index).toContain('href="/blockart.html"');
  });

  it("every tester still links back home (the other half of the ring)", () => {
    for (const page of ["../world-model.html", "../driving.html", "../blockart.html"]) {
      expect(read(page)).toContain('href="/index.html"');
    }
  });
});

describe("mobile CSS", () => {
  it(".hud wraps long error lines (pre-wrap + overflow-wrap), never bare white-space: pre", () => {
    const hudRule = index.match(/\.hud\s*\{[^}]*\}/)?.[0] ?? "";
    expect(hudRule).toContain("white-space: pre-wrap");
    expect(hudRule).toContain("overflow-wrap: anywhere");
    expect(hudRule).not.toMatch(/white-space:\s*pre\s*[;}]/); // bare pre forces document-wide horizontal scroll
  });

  it("square canvases keep their aspect via aspect-ratio, not a fixed height", () => {
    const mc = index.match(/\.mc-canvas\s*\{[^}]*\}/)?.[0] ?? "";
    expect(mc).toContain("aspect-ratio: 1");
    expect(mc).not.toMatch(/height:\s*\d+px/); // fixed height + max-width:100% squashed it below ~340px viewports
  });
});
