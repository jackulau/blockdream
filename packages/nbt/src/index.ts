/**
 * NBT (Named Binary Tag) writer + reader, parameterized by endianness.
 *
 * - Java edition: BIG-endian, usually gzip-compressed (map_<n>.dat, level.dat).
 * - Bedrock edition: LITTLE-endian (.mcstructure, and a header-prefixed level.dat).
 *
 * Both editions share the same tag ids and tree model; only integer/float byte
 * order and the string length prefix differ - so one implementation serves both.
 */

export type Endianness = "big" | "little";

export const TAG = {
  End: 0,
  Byte: 1,
  Short: 2,
  Int: 3,
  Long: 4,
  Float: 5,
  Double: 6,
  ByteArray: 7,
  String: 8,
  List: 9,
  Compound: 10,
  IntArray: 11,
  LongArray: 12,
} as const;

export type TagType = (typeof TAG)[keyof typeof TAG];

export type NbtValue =
  | { type: typeof TAG.Byte; value: number }
  | { type: typeof TAG.Short; value: number }
  | { type: typeof TAG.Int; value: number }
  | { type: typeof TAG.Long; value: bigint }
  | { type: typeof TAG.Float; value: number }
  | { type: typeof TAG.Double; value: number }
  | { type: typeof TAG.ByteArray; value: Uint8Array }
  | { type: typeof TAG.String; value: string }
  | { type: typeof TAG.List; elementType: TagType; value: NbtValue[]; ints?: Int32Array }
  | { type: typeof TAG.Compound; value: NbtCompound }
  | { type: typeof TAG.IntArray; value: Int32Array }
  | { type: typeof TAG.LongArray; value: BigInt64Array };

export interface NbtCompound {
  [name: string]: NbtValue;
}

// Constructors -------------------------------------------------------------

export const Byte = (value: number): NbtValue => ({ type: TAG.Byte, value });
export const Short = (value: number): NbtValue => ({ type: TAG.Short, value });
export const Int = (value: number): NbtValue => ({ type: TAG.Int, value });
export const Long = (value: bigint): NbtValue => ({ type: TAG.Long, value });
export const Float = (value: number): NbtValue => ({ type: TAG.Float, value });
export const Double = (value: number): NbtValue => ({ type: TAG.Double, value });
export const ByteArray = (value: Uint8Array): NbtValue => ({ type: TAG.ByteArray, value });
export const Str = (value: string): NbtValue => ({ type: TAG.String, value });
export const List = (elementType: TagType, value: NbtValue[]): NbtValue => ({ type: TAG.List, elementType, value });
export const Compound = (value: NbtCompound): NbtValue => ({ type: TAG.Compound, value });
export const IntArray = (value: Int32Array): NbtValue => ({ type: TAG.IntArray, value });
/**
 * A `List<Int>` backed by a raw `Int32Array` instead of N `Int()` objects - serializes BYTE-IDENTICALLY
 * to `List(TAG.Int, [...].map(Int))` but skips the per-element wrapper objects (the .mcstructure index
 * layers are ~12.6M ints each; wrapping them was the 5.6-26s GC-variable cost). readNbt reads it back as
 * a normal List<Int>.
 */
export const IntList = (ints: Int32Array): NbtValue => ({ type: TAG.List, elementType: TAG.Int, value: [], ints });
export const LongArray = (value: BigInt64Array): NbtValue => ({ type: TAG.LongArray, value });

// Writer -------------------------------------------------------------------

// Host byte order. On a little-endian host an Int32Array's bytes ARE the LE int32 sequence, so writing
// a little-endian NBT int list is a single bulk copy rather than N writeInt32LE calls.
const HOST_LE = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;

// One growable buffer written in place. The previous version allocated a tiny Buffer per primitive +
// pushed to a chunks[] array, then Buffer.concat at the end - ~25M allocations for a large .mcstructure's
// index layers (~40 s at 512px). This writes each primitive directly into a buffer that doubles on
// demand: byte-identical output, an order of magnitude faster on large structures.
class ByteWriter {
  private buf: Buffer;
  private len = 0;
  constructor(private le: boolean) {
    this.buf = Buffer.allocUnsafe(1024);
  }

