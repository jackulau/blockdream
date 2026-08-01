// Import a real animated 3D model → a sequence of VoxelVolume frames so Minecraft blocks "follow"
// the animation (e.g. one exported from Blender). Two source formats - both standard Blender
// exports:
//   • glTF 2.0 (.gltf JSON, embedded base64 or caller-supplied buffers): meshes + node TRS
//     animation channels are sampled at N times and baked to world space.
//   • .obj-per-frame sequence: Blender's "Animation" OBJ export writes frame_001.obj, frame_002.obj…
// Every frame is normalized into ONE shared world box (the union of all frames' bounds), so the
// model translates/rotates/deforms in place rather than being re-fit each frame - the key to a
// coherent block animation. Each frame is voxelized solid via the shared trisToVolume rasterizer.

import { parseObj, trisToVolume, meshBounds, unionBounds, DEFAULT_MODEL_MAP_COLOR_ID, type V3, type Tri, type Bounds } from "./obj";
import type { VoxelVolume } from "./volume";

export interface SequenceOptions {
  resolution?: number; // cube grid size (default 32)
  mapColorId?: number; // block colour id (default DEFAULT_MODEL_MAP_COLOR_ID; the fallback for colorless geometry)
  solid?: boolean; // flood-fill interiors (default true for models)
  /** sRGB (0..255) → mapColorId (e.g. color-core OKLab nearest against the placeable palette).
   *  When supplied, COLOR_0 vertex colors and material baseColorFactor drive per-triangle
   *  block selection; colorless geometry keeps the mapColorId fallback. */
  matchColor?: (r: number, g: number, b: number) => number;
}

export interface GltfImportOptions extends SequenceOptions {
  frames?: number; // animation samples (default 24); a static model yields 1 frame
  buffers?: ArrayBuffer[]; // external .bin buffers, indexed like gltf.buffers (when not embedded)
}

/** A frame's world-space geometry. `triColors` (sRGB 0..255, aligned to tris; null = colorless)
 *  comes from COLOR_0 vertex colors × material baseColorFactor. */
interface Mesh {
  verts: V3[];
  tris: Tri[];
  triColors?: Array<V3 | null>;
}

function rasterizeSequence(meshes: Mesh[], opts: SequenceOptions): VoxelVolume[] {
  const bounds: Bounds = unionBounds(meshes.map((m) => meshBounds(m.verts)));
  const solid = opts.solid ?? true;
  const match = opts.matchColor;
  const cache = new Map<number, number>();
  return meshes.map((m) => {
    let colorOf: ((t: number) => number) | undefined;
    if (match && m.triColors) {
      const tc = m.triColors;
      colorOf = (t: number) => {
        const c = tc[t];
        if (!c) return opts.mapColorId ?? DEFAULT_MODEL_MAP_COLOR_ID;
        const key = (Math.round(c[0]) << 16) | (Math.round(c[1]) << 8) | Math.round(c[2]);
        let id = cache.get(key);
        if (id === undefined) cache.set(key, (id = match(c[0], c[1], c[2])));
        return id;
      };
    }
    return trisToVolume(m.verts, m.tris, { resolution: opts.resolution, mapColorId: opts.mapColorId, solid, bounds, colorOf });
  });
}

/** Voxelize an .obj-per-frame sequence into temporally-coherent frames (shared world box). */
export function objSequenceToFrames(objs: string[], opts: SequenceOptions = {}): VoxelVolume[] {
  if (objs.length === 0) throw new Error("empty .obj sequence");
  const meshes: Mesh[] = objs.map((o) => {
    const { verts, tris, colors } = parseObj(o);
    const triColors = colors
      ? tris.map(([ia, ib, ic]): V3 | null => [
          ((colors[ia]![0]! + colors[ib]![0]! + colors[ic]![0]!) / 3) * 255,
          ((colors[ia]![1]! + colors[ib]![1]! + colors[ic]![1]!) / 3) * 255,
          ((colors[ia]![2]! + colors[ib]![2]! + colors[ic]![2]!) / 3) * 255,
        ])
      : undefined;
    return { verts, tris, triColors };
  });
  if (meshes.some((m) => m.verts.length === 0 || m.tris.length === 0)) throw new Error("a frame in the .obj sequence has no geometry");
  return rasterizeSequence(meshes, opts);
}

// ----------------------------- minimal glTF 2.0 reader -------------------------------------------

