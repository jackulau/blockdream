// Locks the goal-089 D21 gltfToFrames topology hoist (tris + triColors built once, shared across
// frames; spread-push replaced by a counted loop) against the verbatim pre-optimization reference
// twin: per-frame output volumes byte-identical on a multi-primitive multi-node animated glTF, and
// the >65k-triangle primitive that made the reference throw RangeError (engine argument limit on
// `push(...spread)`) now imports.

import { describe, it, expect } from "vitest";
import { gltfToFrames, gltfToFramesReference } from "../src/gltf";
import { countSolid, forEachSolid, type VoxelVolume } from "../src/volume";

/** Pack typed arrays into one buffer; returns the buffer + per-segment byte offsets/lengths. */
function pack(...segs: Array<Float32Array | Uint16Array | Uint32Array>): {
  buffer: ArrayBuffer;
  views: Array<{ byteOffset: number; byteLength: number }>;
} {
  const total = segs.reduce((s, a) => s + a.byteLength, 0);
  const out = new Uint8Array(total);
  const views: Array<{ byteOffset: number; byteLength: number }> = [];
  let o = 0;
  for (const seg of segs) {
    out.set(new Uint8Array(seg.buffer, seg.byteOffset, seg.byteLength), o);
    views.push({ byteOffset: o, byteLength: seg.byteLength });
    o += seg.byteLength;
  }
  return { buffer: out.buffer, views };
}

/**
 * Multi-primitive, multi-node, ANIMATED fixture exercising every topology branch the hoist covers:
 * - mesh 0 prim 0: indexed quad (2 tris) with a red material factor -> triColors from the factor
 * - mesh 0 prim 1: non-indexed triangle, NO material and NO COLOR_0 -> null triColors (fallback)
 * - mesh 1 prim 0: non-indexed triangle with a green material factor, on a CHILD node with its own
 *   static translation (parent * child matrix chain)
 * - node 0 translation animated 0 -> +6 X over 1s
 */
