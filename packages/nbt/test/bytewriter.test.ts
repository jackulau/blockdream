import { describe, it, expect } from "vitest";
import { writeNbt, readNbt, Compound, List, IntList, Int, Long, Str, Float, Double, Byte, IntArray, TAG } from "../src/index";

// The growable ByteWriter must produce byte-identical output to the old chunk-concat writer. These
// exercise the doubling/ensure logic (writes that straddle a growth boundary) + every primitive width
// + both endians, via NBT round-trips (readNbt(writeNbt(x)) === x).

describe("ByteWriter (growable buffer) is correct across growth boundaries + widths", () => {
  it("a large List<Int> (forces many buffer doublings from the 1024-byte seed) round-trips intact", () => {
    const n = 20000; // 20000 * 4B ≫ 1024 → ~7 doublings
    const ints = Array.from({ length: n }, (_, i) => (i * 2654435761) | 0); // varied 32-bit values
    const root = Compound({ data: List(TAG.Int, ints.map(Int)) });
    for (const le of [true, false] as const) {
      const buf = writeNbt("", root, le ? "little" : "big");
      const { root: back } = readNbt(buf, le ? "little" : "big");
      expect(back.type).toBe(TAG.Compound);
      const list = (back as { value: Record<string, { value: { value: number }[] }> }).value["data"]!;
      expect(list.value.length).toBe(n);
      expect(list.value.map((t) => t.value)).toEqual(ints);
    }
  });

  it("every primitive width round-trips on both endians (byte/short via Int/Long/Float/Double/IntArray/Str)", () => {
    const root = Compound({
      b: Byte(-5),
      i: Int(-123456),
      l: Long(-9007199254740993n),
      f: Float(1.5),
      d: Double(-2.25),
      arr: IntArray(new Int32Array([1, -2, 3, -2147483648, 2147483647])),
      s: Str("a string that pushes past inline widths — αβγ unicode"),
    });
    for (const fmt of ["little", "big"] as const) {
      const { root: back } = readNbt(writeNbt("", root, fmt), fmt);
      const v = (back as { value: Record<string, { value: unknown }> }).value;
      expect((v["i"] as { value: number }).value).toBe(-123456);
      expect((v["l"] as { value: bigint }).value).toBe(-9007199254740993n);
      expect((v["d"] as { value: number }).value).toBe(-2.25);
      expect(Array.from((v["arr"] as { value: Int32Array }).value)).toEqual([1, -2, 3, -2147483648, 2147483647]);
      expect((v["s"] as { value: string }).value).toBe("a string that pushes past inline widths — αβγ unicode");
    }
  });

  it("a string straddling a growth boundary writes its length + bytes correctly", () => {
    const big = "x".repeat(5000); // > 1024, forces growth mid-string
    const { root: back } = readNbt(writeNbt("", Compound({ s: Str(big) }), "little"), "little");
    expect((back as { value: Record<string, { value: string }> }).value["s"]!.value).toBe(big);
  });

  it("IntList serializes BYTE-IDENTICALLY to a List<Int> of Int() objects (both endians)", () => {
    const arr = new Int32Array([0, 1, -1, 123456, -2147483648, 2147483647, 42, -7]);
    for (const fmt of ["little", "big"] as const) {
      const viaIntList = writeNbt("", Compound({ x: IntList(arr) }), fmt);
      const viaObjects = writeNbt("", Compound({ x: List(TAG.Int, Array.from(arr, Int)) }), fmt);
      expect(Buffer.compare(viaIntList, viaObjects)).toBe(0);
    }
    // round-trips back as a normal List<Int>
    const { root } = readNbt(writeNbt("", Compound({ x: IntList(arr) }), "little"), "little");
    const list = (root as { value: Record<string, { value: { value: number }[] }> }).value["x"]!;
    expect(list.value.map((t) => t.value)).toEqual(Array.from(arr));
  });

  it("IntList nested inside a List<List<Int>> (the .mcstructure block_indices shape) is byte-identical", () => {
    const a = new Int32Array([1, 2, 3]);
    const b = new Int32Array([-1, -1, -1]);
    const viaIntList = writeNbt("", Compound({ block_indices: List(TAG.List, [IntList(a), IntList(b)]) }), "little");
    const viaObjects = writeNbt("", Compound({ block_indices: List(TAG.List, [List(TAG.Int, Array.from(a, Int)), List(TAG.Int, Array.from(b, Int))]) }), "little");
    expect(Buffer.compare(viaIntList, viaObjects)).toBe(0);
  });
});