interface GltfJson {
  buffers?: Array<{ uri?: string; byteLength: number }>;
  bufferViews?: Array<{ buffer: number; byteOffset?: number; byteLength: number; byteStride?: number }>;
  accessors?: Array<{ bufferView?: number; byteOffset?: number; componentType: number; count: number; type: string }>;
  materials?: Array<{ pbrMetallicRoughness?: { baseColorFactor?: number[] } }>;
  meshes?: Array<{ primitives: Array<{ attributes: Record<string, number>; indices?: number; mode?: number; material?: number }> }>;
  nodes?: Array<{ mesh?: number; children?: number[]; matrix?: number[]; translation?: number[]; rotation?: number[]; scale?: number[] }>;
  scenes?: Array<{ nodes: number[] }>;
  scene?: number;
  animations?: Array<{
    channels: Array<{ sampler: number; target: { node?: number; path: string } }>;
    samplers: Array<{ input: number; output: number; interpolation?: string }>;
  }>;
}

const COMP_SIZE: Record<number, number> = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
const TYPE_COUNT: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

function b64ToBytes(b64: string): Uint8Array {
  const bin = typeof atob === "function" ? atob(b64) : Buffer.from(b64, "base64").toString("binary");
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function resolveBuffers(gltf: GltfJson, external?: ArrayBuffer[]): Uint8Array[] {
  return (gltf.buffers ?? []).map((b, i) => {
    if (b.uri) {
      const m = /^data:[^;]*;base64,(.*)$/.exec(b.uri);
      if (m) return b64ToBytes(m[1]!);
      throw new Error(`glTF buffer ${i}: non-embedded URI "${b.uri}"; pass it via opts.buffers`);
    }
    if (external?.[i]) return new Uint8Array(external[i]!);
    throw new Error(`glTF buffer ${i} has no uri and no external buffer supplied`);
  });
}

/** Decode an accessor into a flat Float64 array of `count * numComp` values. */
function readAccessor(gltf: GltfJson, bufs: Uint8Array[], idx: number): { data: Float64Array; count: number; comps: number } {
  const acc = gltf.accessors![idx]!;
  const comps = TYPE_COUNT[acc.type]!;
  const view = gltf.bufferViews![acc.bufferView!]!;
  const buf = bufs[view.buffer]!;
  const compSize = COMP_SIZE[acc.componentType]!;
  const stride = view.byteStride && view.byteStride > 0 ? view.byteStride : comps * compSize;
  const start = (view.byteOffset ?? 0) + (acc.byteOffset ?? 0);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const out = new Float64Array(acc.count * comps);
  for (let i = 0; i < acc.count; i++) {
    const base = start + i * stride;
    for (let c = 0; c < comps; c++) {
      const off = base + c * compSize;
      let v: number;
      switch (acc.componentType) {
        case 5126: v = dv.getFloat32(off, true); break;
        case 5125: v = dv.getUint32(off, true); break;
        case 5123: v = dv.getUint16(off, true); break;
        case 5121: v = dv.getUint8(off); break;
        case 5122: v = dv.getInt16(off, true); break;
        case 5120: v = dv.getInt8(off); break;
        default: throw new Error(`unsupported componentType ${acc.componentType}`);
      }
      out[i * comps + c] = v;
    }
  }
  return { data: out, count: acc.count, comps };
}

// column-major 4x4 helpers (glTF convention)
type Mat4 = number[];
function identity(): Mat4 {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}
function mul(a: Mat4, b: Mat4): Mat4 {
  const o = new Array(16).fill(0);
  for (let col = 0; col < 4; col++)
    for (let row = 0; row < 4; row++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + row]! * b[col * 4 + k]!;
      o[col * 4 + row] = s;
    }
  return o;
}
function fromTRS(t: number[], q: number[], s: number[]): Mat4 {
  const [x, y, z, w] = q as [number, number, number, number];
  const [sx, sy, sz] = s as [number, number, number];
  const xx = x * x, yy = y * y, zz = z * z, xy = x * y, xz = x * z, yz = y * z, wx = w * x, wy = w * y, wz = w * z;
  return [
    (1 - 2 * (yy + zz)) * sx, 2 * (xy + wz) * sx, 2 * (xz - wy) * sx, 0,
    2 * (xy - wz) * sy, (1 - 2 * (xx + zz)) * sy, 2 * (yz + wx) * sy, 0,
    2 * (xz + wy) * sz, 2 * (yz - wx) * sz, (1 - 2 * (xx + yy)) * sz, 0,
    t[0]!, t[1]!, t[2]!, 1,
  ];
}
function transform(m: Mat4, p: V3): V3 {
  return [
    m[0]! * p[0]! + m[4]! * p[1]! + m[8]! * p[2]! + m[12]!,
    m[1]! * p[0]! + m[5]! * p[1]! + m[9]! * p[2]! + m[13]!,
    m[2]! * p[0]! + m[6]! * p[1]! + m[10]! * p[2]! + m[14]!,
  ];
}