function buildFixture(): { json: object; buffers: ArrayBuffer[] } {
  const posA = new Float32Array([0, 0, 0, 2, 0, 0, 2, 2, 0, 0, 2, 0]); // 4 verts (quad)
  const posB = new Float32Array([3, 0, 0, 5, 0, 0, 4, 2, 1]); // 3 verts
  const posC = new Float32Array([0, 0, 2, 1, 0, 2, 0.5, 1, 2]); // 3 verts (child node mesh)
  const times = new Float32Array([0, 1]);
  const trans = new Float32Array([0, 0, 0, 6, 0, 0]);
  const idxA = new Uint16Array([0, 1, 2, 0, 2, 3]); // keep 2-byte-aligned segment LAST
  const { buffer, views } = pack(posA, posB, posC, times, trans, idxA);
  const json = {
    asset: { version: "2.0" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [
      { mesh: 0, children: [1] },
      { mesh: 1, translation: [0, 1, 0] },
    ],
    materials: [
      { pbrMetallicRoughness: { baseColorFactor: [1, 0.2, 0.1, 1] } },
      { pbrMetallicRoughness: { baseColorFactor: [0.1, 0.9, 0.2, 1] } },
    ],
    meshes: [
      {
        primitives: [
          { attributes: { POSITION: 0 }, indices: 1, material: 0 },
          { attributes: { POSITION: 2 } },
        ],
      },
      { primitives: [{ attributes: { POSITION: 3 }, material: 1 }] },
    ],
    buffers: [{ byteLength: buffer.byteLength }], // no uri -> external via opts.buffers
    bufferViews: views.map((v) => ({ buffer: 0, ...v })),
    accessors: [
      { bufferView: 0, componentType: 5126, count: 4, type: "VEC3" },
      { bufferView: 5, componentType: 5123, count: 6, type: "SCALAR" },
      { bufferView: 1, componentType: 5126, count: 3, type: "VEC3" },
      { bufferView: 2, componentType: 5126, count: 3, type: "VEC3" },
      { bufferView: 3, componentType: 5126, count: 2, type: "SCALAR" },
      { bufferView: 4, componentType: 5126, count: 2, type: "VEC3" },
    ],
    animations: [
      { channels: [{ sampler: 0, target: { node: 0, path: "translation" } }], samplers: [{ input: 4, output: 5 }] },
    ],
  };
  return { json, buffers: [buffer] };
}

function expectVolumesByteIdentical(opt: VoxelVolume, ref: VoxelVolume): void {
  expect([opt.sx, opt.sy, opt.sz]).toEqual([ref.sx, ref.sy, ref.sz]);
  expect(Buffer.compare(Buffer.from(opt.data), Buffer.from(ref.data))).toBe(0);
}

function expectFramesIdentical(json: object | string, opts: Parameters<typeof gltfToFrames>[1]): VoxelVolume[] {
  const opt = gltfToFrames(json as never, opts);
  const ref = gltfToFramesReference(json as never, opts);
  expect(opt.length).toBe(ref.length);
  for (let i = 0; i < opt.length; i++) expectVolumesByteIdentical(opt[i]!, ref[i]!);
  return opt;
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

describe("gltfToFrames per-frame volumes are identical to the verbatim reference", () => {
  it("animated multi-primitive multi-node fixture, matchColor driving per-tri blocks", () => {
    const { json, buffers } = buildFixture();
    const frames = expectFramesIdentical(json, {
      frames: 5,
      resolution: 24,
      solid: false,
      buffers,
      matchColor: (r, g) => (r > g ? 30 : 60), // red-factor prims vs green-factor prims
    });
    expect(frames.length).toBe(5);
    frames.forEach((f) => expect(countSolid(f)).toBeGreaterThan(0));
    // the hoist must not freeze the animation: only topology is shared, verts move per frame
    expect(centroidX(frames[4]!)).toBeGreaterThan(centroidX(frames[0]!) + 2);
  });

  it("solid fill and colorless fallback (no matchColor) paths", () => {
    const { json, buffers } = buildFixture();
    expectFramesIdentical(json, { frames: 4, resolution: 16, solid: true, buffers });
    expectFramesIdentical(json, { frames: 3, resolution: 16, solid: false, buffers, mapColorId: 42 });
  });

  it("static model (no animation) -> single frame, identical", () => {
    const { json, buffers } = buildFixture();
    const stat = JSON.parse(JSON.stringify(json)) as { animations?: unknown };
    delete stat.animations;
    const frames = expectFramesIdentical(stat, { frames: 8, resolution: 16, buffers });
    expect(frames.length).toBe(1);
  });
});

describe("large-primitive import ceiling (the spread-push RangeError)", () => {
  // one primitive, 130k indexed triangles, with a material factor so triColors is built: the
  // reference's `triColors.push(...prim.triColors)` passes 130k ARGUMENTS and blows the engine
  // argument limit; the counted loop does not.
  function buildHugeFixture(triCount: number): { json: object; buffers: ArrayBuffer[] } {
    const pos = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]); // 4 verts reused by every tri
    const idx = new Uint32Array(triCount * 3);
    for (let t = 0; t < triCount; t++) {
      idx[t * 3] = t % 4;
      idx[t * 3 + 1] = (t + 1) % 4;
      idx[t * 3 + 2] = (t + 2) % 4;
    }
    const { buffer, views } = pack(pos, idx);
    const json = {
      asset: { version: "2.0" },
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [{ mesh: 0 }],
      materials: [{ pbrMetallicRoughness: { baseColorFactor: [0.8, 0.3, 0.2, 1] } }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1, material: 0 }] }],
      buffers: [{ byteLength: buffer.byteLength }],
      bufferViews: views.map((v) => ({ buffer: 0, ...v })),
      accessors: [
        { bufferView: 0, componentType: 5126, count: 4, type: "VEC3" },
        { bufferView: 1, componentType: 5125, count: triCount * 3, type: "SCALAR" },
      ],
    };
    return { json, buffers: [buffer] };
  }

  it("a >65k-tri primitive now imports (reference throws RangeError)", { timeout: 60000 }, () => {
    const { json, buffers } = buildHugeFixture(130000);
    expect(() => gltfToFramesReference(json as never, { resolution: 4, buffers })).toThrow(RangeError);
    const frames = gltfToFrames(json as never, { resolution: 4, buffers });
    expect(frames.length).toBe(1);
    expect(countSolid(frames[0]!)).toBeGreaterThan(0);
  });

  it("below the limit both paths agree (sanity that the huge fixture is well-formed)", () => {
    const { json, buffers } = buildHugeFixture(1000);
    expectFramesIdentical(json, { resolution: 8, buffers, matchColor: () => 12 });
  });
});