  private ensure(n: number): void {
    const need = this.len + n;
    if (need > this.buf.length) {
      let cap = this.buf.length * 2;
      while (cap < need) cap *= 2;
      const nb = Buffer.allocUnsafe(cap);
      this.buf.copy(nb, 0, 0, this.len);
      this.buf = nb;
    }
  }
  push(b: Buffer): void {
    this.ensure(b.length);
    b.copy(this.buf, this.len);
    this.len += b.length;
  }
  u8(v: number): void {
    this.ensure(1);
    this.buf[this.len++] = v & 0xff;
  }
  i8(v: number): void {
    this.ensure(1);
    this.buf[this.len++] = v & 0xff;
  }
  i16(v: number): void {
    this.ensure(2);
    if (this.le) this.buf.writeInt16LE(v | 0, this.len);
    else this.buf.writeInt16BE(v | 0, this.len);
    this.len += 2;
  }
  i32(v: number): void {
    this.ensure(4);
    if (this.le) this.buf.writeInt32LE(v | 0, this.len);
    else this.buf.writeInt32BE(v | 0, this.len);
    this.len += 4;
  }
  i64(v: bigint): void {
    this.ensure(8);
    if (this.le) this.buf.writeBigInt64LE(v, this.len);
    else this.buf.writeBigInt64BE(v, this.len);
    this.len += 8;
  }
  f32(v: number): void {
    this.ensure(4);
    if (this.le) this.buf.writeFloatLE(v, this.len);
    else this.buf.writeFloatBE(v, this.len);
    this.len += 4;
  }
  f64(v: number): void {
    this.ensure(8);
    if (this.le) this.buf.writeDoubleLE(v, this.len);
    else this.buf.writeDoubleBE(v, this.len);
    this.len += 8;
  }
  bytes(v: Uint8Array): void {
    this.ensure(v.byteLength);
    Buffer.from(v.buffer, v.byteOffset, v.byteLength).copy(this.buf, this.len);
    this.len += v.byteLength;
  }
  /** Write an Int32Array as NBT int32s. On a little-endian host writing little-endian, the array's raw
   *  bytes ARE the output - one bulk copy instead of N writeInt32LE calls (the .mcstructure index path). */
  intArray(arr: Int32Array): void {
    if (this.le && HOST_LE) {
      this.bytes(new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength));
    } else {
      for (let i = 0; i < arr.length; i++) this.i32(arr[i]!);
    }
  }
  str(v: string): void {
    const utf8 = Buffer.from(v, "utf8");
    this.i16(utf8.length);
    this.push(utf8);
  }
  result(): Buffer {
    return Buffer.from(this.buf.subarray(0, this.len));
  }
}

function writePayload(w: ByteWriter, tag: NbtValue): void {
  switch (tag.type) {
    case TAG.Byte:
      w.i8(tag.value);
      break;
    case TAG.Short:
      w.i16(tag.value);
      break;
    case TAG.Int:
      w.i32(tag.value);
      break;
    case TAG.Long:
      w.i64(tag.value);
      break;
    case TAG.Float:
      w.f32(tag.value);
      break;
    case TAG.Double:
      w.f64(tag.value);
      break;
    case TAG.ByteArray:
      w.i32(tag.value.length);
      w.bytes(tag.value);
      break;
    case TAG.String:
      w.str(tag.value);
      break;
    case TAG.List:
      w.u8(tag.elementType);
      if (tag.ints) {
        // IntList fast path: write the raw ints directly - byte-identical to a List<Int> of Int() objects
        w.i32(tag.ints.length);
        w.intArray(tag.ints);
      } else {
        w.i32(tag.value.length);
        for (const el of tag.value) writePayload(w, el);
      }
      break;
    case TAG.Compound:
      for (const [name, child] of Object.entries(tag.value)) {
        w.u8(child.type);
        w.str(name);
        writePayload(w, child);
      }
      w.u8(TAG.End);
      break;
    case TAG.IntArray:
      w.i32(tag.value.length);
      w.intArray(tag.value);
      break;
    case TAG.LongArray:
      w.i32(tag.value.length);
      for (const n of tag.value) w.i64(n);
      break;
  }
}