function slerp(a: number[], b: number[], t: number): number[] {
  let dot = a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]! + a[3]! * b[3]!;
  const bb = b.slice();
  if (dot < 0) {
    for (let i = 0; i < 4; i++) bb[i] = -bb[i]!;
    dot = -dot;
  }
  if (dot > 0.9995) {
    const o = a.map((av, i) => av + (bb[i]! - av) * t);
    const n = Math.hypot(o[0]!, o[1]!, o[2]!, o[3]!) || 1;
    return o.map((v) => v / n);
  }
  const th = Math.acos(dot);
  const s = Math.sin(th);
  const wa = Math.sin((1 - t) * th) / s;
  const wb = Math.sin(t * th) / s;
  return a.map((av, i) => av * wa + bb[i]! * wb);
}

/** Sample a sampler track at time ts → a value vector (linear for vec3 / scalar, slerp for quats). */
function sampleTrack(times: Float64Array, values: Float64Array, comps: number, ts: number, isQuat: boolean): number[] {
  const n = times.length;
  if (n === 0) return [];
  if (ts <= times[0]!) return Array.from(values.slice(0, comps));
  if (ts >= times[n - 1]!) return Array.from(values.slice((n - 1) * comps, n * comps));
  let i = 0;
  while (i < n - 1 && times[i + 1]! < ts) i++;
  const t0 = times[i]!, t1 = times[i + 1]!;
  const f = (ts - t0) / (t1 - t0 || 1);
  const a = Array.from(values.slice(i * comps, (i + 1) * comps));
  const b = Array.from(values.slice((i + 1) * comps, (i + 2) * comps));
  return isQuat ? slerp(a, b, f) : a.map((av, k) => av + (b[k]! - av) * f);
}

