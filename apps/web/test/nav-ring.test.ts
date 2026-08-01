import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { MC_VERSIONS } from "@blockdream/palette/versions";
import { JAVA_VERSION_RANGE, loadInstructions } from "../src/datapack-export";

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

// Copy truth (goal 088 D14): the shipped words must track the code. The version range is
// DERIVED from the registry, and every doc that states a range must contain the registry's
// real newest id - a hardcoded "1.21.10" went stale for months while 26.x releases landed.

const maxId = MC_VERSIONS[MC_VERSIONS.length - 1]!.id;

describe("version-range copy is derived from the registry", () => {
  it("JAVA_VERSION_RANGE spans first through newest registry id", () => {
    expect(JAVA_VERSION_RANGE).toBe(`${MC_VERSIONS[0]!.id} through ${maxId}`);
    expect(JAVA_VERSION_RANGE).toContain(maxId);
  });

  it("the bundled HOW_TO_LOAD.txt states the derived range, not a hardcode", () => {
    const text = loadInstructions(new Map([["data/blockdream/function/setup.mcfunction", "# x"]]));
    expect(text).toContain(JAVA_VERSION_RANGE);
    expect(text).not.toContain("1.21 through 1.21.10");
  });

  it("README and guide state the registry's newest version", () => {
    for (const doc of ["../../../README.md", "../../../docs/guide.md"]) {
      const md = read(doc);
      expect(md).toContain(maxId);
      expect(md).not.toContain("1.21 → 1.21.10");
    }
  });

  it("the guide's target table covers rgbscreen and model3d with their real zip names", () => {
    const md = read("../../../docs/guide.md");
    expect(md).toContain("`rgbscreen` | `blockdream_rgb.zip`");
    expect(md).toContain("`model3d` | `blockdream_model.zip`");
    for (const knob of ["--wall", "--led", "--music-engine", "--origin", "--facing"]) {
      expect(md).toContain(knob);
    }
  });
});

describe("world-model tester copy truth", () => {
  it("the movement selector lists all 9 movement types (same set as index.html)", () => {
    const wm = read("../world-model.html");
    for (const t of ["general", "walk", "sprint", "jump", "swim", "boat", "elytra", "pig", "minecart"]) {
      expect(wm).toContain(`<option value="${t}"`);
    }
    expect(wm).not.toContain('<option value="walking"'); // legacy demo names are gone
  });

  it("the engine note admits the browser engine is not wired to this page", () => {
    expect(read("../world-model.html")).toContain("not wired to this page yet");
  });

  it("index.html describes the testers by what they have now (movement selector)", () => {
    expect(index).toContain("server URL + movement selector");
    expect(index).not.toContain("engine controls");
  });
});
