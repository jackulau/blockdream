import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MC_VERSIONS, JAVA_DATAPACK_SUPPORTED, resolveMcVersion } from "@blockdream/palette";
import type { QuantizedFrame } from "@blockdream/color-core";
import {
  generateJavaDatapack,
  packageJavaDatapack,
  validateJavaDatapackArchive,
} from "@blockdream/emit-commands";
import { buildMapDat, readNbt } from "@blockdream/emit-java";
import { hasFfmpeg, runFfmpeg } from "@blockdream/video";
import { render, type RenderTarget } from "../src/render";

function frame(w: number, h: number, fill: (x: number, y: number) => number): QuantizedFrame {
  const n = w * h;
  const mapColorId = new Uint8Array(n);
  const paletteIndex = new Int32Array(n);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      mapColorId[y * w + x] = fill(x, y);
      paletteIndex[y * w + x] = fill(x, y);
    }
  }
  return { width: w, height: h, mapColorId, paletteIndex };
}

const rb = (id: number): string | undefined =>
  ["minecraft:air", "minecraft:white_concrete", "minecraft:black_concrete"][id] ?? undefined;

function readDataVersion(dat: Buffer): number {
  const raw = dat[0] === 0x1f && dat[1] === 0x8b ? gunzipSync(dat) : dat;
  const { root } = readNbt(raw);
  if (root.type !== 10 /* Compound */) throw new Error("bad map.dat");
  const dv = root.value["DataVersion"];
  if (!dv || typeof dv.value !== "number") throw new Error("no DataVersion");
  return dv.value;
}

describe("every supported Minecraft version stamps correct, loadable artifacts", () => {
  const frames: QuantizedFrame[] = [frame(8, 8, () => 1), frame(8, 8, (x) => (x < 4 ? 1 : 2))];

  it("datapack: pack_format matches the registry AND supported_formats opens it across the whole line", () => {
    for (const v of MC_VERSIONS) {
      const pack = generateJavaDatapack(frames, rb, {
        packFormat: v.packFormat,
        supportedFormats: JAVA_DATAPACK_SUPPORTED,
      });
      const meta = JSON.parse(pack.files.get("pack.mcmeta")!);
      expect(meta.pack.pack_format, v.id).toBe(v.packFormat);
      // a single artifact declares the whole line, so this version's format is in range
      expect(meta.pack.supported_formats.min_inclusive).toBeLessThanOrEqual(v.packFormat);
      expect(meta.pack.supported_formats.max_inclusive).toBeGreaterThanOrEqual(v.packFormat);
      const check = validateJavaDatapackArchive(packageJavaDatapack(pack));
      expect(check.errors, v.id).toEqual([]);
    }
  });

  it("map .dat: DataVersion matches the registry for each version (older stamps auto-upgrade)", () => {
    const f128 = frame(128, 128, (x, y) => ((x ^ y) & 1 ? 1 : 2));
    for (const v of MC_VERSIONS) {
      const dat = buildMapDat(f128, { dataVersion: v.dataVersion });
      expect(readDataVersion(dat), v.id).toBe(v.dataVersion);
    }
  });

  it("supported_formats spans floor → latest of the registry", () => {
    expect(JAVA_DATAPACK_SUPPORTED.min_inclusive).toBe(MC_VERSIONS[0]!.packFormat);
    expect(JAVA_DATAPACK_SUPPORTED.max_inclusive).toBe(MC_VERSIONS[MC_VERSIONS.length - 1]!.packFormat);
  });
});

// Full CLI path for EVERY target, exercised end-to-end on real ffmpeg-decoded content.
const ff = hasFfmpeg();
const d = ff ? describe : describe.skip;

d("end-to-end render of every target (real content)", () => {
  let dir: string;
  let clip: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "mw-vmatrix-"));
    clip = join(dir, "clip.mp4");
    const r = runFfmpeg(["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=128x128:rate=8:duration=1", "-y", clip]);
    if (r.status !== 0) throw new Error("ffmpeg gen failed: " + r.stderr);
  });

  const blockTargets: RenderTarget[] = ["datapack", "behaviorpack", "bedrock-script", "mcstructure", "voxel3d"];
  for (const target of blockTargets) {
    it(`${target} renders to files`, () => {
      const out = join(dir, target);
      const res = render({ input: clip, out, target, width: 64, height: 64, maxFrames: 3 });
      expect(res.filesWritten.length, target).toBeGreaterThan(0);
      expect(res.frameCount).toBe(3);
    });
  }

  it("map renders for java AND bedrock editions", () => {
    for (const edition of ["java", "bedrock"] as const) {
      const out = join(dir, `map-${edition}`);
      const res = render({ input: clip, out, target: "map", width: 128, height: 128, maxFrames: 1, edition });
      expect(res.filesWritten.length, edition).toBeGreaterThan(0);
    }
  });

  it("datapack stamps the requested version's pack_format on disk", () => {
    for (const id of ["1.21", "1.21.5", "1.21.9"]) {
      const out = join(dir, `dp-${id}`);
      render({ input: clip, out, target: "datapack", width: 64, height: 64, maxFrames: 2, paletteVersion: id });
      const meta = JSON.parse(readFileSync(join(out, "pack.mcmeta"), "utf8"));
      expect(meta.pack.pack_format, id).toBe(resolveMcVersion(id).packFormat);
      expect(meta.pack.supported_formats).toEqual(JAVA_DATAPACK_SUPPORTED);
    }
  });

  it("voxel3d (3D) builds a valid datapack from real content", () => {
    const out = join(dir, "v3d");
    const res = render({ input: clip, out, target: "voxel3d", width: 48, height: 48, maxFrames: 2, depth: 4 });
    expect(res.filesWritten.some((p) => p.endsWith("blockdream_3d.zip"))).toBe(true);
  });
});