/** Import a glTF model → a sequence of voxel frames following its node-transform animation. */
export function gltfToFrames(gltf: GltfJson | string, opts: GltfImportOptions = {}): VoxelVolume[] {
  const g: GltfJson = typeof gltf === "string" ? JSON.parse(gltf) : gltf;
  if (!g.meshes?.length || !g.nodes?.length) throw new Error("glTF has no meshes/nodes");
  const bufs = resolveBuffers(g, opts.buffers);

  // per-node animation tracks
  type Track = { times: Float64Array; values: Float64Array; comps: number };
  const anim: Record<number, { translation?: Track; rotation?: Track; scale?: Track }> = {};
  let tMin = Infinity;
  let tMax = -Infinity;
  for (const a of g.animations ?? []) {
    for (const ch of a.channels) {
      const node = ch.target.node;
      if (node === undefined || !["translation", "rotation", "scale"].includes(ch.target.path)) continue;
      const samp = a.samplers[ch.sampler]!;
      const tin = readAccessor(g, bufs, samp.input);
      const tout = readAccessor(g, bufs, samp.output);
      (anim[node] ??= {})[ch.target.path as "translation" | "rotation" | "scale"] = { times: tin.data, values: tout.data, comps: tout.comps };
      tMin = Math.min(tMin, tin.data[0]!);
      tMax = Math.max(tMax, tin.data[tin.count - 1]!);
    }
  }
  const animated = tMax > tMin;
  const frameCount = animated ? Math.max(1, Math.floor(opts.frames ?? 24)) : 1;

  const roots = g.scenes?.[g.scene ?? 0]?.nodes ?? g.nodes.map((_, i) => i);

  // cached per-primitive geometry (positions + indices + per-tri sRGB color), parsed once.
  // Color source: COLOR_0 vertex colors (float / normalized ubyte / normalized ushort, vec3 or
  // vec4) modulated by the material's pbr baseColorFactor; a material-only primitive gets the
  // flat factor color; neither → null (colorless, keeps the gray fallback).
  const meshGeo = g.meshes.map((m) =>
    m.primitives.map((p) => {
      const pos = readAccessor(g, bufs, p.attributes.POSITION!);
      const verts: V3[] = [];
      for (let i = 0; i < pos.count; i++) verts.push([pos.data[i * 3]!, pos.data[i * 3 + 1]!, pos.data[i * 3 + 2]!]);
      let tris: Tri[] = [];
      if (p.indices !== undefined) {
        const idx = readAccessor(g, bufs, p.indices);
        for (let i = 0; i + 2 < idx.count; i += 3) tris.push([idx.data[i]!, idx.data[i + 1]!, idx.data[i + 2]!]);
      } else {
        for (let i = 0; i + 2 < verts.length; i += 3) tris.push([i, i + 1, i + 2]);
      }

      const factor = p.material !== undefined
        ? g.materials?.[p.material]?.pbrMetallicRoughness?.baseColorFactor ?? null
        : null;
      let vertColors: V3[] | null = null;
      const colorAcc = p.attributes.COLOR_0;
      if (colorAcc !== undefined) {
        const acc = g.accessors![colorAcc]!;
        const col = readAccessor(g, bufs, colorAcc);
        const denom = acc.componentType === 5121 ? 255 : acc.componentType === 5123 ? 65535 : 1;
        vertColors = [];
        for (let i = 0; i < col.count; i++) {
          vertColors.push([
            col.data[i * col.comps]! / denom,
            col.data[i * col.comps + 1]! / denom,
            col.data[i * col.comps + 2]! / denom,
          ]);
        }
      }
      let triColors: Array<V3 | null> | undefined;
      if (vertColors || factor) {
        const f: V3 = factor ? [factor[0] ?? 1, factor[1] ?? 1, factor[2] ?? 1] : [1, 1, 1];
        triColors = tris.map(([ia, ib, ic]): V3 => {
          const at = (i: number): V3 => vertColors?.[i] ?? [1, 1, 1];
          const a = at(ia), b = at(ib), c = at(ic);
          return [
            ((a[0]! + b[0]! + c[0]!) / 3) * f[0]! * 255,
            ((a[1]! + b[1]! + c[1]!) / 3) * f[1]! * 255,
            ((a[2]! + b[2]! + c[2]!) / 3) * f[2]! * 255,
          ];
        });
      }
      return { verts, tris, triColors };
    }),
  );

  const localMatrix = (nodeIdx: number, ts: number): Mat4 => {
    const node = g.nodes![nodeIdx]!;
    if (node.matrix) return node.matrix.slice();
    const tr = anim[nodeIdx];
    const t = tr?.translation ? sampleTrack(tr.translation.times, tr.translation.values, 3, ts, false) : node.translation ?? [0, 0, 0];
    const q = tr?.rotation ? sampleTrack(tr.rotation.times, tr.rotation.values, 4, ts, true) : node.rotation ?? [0, 0, 0, 1];
    const s = tr?.scale ? sampleTrack(tr.scale.times, tr.scale.values, 3, ts, false) : node.scale ?? [1, 1, 1];
    return fromTRS(t, q, s);
  };

  // Topology (tris + triColors) is FRAME-INVARIANT: the node traversal below is deterministic and
  // per-primitive vertex counts are constant, so every frame appends the same triangle indices
  // (identical `base` offsets) and the same per-tri colors - only the transformed vertex positions
  // vary with ts. Build the topology ONCE on the first frame and share the arrays across frames
  // (rasterizeSequence/trisToVolume only read them). Rebuilding it per frame was ~frameCount x the
  // allocations for zero information; output volumes are identical (locked against the verbatim
  // {@link gltfToFramesReference} twin in test/gltf-frames.test.ts).
  //
  // Per-tri colors are appended with a counted loop, NOT `push(...spread)`: the spread form passes
  // one ARGUMENT per triangle and throws RangeError past the engine argument limit (~65k-125k), a
  // real import ceiling for a single large primitive.
  const frames: Mesh[] = [];
  let sharedTris: Tri[] | null = null;
  let sharedTriColors: Array<V3 | null> | null = null;
  let sharedHasColor = false;
  for (let f = 0; f < frameCount; f++) {
    const ts = animated ? tMin + ((tMax - tMin) * f) / Math.max(1, frameCount - 1) : 0;
    const verts: V3[] = [];
    const buildTopology = sharedTris === null;
    const tris: Tri[] = buildTopology ? [] : sharedTris!;
    const triColors: Array<V3 | null> = buildTopology ? [] : sharedTriColors!;
    const visit = (nodeIdx: number, parent: Mat4): void => {
      const node = g.nodes![nodeIdx]!;
      const world = mul(parent, localMatrix(nodeIdx, ts));
      if (node.mesh !== undefined) {
        for (const prim of meshGeo[node.mesh]!) {
          const base = verts.length;
          for (const v of prim.verts) verts.push(transform(world, v));
          if (buildTopology) {
            for (const t of prim.tris) tris.push([t[0] + base, t[1] + base, t[2] + base]);
            const pc = prim.triColors;
            if (pc) for (const c of pc) triColors.push(c);
            else for (let i = 0; i < prim.tris.length; i++) triColors.push(null);
          }
        }
      }
      for (const c of node.children ?? []) visit(c, world);
    };
    for (const r of roots) visit(r, identity());
    if (buildTopology) {
      sharedTris = tris;
      sharedTriColors = triColors;
      sharedHasColor = triColors.some((c) => c !== null);
    }
    frames.push({ verts, tris, triColors: sharedHasColor ? triColors : undefined });
  }
  return rasterizeSequence(frames, opts);
}

