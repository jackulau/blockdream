// Color-matched 3D model imports: COLOR_0 vertex colors and material baseColorFactor must
// drive per-triangle block selection through the supplied matcher, with a ΔE2000 bound when
// the matcher is the real color-core OKLab nearest against the placeable solid-block palette.
import { describe, it, expect } from "vitest";
import { gltfToFrames, objSequenceToFrames } from "../src/gltf";
import { objToVolume, parseObj } from "../src/obj";
import { EMPTY } from "../src/volume";
import { preparePalette, nearestSrgbHue, deltaE2000Srgb } from "@blockdream/color-core";
import { getSolidBlockMapPalette } from "@blockdream/palette/solid";

const SOLID = getSolidBlockMapPalette();
const pal = preparePalette(SOLID.palette);
const match = (r: number, g: number, b: number) => nearestSrgbHue(r, g, b, pal, 0.8).color.mapColorId;
const colorOfId = new Map(pal.entries.map((e) => [e.color.mapColorId, e.color]));

/** Embedded-buffer glTF: two unit quads side by side, one COLOR_0-red, one COLOR_0-blue. */
function twoColorGltf(): string {
  // 8 verts (two quads of 4), positions float32, COLOR_0 float32 vec3
  const pos = new Float32Array([
    0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, // quad A at x 0..1
    3, 0, 0, 4, 0, 0, 4, 1, 0, 3, 1, 0, // quad B at x 3..4
  ]);
  const col = new Float32Array([
    1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, // red
    0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, // blue
  ]);
  const idx = new Uint16Array([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]);
  const buf = new Uint8Array(pos.byteLength + col.byteLength + idx.byteLength);
  buf.set(new Uint8Array(pos.buffer), 0);
  buf.set(new Uint8Array(col.buffer), pos.byteLength);
  buf.set(new Uint8Array(idx.buffer), pos.byteLength + col.byteLength);
  const b64 = Buffer.from(buf).toString("base64");
  return JSON.stringify({
    buffers: [{ uri: `data:application/octet-stream;base64,${b64}`, byteLength: buf.byteLength }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: pos.byteLength },
      { buffer: 0, byteOffset: pos.byteLength, byteLength: col.byteLength },
      { buffer: 0, byteOffset: pos.byteLength + col.byteLength, byteLength: idx.byteLength },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 8, type: "VEC3" },
      { bufferView: 1, componentType: 5126, count: 8, type: "VEC3" },
      { bufferView: 2, componentType: 5123, count: 12, type: "SCALAR" },
    ],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, COLOR_0: 1 }, indices: 2 }] }],
    nodes: [{ mesh: 0 }],
    scenes: [{ nodes: [0] }],
    scene: 0,
  });
}

function idsIn(vol: { data: Uint8Array }): Set<number> {
  const out = new Set<number>();
  for (const c of vol.data) if (c !== EMPTY) out.add(c);
  return out;
}

describe("color-matched 3D model imports", () => {
  it("glTF COLOR_0 vertex colors pick per-region blocks within a ΔE2000 bound", () => {
    const [vol] = gltfToFrames(twoColorGltf(), { resolution: 24, solid: false, mapColorId: 0, matchColor: match });
    const ids = idsIn(vol!);
    expect(ids.size).toBe(2); // red region + blue region, distinct blocks
    // the red quad occupies low-x cells, the blue quad high-x cells
    const redId = match(255, 0, 0);
    const blueId = match(0, 0, 255);
    expect(ids.has(redId)).toBe(true);
    expect(ids.has(blueId)).toBe(true);
    // matched blocks stay perceptually close to the source colors
    const rc = colorOfId.get(redId)!;
    const bc = colorOfId.get(blueId)!;
    expect(deltaE2000Srgb(255, 0, 0, rc.r, rc.g, rc.b)).toBeLessThan(22); // pure primaries are out-of-gamut for blocks
    expect(deltaE2000Srgb(0, 0, 255, bc.r, bc.g, bc.b)).toBeLessThan(28);
  });

  it("material baseColorFactor colors a primitive without vertex colors", () => {
    const g = JSON.parse(twoColorGltf());
    delete g.meshes[0].primitives[0].attributes.COLOR_0;
    g.materials = [{ pbrMetallicRoughness: { baseColorFactor: [0, 0.6, 0, 1] } }];
    g.meshes[0].primitives[0].material = 0;
    const [vol] = gltfToFrames(JSON.stringify(g), { resolution: 24, solid: false, mapColorId: 0, matchColor: match });
    const ids = idsIn(vol!);
    expect(ids.size).toBe(1);
    const id = [...ids][0]!;
    expect(id).toBe(match(0, 153, 0)); // 0.6 × 255
    const c = colorOfId.get(id)!;
    expect(deltaE2000Srgb(0, 153, 0, c.r, c.g, c.b)).toBeLessThan(15);
  });

  it("colorless geometry keeps the fallback mapColorId (gray path unchanged)", () => {
    const g = JSON.parse(twoColorGltf());
    delete g.meshes[0].primitives[0].attributes.COLOR_0;
    const [vol] = gltfToFrames(JSON.stringify(g), { resolution: 24, solid: false, mapColorId: 77, matchColor: match });
    expect([...idsIn(vol!)]).toEqual([77]);
  });

  it(".obj vertex colors (v x y z r g b) are parsed and matched per triangle", () => {
    const obj = [
      "v 0 0 0 1 0 0",
      "v 1 0 0 1 0 0",
      "v 1 1 0 1 0 0",
      "v 3 0 0 0 0 1",
      "v 4 0 0 0 0 1",
      "v 4 1 0 0 0 1",
      "f 1 2 3",
      "f 4 5 6",
    ].join("\n");
    const parsed = parseObj(obj);
    expect(parsed.colors).toBeDefined();
    const vol = objToVolume(obj, { resolution: 24, solid: false, mapColorId: 0, matchColor: match });
    const ids = idsIn(vol);
    expect(ids.has(match(255, 0, 0))).toBe(true);
    expect(ids.has(match(0, 0, 255))).toBe(true);
    // and the sequence importer threads the same colors
    const [seqVol] = objSequenceToFrames([obj], { resolution: 24, mapColorId: 0, solid: false, matchColor: match });
    expect(idsIn(seqVol!)).toEqual(ids);
  });

  it(".obj without colors keeps the legacy single-id behavior", () => {
    const obj = ["v 0 0 0", "v 1 0 0", "v 1 1 0", "f 1 2 3"].join("\n");
    expect(parseObj(obj).colors).toBeUndefined();
    const vol = objToVolume(obj, { resolution: 12, solid: false, mapColorId: 42, matchColor: match });
    expect([...idsIn(vol)]).toEqual([42]);
  });
});
