import { describe, it, expect } from "vitest";
import { gltfToFrames, objSequenceToFrames, parseGlb, glbToFrames } from "../src/gltf";
import { forEachSolid, countSolid, type VoxelVolume } from "../src/volume";

// Build a tiny glTF: one triangle whose node TRANSLATES from x=0 to x=+10 over 1 second.
// Non-indexed (sequential triangle), embedded base64 buffer. Returns the JSON + the raw buffer.
function buildAnimatedGltf(): { json: object; buffer: ArrayBuffer } {
  const positions = new Float32Array([0, 0, 0, 4, 0, 0, 2, 4, 2]); // 1 triangle
  const times = new Float32Array([0, 1]);
  const translations = new Float32Array([0, 0, 0, 10, 0, 0]); // node moves +10 on X
  const total = positions.byteLength + times.byteLength + translations.byteLength;
  const buf = new Uint8Array(total);
  buf.set(new Uint8Array(positions.buffer), 0);
  buf.set(new Uint8Array(times.buffer), positions.byteLength);
  buf.set(new Uint8Array(translations.buffer), positions.byteLength + times.byteLength);
  const b64 = Buffer.from(buf).toString("base64");
  const json = {
    asset: { version: "2.0" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, translation: [0, 0, 0] }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    buffers: [{ uri: `data:application/octet-stream;base64,${b64}`, byteLength: total }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: positions.byteLength },
      { buffer: 0, byteOffset: positions.byteLength, byteLength: times.byteLength },
      { buffer: 0, byteOffset: positions.byteLength + times.byteLength, byteLength: translations.byteLength },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: "VEC3" },
      { bufferView: 1, componentType: 5126, count: 2, type: "SCALAR" },
      { bufferView: 2, componentType: 5126, count: 2, type: "VEC3" },
    ],
    animations: [
      { channels: [{ sampler: 0, target: { node: 0, path: "translation" } }], samplers: [{ input: 1, output: 2 }] },
    ],
  };
  return { json, buffer: buf.buffer };
}

function centroidX(v: VoxelVolume): number {
  let sum = 0;
  let n = 0;
  forEachSolid(v, (x) => {
    sum += x;
    n++;
  });
  return n ? sum / n : 0;
}

describe("gltfToFrames", () => {
  it("samples a node-translation animation into frames where the model MOVES", () => {
    const { json } = buildAnimatedGltf();
    const frames = gltfToFrames(json, { frames: 6, resolution: 24, solid: false });
    expect(frames.length).toBe(6);
    frames.forEach((f) => expect(countSolid(f)).toBeGreaterThan(0));
    // shared world box → the object slides in +X across the sequence
    expect(centroidX(frames[5]!)).toBeGreaterThan(centroidX(frames[0]!) + 2);
    // all frames share the same grid (temporal coherence - not re-fit per frame)
    expect(frames.every((f) => f.sx === frames[0]!.sx && f.sz === frames[0]!.sz)).toBe(true);
  });

  it("accepts a JSON string and yields a single frame for a static model", () => {
    const { json } = buildAnimatedGltf();
    const stat = JSON.parse(JSON.stringify(json));
    delete stat.animations; // static → 1 frame
    const frames = gltfToFrames(JSON.stringify(stat), { frames: 8, resolution: 16 });
    expect(frames.length).toBe(1);
  });

  it("rejects a glTF with no meshes", () => {
    expect(() => gltfToFrames({ nodes: [{}] } as object)).toThrow();
  });
});

describe("objSequenceToFrames", () => {
  it("voxelizes an .obj-per-frame sequence into a shared world box, preserving motion", () => {
    // a quad that shifts +X by 6 between the two frames (like a Blender OBJ animation export)
    const quad = (dx: number) =>
      `v ${dx} 0 0\nv ${dx + 3} 0 0\nv ${dx + 3} 3 0\nv ${dx} 3 0\nf 1 2 3\nf 1 3 4\n`;
    const frames = objSequenceToFrames([quad(0), quad(6)], { resolution: 24, solid: false });
    expect(frames.length).toBe(2);
    expect(frames[0]!.sx).toBe(frames[1]!.sx); // shared grid
    expect(centroidX(frames[1]!)).toBeGreaterThan(centroidX(frames[0]!) + 2);
  });

  it("rejects an empty sequence", () => {
    expect(() => objSequenceToFrames([])).toThrow();
  });
});

describe("parseGlb / glbToFrames", () => {
  it("round-trips a .glb container (JSON + BIN) and animates it", () => {
    // build a .glb from the same data but with the buffer as a BIN chunk (no uri)
    const positions = new Float32Array([0, 0, 0, 4, 0, 0, 2, 4, 2]);
    const times = new Float32Array([0, 1]);
    const translations = new Float32Array([0, 0, 0, 10, 0, 0]);
    const binLen = positions.byteLength + times.byteLength + translations.byteLength;
    const bin = new Uint8Array(binLen);
    bin.set(new Uint8Array(positions.buffer), 0);
    bin.set(new Uint8Array(times.buffer), positions.byteLength);
    bin.set(new Uint8Array(translations.buffer), positions.byteLength + times.byteLength);
    const json = {
      asset: { version: "2.0" },
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [{ mesh: 0 }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
      buffers: [{ byteLength: binLen }], // no uri → BIN chunk
      bufferViews: [
        { buffer: 0, byteOffset: 0, byteLength: positions.byteLength },
        { buffer: 0, byteOffset: positions.byteLength, byteLength: times.byteLength },
        { buffer: 0, byteOffset: positions.byteLength + times.byteLength, byteLength: translations.byteLength },
      ],
      accessors: [
        { bufferView: 0, componentType: 5126, count: 3, type: "VEC3" },
        { bufferView: 1, componentType: 5126, count: 2, type: "SCALAR" },
        { bufferView: 2, componentType: 5126, count: 2, type: "VEC3" },
      ],
      animations: [
        { channels: [{ sampler: 0, target: { node: 0, path: "translation" } }], samplers: [{ input: 1, output: 2 }] },
      ],
    };
    const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
    const pad = (n: number) => (4 - (n % 4)) % 4;
    const jChunk = jsonBytes.byteLength + pad(jsonBytes.byteLength);
    const bChunk = bin.byteLength + pad(bin.byteLength);
    const totalLen = 12 + 8 + jChunk + 8 + bChunk;
    const out = new Uint8Array(totalLen);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, 0x46546c67, true); // magic glTF
    dv.setUint32(4, 2, true);
    dv.setUint32(8, totalLen, true);
    let o = 12;
    dv.setUint32(o, jChunk, true);
    dv.setUint32(o + 4, 0x4e4f534a, true); // JSON
    out.set(jsonBytes, o + 8);
    for (let i = 0; i < pad(jsonBytes.byteLength); i++) out[o + 8 + jsonBytes.byteLength + i] = 0x20; // space pad
    o += 8 + jChunk;
    dv.setUint32(o, bChunk, true);
    dv.setUint32(o + 4, 0x004e4942, true); // BIN
    out.set(bin, o + 8);

    const parsed = parseGlb(out.buffer);
    expect(parsed.json.meshes?.length).toBe(1);
    expect(parsed.bin).toBeDefined();
    const frames = glbToFrames(out.buffer, { frames: 4, resolution: 20, solid: false });
    expect(frames.length).toBe(4);
    expect(centroidX(frames[3]!)).toBeGreaterThan(centroidX(frames[0]!) + 1);
  });
});
