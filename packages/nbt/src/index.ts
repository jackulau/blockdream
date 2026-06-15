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
  | { type: typeof TAG.List; elementType: TagType; value: NbtValue[] }
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
export const LongArray = (value: BigInt64Array): NbtValue => ({ type: TAG.LongArray, value });

// Writer -------------------------------------------------------------------

class ByteWriter {
  private chunks: Buffer[] = [];
  constructor(private le: boolean) {}

  push(b: Buffer): void {
    this.chunks.push(b);
  }
  u8(v: number): void {
    this.push(Buffer.from([v & 0xff]));
  }
  i8(v: number): void {
    this.push(Buffer.from([v & 0xff]));
  }
  i16(v: number): void {
    const b = Buffer.allocUnsafe(2);
    if (this.le) b.writeInt16LE(v | 0, 0);
    else b.writeInt16BE(v | 0, 0);
    this.push(b);
  }
  i32(v: number): void {
    const b = Buffer.allocUnsafe(4);
    if (this.le) b.writeInt32LE(v | 0, 0);
    else b.writeInt32BE(v | 0, 0);
    this.push(b);
  }
  i64(v: bigint): void {
    const b = Buffer.allocUnsafe(8);
    if (this.le) b.writeBigInt64LE(v, 0);
    else b.writeBigInt64BE(v, 0);
    this.push(b);
  }
  f32(v: number): void {
    const b = Buffer.allocUnsafe(4);
    if (this.le) b.writeFloatLE(v, 0);
    else b.writeFloatBE(v, 0);
    this.push(b);
  }
  f64(v: number): void {
    const b = Buffer.allocUnsafe(8);
    if (this.le) b.writeDoubleLE(v, 0);
    else b.writeDoubleBE(v, 0);
    this.push(b);
  }
  bytes(v: Uint8Array): void {
    this.push(Buffer.from(v.buffer, v.byteOffset, v.byteLength));
  }
  str(v: string): void {
    const utf8 = Buffer.from(v, "utf8");
    this.i16(utf8.length);
    this.push(utf8);
  }
  result(): Buffer {
    return Buffer.concat(this.chunks);
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
      w.i32(tag.value.length);
      for (const el of tag.value) writePayload(w, el);
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
      for (const n of tag.value) w.i32(n);
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
