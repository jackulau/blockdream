import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { actionFromKeys, N_BUTTONS } from "../src/action";

// canonical list - mirrors ml/src/blockdream_wm/movement.py MOVEMENT_TYPES (same order)
const MOVEMENT_TYPES = [
  "general", "walk", "sprint", "jump", "swim", "boat", "elytra", "pig", "minecart",
];

describe("world-model key → action mapping", () => {
  it("maps WASD to the movement buttons", () => {
    expect(actionFromKeys(new Set(["w"])).buttons[0]).toBe(1);
    expect(actionFromKeys(new Set(["a"])).buttons[2]).toBe(1);
    expect(actionFromKeys(new Set(["d"])).buttons[3]).toBe(1);
    expect(actionFromKeys(new Set([" "])).buttons[4]).toBe(1);
    expect(actionFromKeys(new Set(["shift"])).buttons[5]).toBe(1);
  });

  it("maps arrow keys to camera axes", () => {
    expect(actionFromKeys(new Set(["arrowright"])).camera).toEqual([0.5, 0]);
    expect(actionFromKeys(new Set(["arrowleft"])).camera).toEqual([-0.5, 0]);
    expect(actionFromKeys(new Set(["arrowup"])).camera).toEqual([0, -0.5]);
    expect(actionFromKeys(new Set(["arrowdown"])).camera[1]).toBe(0.5);
  });

  it("idle keys → all-zero action of the right width", () => {
    const a = actionFromKeys(new Set());
    expect(a.buttons).toHaveLength(N_BUTTONS);
    expect(a.buttons.every((v) => v === 0)).toBe(true);
    expect(a.camera).toEqual([0, 0]);
  });

  it("combines movement + camera", () => {
    const a = actionFromKeys(new Set(["w", "arrowright"]));
    expect(a.buttons[0]).toBe(1);
    expect(a.camera).toEqual([0.5, 0]);
  });
});

// world-model.ts touches the DOM at import time, so these are source-text checks
// (same source-only style as checks.test.ts).
describe("all 9 movement types are selectable", () => {
  it("standalone tester DEMO_SKILL maps every movement type", () => {
    const src = readFileSync(new URL("../src/world-model.ts", import.meta.url), "utf8");
    const map = src.match(/const DEMO_SKILL[^;]*;/)?.[0] ?? "";
    for (const m of MOVEMENT_TYPES) expect(map).toContain(`${m}: "${m}"`);
  });

  it("showcase movement dropdown lists every movement type", () => {
    const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
    for (const m of MOVEMENT_TYPES) expect(html).toContain(`<option value="${m}"`);
  });
});
