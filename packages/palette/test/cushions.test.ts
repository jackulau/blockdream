import { describe, it, expect } from "vitest";
import {
  CUSHION_COLORS,
  CUSHION_SNAPSHOT,
  CUSHION_MOSAIC_MAX_ENTITIES,
  nearestCushion,
  cushionMosaicCommands,
} from "../src/cushions";
import { MC_VERSIONS } from "../src/versions";

// Locks the HONEST cushion facts (docs/cushions-26.3.md): 16 dye colors, entity not block,
// snapshot-only formats, experimental gating, floor mosaic with an entity ceiling.

describe("cushion palette data", () => {
  it("carries exactly the 16 documented dye colors with matching item ids", () => {
    expect(CUSHION_COLORS.length).toBe(16);
    const names = CUSHION_COLORS.map((c) => c.color);
    expect(new Set(names).size).toBe(16);
    for (const c of CUSHION_COLORS) {
      expect(c.itemId).toBe(`${c.color}_cushion`);
      expect(c.rgb.length).toBe(3);
      for (const v of c.rgb) expect(v).toBeGreaterThanOrEqual(0);
    }
    // the wiki's exact id list, spot-checked at both ends + the underscored ones
    expect(names).toContain("white");
    expect(names).toContain("light_blue");
    expect(names).toContain("light_gray");
    expect(names).toContain("black");
  });

  it("snapshot stamps are the wiki's Snapshot 3 values and the entity id is an ENTITY", () => {
    expect(CUSHION_SNAPSHOT.dataPackFormat).toBe(110);
    expect(CUSHION_SNAPSHOT.resourcePackFormat).toBe(91);
    expect(CUSHION_SNAPSHOT.dataVersion).toBe(5001);
    expect(CUSHION_SNAPSHOT.entityId).toBe("minecraft:cushion");
  });

  it("stays OUT of the release version registry (release-only policy)", () => {
    expect(MC_VERSIONS.some((m) => m.id.includes("26.3"))).toBe(false);
    expect(MC_VERSIONS.some((m) => m.dataVersion === CUSHION_SNAPSHOT.dataVersion)).toBe(false);
  });

  it("nearestCushion maps primaries sensibly", () => {
    expect(CUSHION_COLORS[nearestCushion(255, 255, 255)]!.color).toBe("white");
    expect(CUSHION_COLORS[nearestCushion(0, 0, 0)]!.color).toBe("black");
    expect(CUSHION_COLORS[nearestCushion(180, 40, 40)]!.color).toBe("red");
    expect(CUSHION_COLORS[nearestCushion(50, 60, 180)]!.color).toBe("blue");
  });
});

describe("cushionMosaicCommands (experimental floor mosaic)", () => {
  const rgb = (w: number, h: number, fill: [number, number, number]) => {
    const data = new Uint8Array(w * h * 3);
    for (let i = 0; i < w * h; i++) data.set(fill, i * 3);
    return { width: w, height: h, data };
  };

  it("REFUSES without the explicit experimental opt-in", () => {
    expect(() => cushionMosaicCommands(rgb(2, 2, [255, 0, 0]), { experimental: false })).toThrow(/EXPERIMENTAL/i);
  });

  it("emits one summon per pixel, flat on the floor, with the color as entity data", () => {
    const m = cushionMosaicCommands(rgb(3, 2, [176, 46, 38]), { experimental: true, origin: { x: 10, y: 63, z: -5 } });
    expect(m.entityCount).toBe(6);
    expect(m.truncated).toBe(false);
    const summons = m.commands.split("\n").filter((l) => l.startsWith("summon"));
    expect(summons.length).toBe(6);
    expect(summons[0]).toBe('summon minecraft:cushion 10.5 64 -4.5 {color:"red"}');
    // all on the SAME y plane (a floor, not a wall)
    for (const s of summons) expect(s).toContain(" 64 ");
  });

  it("header is honest: snapshot-only, entities-not-blocks, untested summon syntax", () => {
    const m = cushionMosaicCommands(rgb(1, 1, [0, 0, 0]), { experimental: true });
    expect(m.commands).toMatch(/SNAPSHOT ONLY/);
    expect(m.commands).toMatch(/ENTITIES/);
    expect(m.commands).toMatch(/untested/i);
    expect(m.commands).toContain("forceload add");
  });

  it("caps entity count and reports truncation", () => {
    const m = cushionMosaicCommands(rgb(100, 100, [255, 255, 255]), { experimental: true, maxEntities: 50 });
    expect(m.entityCount).toBe(50);
    expect(m.truncated).toBe(true);
    expect(m.commands).toMatch(/TRUNCATED at 50/);
    expect(CUSHION_MOSAIC_MAX_ENTITIES).toBeGreaterThan(0);
  });

  it("rejects malformed images", () => {
    expect(() => cushionMosaicCommands({ width: 0, height: 2, data: new Uint8Array(0) }, { experimental: true })).toThrow(/bad RGB/);
    expect(() =>
      cushionMosaicCommands({ width: 4, height: 4, data: new Uint8Array(3) }, { experimental: true }),
    ).toThrow(/bad RGB/);
  });
});