/**
 * VERBATIM pre-optimization gltfToFrames - the reference twin for the goal-089 D21 topology hoist
 * above (and the pre-fix spread-push, which throws RangeError for primitives past the engine
 * argument limit - a bug the optimized path fixes, so past that size the twins intentionally
 * DIVERGE: reference throws, optimized succeeds). Kept exported (house convention, see
 * trisToVolumeReference in obj.ts) so test/gltf-frames.test.ts can prove per-frame output volumes
 * are identical. Not for production use.
 */
export function gltfToFramesReference(gltf: GltfJson | string, opts: GltfImportOptions = {}): VoxelVolume[] {
  const g: GltfJson = typeof gltf === "string" ? JSON.parse(gltf) : gltf;
  if (!g.meshes?.length || !g.nodes?.length) throw new Error("glTF has no meshes/nodes");
  const bufs = resolveBuffers(g, opts.buffers);

  // per-node animation tracks
  type Track = { times: Float64Array; values: Float64Array; comps: number };
  const anim: Record<number, { translation?: Track; rotation?: Track; scale?: Track }> = {};
  let tMin = Infinity;
  let tMax = -Infinity;
  for (const a of g.animations ?? []) {
    for (const ch of a.channels) {
      const node = ch.target.node;
      if (node === undefined || !["translation", "rotation", "scale"].includes(ch.target.path)) continue;
      const samp = a.samplers[ch.sampler]!;
      const tin = readAccessor(g, bufs, samp.input);
      const tout = readAccessor(g, bufs, samp.output);
      (anim[node] ??= {})[ch.target.path as "translation" | "rotation" | "scale"] = { times: tin.data, values: tout.data, comps: tout.comps };
      tMin = Math.min(tMin, tin.data[0]!);
      tMax = Math.max(tMax, tin.data[tin.count - 1]!);
    }
  }
  const animated = tMax > tMin;
  const frameCount = animated ? Math.max(1, Math.floor(opts.frames ?? 24)) : 1;

  const roots = g.scenes?.[g.scene ?? 0]?.nodes ?? g.nodes.map((_, i) => i);

  const meshGeo = g.meshes.map((m) =>
    m.primitives.map((p) => {
      const pos = readAccessor(g, bufs, p.attributes.POSITION!);
      const verts: V3[] = [];
      for (let i = 0; i < pos.count; i++) verts.push([pos.data[i * 3]!, pos.data[i * 3 + 1]!, pos.data[i * 3 + 2]!]);
      let tris: Tri[] = [];
      if (p.indices !== undefined) {
        const idx = readAccessor(g, bufs, p.indices);
        for (let i = 0; i + 2 < idx.count; i += 3) tris.push([idx.data[i]!, idx.data[i + 1]!, idx.data[i + 2]!]);
      } else {
        for (let i = 0; i + 2 < verts.length; i += 3) tris.push([i, i + 1, i + 2]);
      }

      const factor = p.material !== undefined
        ? g.materials?.[p.material]?.pbrMetallicRoughness?.baseColorFactor ?? null
        : null;
      let vertColors: V3[] | null = null;
      const colorAcc = p.attributes.COLOR_0;
      if (colorAcc !== undefined) {
        const acc = g.accessors![colorAcc]!;
        const col = readAccessor(g, bufs, colorAcc);
        const denom = acc.componentType === 5121 ? 255 : acc.componentType === 5123 ? 65535 : 1;
        vertColors = [];
        for (let i = 0; i < col.count; i++) {
          vertColors.push([
            col.data[i * col.comps]! / denom,
            col.data[i * col.comps + 1]! / denom,
            col.data[i * col.comps + 2]! / denom,
          ]);
        }
      }
      let triColors: Array<V3 | null> | undefined;
      if (vertColors || factor) {
        const f: V3 = factor ? [factor[0] ?? 1, factor[1] ?? 1, factor[2] ?? 1] : [1, 1, 1];
        triColors = tris.map(([ia, ib, ic]): V3 => {
          const at = (i: number): V3 => vertColors?.[i] ?? [1, 1, 1];
          const a = at(ia), b = at(ib), c = at(ic);
          return [
            ((a[0]! + b[0]! + c[0]!) / 3) * f[0]! * 255,
            ((a[1]! + b[1]! + c[1]!) / 3) * f[1]! * 255,
            ((a[2]! + b[2]! + c[2]!) / 3) * f[2]! * 255,
          ];
        });
      }
      return { verts, tris, triColors };
    }),
  );

  const localMatrix = (nodeIdx: number, ts: number): Mat4 => {
    const node = g.nodes![nodeIdx]!;
    if (node.matrix) return node.matrix.slice();
    const tr = anim[nodeIdx];
    const t = tr?.translation ? sampleTrack(tr.translation.times, tr.translation.values, 3, ts, false) : node.translation ?? [0, 0, 0];
    const q = tr?.rotation ? sampleTrack(tr.rotation.times, tr.rotation.values, 4, ts, true) : node.rotation ?? [0, 0, 0, 1];
    const s = tr?.scale ? sampleTrack(tr.scale.times, tr.scale.values, 3, ts, false) : node.scale ?? [1, 1, 1];
    return fromTRS(t, q, s);
  };

  const frames: Mesh[] = [];
  for (let f = 0; f < frameCount; f++) {
    const ts = animated ? tMin + ((tMax - tMin) * f) / Math.max(1, frameCount - 1) : 0;
    const verts: V3[] = [];
    const tris: Tri[] = [];
    const triColors: Array<V3 | null> = [];
    const visit = (nodeIdx: number, parent: Mat4): void => {
      const node = g.nodes![nodeIdx]!;
      const world = mul(parent, localMatrix(nodeIdx, ts));
      if (node.mesh !== undefined) {
        for (const prim of meshGeo[node.mesh]!) {
          const base = verts.length;
          for (const v of prim.verts) verts.push(transform(world, v));
          for (const t of prim.tris) tris.push([t[0] + base, t[1] + base, t[2] + base]);
          if (prim.triColors) triColors.push(...prim.triColors);
          else for (let i = 0; i < prim.tris.length; i++) triColors.push(null);
        }
      }
      for (const c of node.children ?? []) visit(c, world);
    };
    for (const r of roots) visit(r, identity());
    frames.push({ verts, tris, triColors: triColors.some((c) => c !== null) ? triColors : undefined });
  }
  return rasterizeSequence(frames, opts);
}

