import { describe, it, expect } from "vitest";
import { controlFromKeys } from "../src/driveAction";

describe("driving control mapping", () => {
  it("arrows/WASD map to [steer, throttle, brake] (steer>0 = left)", () => {
    expect(controlFromKeys(new Set(["arrowup"]))).toEqual([0, 1, 0]);
    expect(controlFromKeys(new Set(["w"]))).toEqual([0, 1, 0]);
    expect(controlFromKeys(new Set(["arrowdown"]))).toEqual([0, 0, 1]);
    expect(controlFromKeys(new Set(["arrowleft"]))).toEqual([1, 0, 0]);
    expect(controlFromKeys(new Set(["arrowright"]))).toEqual([-1, 0, 0]);
  });

  it("combines and idles", () => {
    expect(controlFromKeys(new Set(["arrowup", "arrowleft"]))).toEqual([1, 1, 0]);
    expect(controlFromKeys(new Set())).toEqual([0, 0, 0]);
    // left + right cancel
    expect(controlFromKeys(new Set(["a", "d"]))).toEqual([0, 0, 0]);
  });
});
