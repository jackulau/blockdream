import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_MODEL_MAP_COLOR_ID } from "@blockdream/voxel";
import { makeBlockResolver } from "@blockdream/emit-commands";
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

// goal 088 D1: the SHIPPED sample model (apps/web/public/test-assets/cube.obj) has NO vertex
// colours, so the voxelizers' fallback mapColorId fills every voxel. That fallback used to be 0 -
// the AIR sentinel (emit-commands AIR_MAP_COLOR_ID) - so rendering the shipped sample exited 0 and
// emitted a datapack whose ONLY command was a `fill ... air` (Bedrock: palette ['minecraft:air']).
// Locked here on the real file, both editions.
const SHIPPED_CUBE_OBJ = join(
  dirname(fileURLToPath(import.meta.url)), // file-relative, never CWD-relative (goal 061 lesson)
  "..", "..", "..", "apps", "web", "public", "test-assets", "cube.obj",
);

describe("model3d on the shipped colorless cube.obj places real blocks, never an air-only pack (D1)", () => {
  const defaultBlock = makeBlockResolver()(DEFAULT_MODEL_MAP_COLOR_ID);

  it("the default model map colour resolves to a real placeable block", () => {
    expect(defaultBlock).not.toBe("minecraft:air");
    expect(defaultBlock).toMatch(/^minecraft:[a-z_]+$/);
  });

  it("Java datapack: frames place the default block, not only air", () => {
    const out = join(dir, "shipped-java");
    const res = render({ input: SHIPPED_CUBE_OBJ, out, target: "model3d", width: 8, height: 8 });
    const fnFile = res.filesWritten.find((f) => f.endsWith(".mcfunction") && /frames/.test(f))!;
    const body = readFileSync(fnFile, "utf8");
    // real placement commands that place a NON-air block
    const realPlacements = (body.match(/^(?:setblock|fill) .*/gm) ?? []).filter(
      (line) => !line.includes("minecraft:air"),
    );
    expect(realPlacements.length).toBeGreaterThan(0);
    expect(body).toContain(defaultBlock);
  });

  it("Bedrock .mcstructure: the palette contains a non-air block", () => {
    const out = join(dir, "shipped-bedrock");
    const res = render({ input: SHIPPED_CUBE_OBJ, out, target: "model3d", edition: "bedrock", width: 8, height: 8 });
    const structPath = res.filesWritten.find((f) => f.endsWith(".mcstructure"))!;
    const buf = readFileSync(structPath);
    expect(buf.includes(defaultBlock)).toBe(true);
  });
});