/** Serialize a root compound to uncompressed NBT bytes. */
export function writeNbt(rootName: string, root: NbtValue, endianness: Endianness = "big"): Buffer {
  if (root.type !== TAG.Compound) throw new Error("NBT root must be a Compound");
  const w = new ByteWriter(endianness === "little");
  w.u8(TAG.Compound);
  w.str(rootName);
  writePayload(w, root);
  return w.result();
}

// Reader -------------------------------------------------------------------

class ByteReader {
  constructor(private buf: Buffer, private le: boolean, private pos = 0) {}
  u8(): number {
    return this.buf.readUInt8(this.pos++);
  }
  i8(): number {
    return this.buf.readInt8(this.pos++);
  }
  i16(): number {
    const v = this.le ? this.buf.readInt16LE(this.pos) : this.buf.readInt16BE(this.pos);
    this.pos += 2;
    return v;
  }
  i32(): number {
    const v = this.le ? this.buf.readInt32LE(this.pos) : this.buf.readInt32BE(this.pos);
    this.pos += 4;
    return v;
  }
  i64(): bigint {
    const v = this.le ? this.buf.readBigInt64LE(this.pos) : this.buf.readBigInt64BE(this.pos);
    this.pos += 8;
    return v;
  }
  f32(): number {
    const v = this.le ? this.buf.readFloatLE(this.pos) : this.buf.readFloatBE(this.pos);
    this.pos += 4;
    return v;
  }
  f64(): number {
    const v = this.le ? this.buf.readDoubleLE(this.pos) : this.buf.readDoubleBE(this.pos);
    this.pos += 8;
    return v;
  }
  bytes(n: number): Uint8Array {
    const v = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return new Uint8Array(v);
  }
  str(): string {
    const n = this.i16();
    const v = this.buf.toString("utf8", this.pos, this.pos + n);
    this.pos += n;
    return v;
  }
}

function readPayload(r: ByteReader, type: TagType): NbtValue {
  switch (type) {
    case TAG.Byte:
      return Byte(r.i8());
    case TAG.Short:
      return Short(r.i16());
    case TAG.Int:
      return Int(r.i32());
    case TAG.Long:
      return Long(r.i64());
    case TAG.Float:
      return Float(r.f32());
    case TAG.Double:
      return Double(r.f64());
    case TAG.ByteArray:
      return ByteArray(r.bytes(r.i32()));
    case TAG.String:
      return Str(r.str());
    case TAG.List: {
      const elementType = r.u8() as TagType;
      const len = r.i32();
      const items: NbtValue[] = [];
      for (let i = 0; i < len; i++) items.push(readPayload(r, elementType));
      return List(elementType, items);
    }
    case TAG.Compound: {
      const obj: NbtCompound = {};
      for (;;) {
        const childType = r.u8() as TagType;
        if (childType === TAG.End) break;
        const name = r.str();
        obj[name] = readPayload(r, childType);
      }
      return Compound(obj);
    }
    case TAG.IntArray: {
      const len = r.i32();
      const arr = new Int32Array(len);
      for (let i = 0; i < len; i++) arr[i] = r.i32();
      return IntArray(arr);
    }
    case TAG.LongArray: {
      const len = r.i32();
      const arr = new BigInt64Array(len);
      for (let i = 0; i < len; i++) arr[i] = r.i64();
      return LongArray(arr);
    }
    default:
      throw new Error(`unknown NBT tag type ${type}`);
  }
}

export interface ParsedNbt {
  name: string;
  root: NbtValue;
}

/** Parse uncompressed NBT bytes into a tagged tree. */
export function readNbt(buf: Buffer, endianness: Endianness = "big"): ParsedNbt {
  const r = new ByteReader(buf, endianness === "little");
  const type = r.u8() as TagType;
  if (type !== TAG.Compound) throw new Error("NBT root must be a Compound");
  const name = r.str();
  return { name, root: readPayload(r, TAG.Compound) };
}
