/**
 * Java-edition NBT = the shared NBT model fixed to BIG-endian.
 * Re-exported from @blockdream/nbt so existing imports keep working.
 */
export * from "@blockdream/nbt";
import { writeNbt as writeNbtBase, readNbt as readNbtBase, type NbtValue, type ParsedNbt } from "@blockdream/nbt";

/** Serialize a root compound to uncompressed big-endian (Java) NBT bytes. */
export function writeNbt(rootName: string, root: NbtValue): Buffer {
  return writeNbtBase(rootName, root, "big");
}

/** Parse uncompressed big-endian (Java) NBT bytes. */
export function readNbt(buf: Buffer): ParsedNbt {
  return readNbtBase(buf, "big");
}
