import { describe, it, expect } from "vitest";
import { actionFromKeys, N_BUTTONS } from "../src/action";

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
