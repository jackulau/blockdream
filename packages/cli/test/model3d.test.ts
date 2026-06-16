import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { render } from "../src/render";

// goal 036 D1: a real 3D model (.obj/.gltf/.glb) must be reachable from the CLI render path, with its
// colours matched to the solid palette. Previously objToVolume/gltfToFrames + matchColor were dead code.

// a tiny 2-colour cube .obj (vertex colours: v x y z r g b) so matchColor is exercised
const CUBE_OBJ = `
v 0 0 0 0.8 0.1 0.1
v 1 0 0 0.8 0.1 0.1
v 1 1 0 0.1 0.1 0.8
v 0 1 0 0.1 0.1 0.8
v 0 0 1 0.8 0.1 0.1
v 1 0 1 0.8 0.1 0.1
v 1 1 1 0.1 0.1 0.8
v 0 1 1 0.1 0.1 0.8
f 1 2 3
f 1 3 4
f 5 6 7
f 5 7 8
f 1 5 8
f 1 8 4
f 2 6 7
f 2 7 3
f 4 3 7
f 4 7 8
f 1 2 6
f 1 6 5
`;

const dir = mkdtempSync(join(tmpdir(), "bd-model3d-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("model3d CLI target (D1)", () => {
  it("voxelizes an .obj into a vanilla datapack with placed blocks", () => {
    const objPath = join(dir, "cube.obj");
    writeFileSync(objPath, CUBE_OBJ);
    const out = join(dir, "java");
    const res = render({ input: objPath, out, target: "model3d", width: 12, height: 12 });
    expect(res.target).toBe("model3d");
    expect(res.filesWritten.length).toBeGreaterThan(0);
    // the frames function must place real blocks (setblock/fill ...), not be empty
    const fnFile = res.filesWritten.find((f) => f.endsWith(".mcfunction") && /frames/.test(f))!;
    const body = readFileSync(fnFile, "utf8");
    const placements = (body.match(/^(setblock|fill) /gm) ?? []).length;
    expect(placements).toBeGreaterThan(0);
    // ≥2 distinct blocks (the two cube colours matched to different palette blocks)
    const blocks = new Set((body.match(/minecraft:[a-z_]+/g) ?? []).filter((b) => b !== "minecraft:air"));
    expect(blocks.size).toBeGreaterThanOrEqual(2);
  });

  it("voxelizes an .obj into a Bedrock .mcstructure", () => {
    const objPath = join(dir, "cube2.obj");
    writeFileSync(objPath, CUBE_OBJ);
    const out = join(dir, "bedrock");
    const res = render({ input: objPath, out, target: "model3d", edition: "bedrock", width: 10, height: 10 });
    expect(res.filesWritten.some((f) => f.endsWith(".mcstructure"))).toBe(true);
    expect(readdirSync(out).length).toBeGreaterThan(0);
  });
});
