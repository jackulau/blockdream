import { describe, it, expect } from "vitest";
import { joinDashValues } from "../src/argv";

// joinDashValues lets a value starting with '-' (e.g. a NEGATIVE --origin, common Minecraft coords)
// through node's parseArgs, which otherwise throws "Option '--origin' argument is ambiguous". Both the
// offline render CLI (cli.ts) and the live sidecar (rcon-bridge-cli.ts) run it on argv before parsing.

describe("joinDashValues (negative --origin survives node's parseArgs)", () => {
  const BOOL = new Set(["dry-run", "setup", "mock-wm", "flat", "help"]);

  it("rewrites --flag -dashvalue → --flag=-dashvalue (a negative --origin)", () => {
    expect(joinDashValues(["--build", "x.png", "--origin", "-50,70,-50", "--setup"], BOOL)).toEqual([
      "--build",
      "x.png",
      "--origin=-50,70,-50",
      "--setup",
    ]);
  });

  it("works for the render CLI's --target voxel3d --origin -X form too", () => {
    expect(joinDashValues(["img.png", "--target", "voxel3d", "--grid", "16", "--origin", "-10,64,-20"], BOOL)).toEqual([
      "img.png",
      "--target",
      "voxel3d",
      "--grid",
      "16",
      "--origin=-10,64,-20",
    ]);
  });

  it("leaves positive values, boolean flags, and a following --option alone", () => {
    expect(joinDashValues(["--size", "16x16", "--dry-run", "--origin", "10,64,10"], BOOL)).toEqual([
      "--size",
      "16x16",
      "--dry-run",
      "--origin",
      "10,64,10",
    ]);
    expect(joinDashValues(["--setup", "-5"], BOOL)).toEqual(["--setup", "-5"]); // boolean flag gets no value
    expect(joinDashValues(["--flat", "-1"], BOOL)).toEqual(["--flat", "-1"]); // render boolean flag, no value
    expect(joinDashValues(["--origin", "--grid"], BOOL)).toEqual(["--origin", "--grid"]); // --opt is not a value
  });
});
