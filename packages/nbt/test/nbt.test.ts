// Direct round-trip coverage for every NBT tag type, both endiannesses. The codec was
// previously only exercised transitively (emit-java map.dat = big-endian, emit-bedrock
// mcstructure = little-endian); these assert IntArray/LongArray/Float/Double/Short/List/
// nested Compound directly, which those consumers don't all touch.

import { describe, it, expect } from "vitest";
import {
  writeNbt, readNbt, Byte, Short, Int, Long, Float, Double, Str, ByteArray, IntArray, LongArray,
  List, Compound, TAG, type NbtCompound, type Endianness,
} from "../src/index";

const endians: Endianness[] = ["big", "little"];

function root(): NbtCompound {
  return {
    b: Byte(-7),
    sh: Short(-12345),
    i: Int(0x01020304),
    l: Long(0x0102030405060708n),
    f: Float(1.25), // exactly representable in float32
    d: Double(3.141592653589793),
    s: Str("héllo ✓"),
    ba: ByteArray(Uint8Array.from([1, 2, 250, 255])),
    ia: IntArray(Int32Array.from([-1, 0, 1, 70000])),
    la: LongArray(BigInt64Array.from([-1n, 0n, 9007199254740993n])),
    list: List(TAG.Int, [Int(10), Int(20), Int(30)]),
    nested: Compound({ x: Int(1), y: Str("inner") }),
  };
}

describe.each(endians)("NBT round-trip (%s endian)", (endian) => {
  const buf = writeNbt("Root", Compound(root()), endian);
  const parsed = readNbt(buf, endian);
  const c = (parsed.root.value as NbtCompound);

  it("preserves the root name", () => {
    expect(parsed.name).toBe("Root");
    expect(parsed.root.type).toBe(TAG.Compound);
  });

  it("round-trips scalar tags (byte/short/int/long/float/double/string)", () => {
    expect(c.b!.value).toBe(-7);
    expect(c.sh!.value).toBe(-12345);
    expect(c.i!.value).toBe(0x01020304);
    expect(c.l!.value).toBe(0x0102030405060708n);
    expect(c.f!.value).toBeCloseTo(1.25, 6);
    expect(c.d!.value).toBeCloseTo(3.141592653589793, 12);
    expect(c.s!.value).toBe("héllo ✓");
  });

  it("round-trips array tags (byte/int/long)", () => {
    expect(Array.from(c.ba!.value as Uint8Array)).toEqual([1, 2, 250, 255]);
    expect(Array.from(c.ia!.value as Int32Array)).toEqual([-1, 0, 1, 70000]);
    expect(Array.from(c.la!.value as BigInt64Array)).toEqual([-1n, 0n, 9007199254740993n]);
  });

  it("round-trips a typed List", () => {
    const list = c.list!;
    expect(list.type).toBe(TAG.List);
    expect((list.value as { value: number }[]).map((e) => e.value)).toEqual([10, 20, 30]);
  });

  it("round-trips a nested Compound", () => {
    const nested = c.nested!.value as NbtCompound;
    expect(nested.x!.value).toBe(1);
    expect(nested.y!.value).toBe("inner");
  });
});

describe("NBT endianness actually differs on the wire", () => {
  it("big vs little encodings of the same tree are not byte-identical", () => {
    const tree = Compound({ i: Int(0x01020304) });
    const big = writeNbt("R", tree, "big");
    const little = writeNbt("R", tree, "little");
    expect(Buffer.compare(big, little)).not.toBe(0);
  });

  it("rejects a non-Compound root", () => {
    const bad = writeNbt("R", Compound({}), "big");
    bad[0] = TAG.Int; // corrupt the root tag type
    expect(() => readNbt(bad, "big")).toThrow(/root must be a Compound/i);
  });
});