/** Parse a binary .glb container → its JSON + BIN chunk (Blender's default glTF export format). */
export function parseGlb(buf: ArrayBuffer): { json: GltfJson; bin?: ArrayBuffer } {
  const dv = new DataView(buf);
  if (dv.getUint32(0, true) !== 0x46546c67) throw new Error("not a .glb file (bad magic)");
  let off = 12; // skip 12-byte header (magic, version, length)
  let json: GltfJson | null = null;
  let bin: ArrayBuffer | undefined;
  while (off + 8 <= dv.byteLength) {
    const len = dv.getUint32(off, true);
    const type = dv.getUint32(off + 4, true);
    off += 8;
    const chunk = buf.slice(off, off + len);
    if (type === 0x4e4f534a) json = JSON.parse(new TextDecoder().decode(chunk)) as GltfJson; // "JSON"
    else if (type === 0x004e4942) bin = chunk; // "BIN\0"
    off += len;
  }
  if (!json) throw new Error("glb has no JSON chunk");
  return { json, bin };
}

/** Import a binary .glb → animated voxel frames. */
export function glbToFrames(buf: ArrayBuffer, opts: GltfImportOptions = {}): VoxelVolume[] {
  const { json, bin } = parseGlb(buf);
  return gltfToFrames(json, { ...opts, buffers: bin ? [bin] : opts.buffers });
}
