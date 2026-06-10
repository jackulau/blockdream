// Prove the generated packs are real, droppable archives: zip → unzip → structure check,
// for the Java datapack (.zip) and BOTH Bedrock paths (.mcpack). Also round-trips the zip
// writer/reader so we know the container itself is valid (CRC, central directory, EOCD).

import { describe, it, expect } from "vitest";
import type { QuantizedFrame } from "@blockdream/color-core";
import { generateJavaDatapack } from "../src/datapack";
import { generateBedrockBehaviorPack } from "../src/behaviorpack";
import { generateBedrockScriptAddon } from "../src/bedrock-script";
import { zipStore, unzipText } from "../src/zip";
import {
  packageJavaDatapack,
  packageMcpack,
  validateJavaDatapackArchive,
  validateBedrockMcpackArchive,
} from "../src/package";

function frameFromIds(ids: number[][]): QuantizedFrame {
  const h = ids.length;
  const w = ids[0]!.length;
  const flat = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) flat[y * w + x] = ids[y]![x]!;
  return { width: w, height: h, paletteIndex: new Int32Array(w * h), mapColorId: flat };
}
const resolve = (id: number) => ["minecraft:white_concrete", "minecraft:black_concrete"][id % 2];
const frames = [frameFromIds([[0, 1], [1, 0]]), frameFromIds([[1, 0], [1, 0]])];

describe("zip container (store-only) round-trips", () => {
  it("write → read returns identical content", () => {
    const files = new Map([["a.txt", "hello"], ["dir/b.json", '{"x":1}'], ["c", "ünîcode ✓"]]);
    const back = unzipText(zipStore(files));
    expect(back.get("a.txt")).toBe("hello");
    expect(back.get("dir/b.json")).toBe('{"x":1}');
    expect(back.get("c")).toBe("ünîcode ✓");
    expect(back.size).toBe(3);
  });

  it("starts with the PK local-file-header magic", () => {
    const z = zipStore(new Map([["x", "y"]]));
    expect([z[0], z[1], z[2], z[3]]).toEqual([0x50, 0x4b, 0x03, 0x04]);
  });
});

describe("Java datapack is a droppable .zip", () => {
  const zip = packageJavaDatapack(generateJavaDatapack(frames, resolve, { namespace: "wallart" }));

  it("validates structurally (pack.mcmeta + tick tag + namespaced functions)", () => {
    const check = validateJavaDatapackArchive(zip);
    expect(check.errors).toEqual([]);
    expect(check.ok).toBe(true);
  });

  it("has pack.mcmeta at the archive ROOT (not nested)", () => {
    const files = unzipText(zip);
    expect(files.has("pack.mcmeta")).toBe(true);
    expect(files.has("data/wallart/function/setup.mcfunction")).toBe(true);
  });
});

describe("Bedrock behavior pack is a droppable .mcpack", () => {
  const mcpack = packageMcpack(generateBedrockBehaviorPack(frames, resolve).files);

  it("validates structurally (manifest at root, format 2, header+module uuids)", () => {
    const check = validateBedrockMcpackArchive(mcpack);
    expect(check.errors).toEqual([]);
    expect(check.ok).toBe(true);
  });

  it("manifest.json + functions sit at the archive root", () => {
    const files = unzipText(mcpack);
    expect(files.has("manifest.json")).toBe(true);
    expect(files.has("functions/tick.json")).toBe(true);
  });
});

describe("Bedrock Script addon is a droppable .mcpack (behavior_pack/ stripped to root)", () => {
  const pack = generateBedrockScriptAddon(frames, resolve);
  const mcpack = packageMcpack(pack.files, { stripPrefix: "behavior_pack/" });

  it("manifest.json + scripts/ are promoted to the archive root", () => {
    const files = unzipText(mcpack);
    expect(files.has("manifest.json")).toBe(true);
    expect(files.has("scripts/main.js")).toBe(true);
    expect(files.has("scripts/frames.js")).toBe(true);
    // nothing should remain under the stripped prefix
    expect([...files.keys()].some((k) => k.startsWith("behavior_pack/"))).toBe(false);
  });

  it("validates as a Bedrock pack", () => {
    expect(validateBedrockMcpackArchive(mcpack).ok).toBe(true);
  });
});
