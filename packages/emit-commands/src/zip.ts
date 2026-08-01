// Minimal, dependency-free ZIP (store-only) writer + reader. Store (no compression) is a
// valid container for Minecraft Java datapacks (.zip) and Bedrock packs (.mcpack). Pure
// Uint8Array + DataView, so it is browser-safe (lives in the "." entry - no node builtins).

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/**
 * Reference CRC-32, kept verbatim from before the slice-by-8 optimization
 * (byte-at-a-time over the classic 256-entry table). Exported only for the
 * equivalence + timing gate in zip.test.ts. Do not optimize.
 */
export function crc32Reference(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = (CRC_TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8)) >>> 0;
  return (c ^ 0xffffffff) >>> 0;
}

// Slice-by-8 tables: slice 0 is the classic table (same 0xedb88320 polynomial);
// slice k advances slice k-1 by one zero byte, so eight table lookups process
// eight input bytes per iteration with bit-identical results by construction.
// Flat 256x8 Uint32Array, module-local (vite-node compiles imported bindings to
// exports-getter lookups; a local constant stays a direct load in the hot loop).
const CRC_TABLES = (() => {
  const t = new Uint32Array(256 * 8);
  t.set(CRC_TABLE, 0);
  for (let s = 1; s < 8; s++) {
    for (let n = 0; n < 256; n++) {
      const prev = t[(s - 1) * 256 + n]!;
      t[s * 256 + n] = (t[prev & 0xff]! ^ (prev >>> 8)) >>> 0;
    }
  }
  return t;
})();

/** CRC-32 (slice-by-8). Bit-identical to {@link crc32Reference}, ~several x faster. */
function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  const n = data.length;
  const end8 = n - (n % 8);
  let i = 0;
  for (; i < end8; i += 8) {
    const lo = (data[i]! | (data[i + 1]! << 8) | (data[i + 2]! << 16) | (data[i + 3]! << 24)) ^ c;
    const hi = data[i + 4]! | (data[i + 5]! << 8) | (data[i + 6]! << 16) | (data[i + 7]! << 24);
    c =
      (CRC_TABLES[7 * 256 + (lo & 0xff)]! ^
        CRC_TABLES[6 * 256 + ((lo >>> 8) & 0xff)]! ^
        CRC_TABLES[5 * 256 + ((lo >>> 16) & 0xff)]! ^
        CRC_TABLES[4 * 256 + (lo >>> 24)]! ^
        CRC_TABLES[3 * 256 + (hi & 0xff)]! ^
        CRC_TABLES[2 * 256 + ((hi >>> 8) & 0xff)]! ^
        CRC_TABLES[1 * 256 + ((hi >>> 16) & 0xff)]! ^
        CRC_TABLES[hi >>> 24]!) >>>
      0;
  }
  for (; i < n; i++) c = (CRC_TABLES[(c ^ data[i]!) & 0xff]! ^ (c >>> 8)) >>> 0;
  return (c ^ 0xffffffff) >>> 0;
}

/** Optimized CRC-32 exported for the zip.test.ts equivalence/timing gate. */
export const crc32Sliced = crc32;

const enc = new TextEncoder();
const dec = new TextDecoder();

/**
 * Internal/test hook: lowered ceilings so the overflow guards can be exercised
 * without building a 65k-file or 4 GiB archive. Public callers omit this and get
 * the real zip format limits (uint16 entry count, uint32 sizes/offsets).
 */
export interface ZipStoreLimits {
  maxEntries?: number;
  maxBytes?: number;
}

/** Build a store-only zip from a path→content map. `content` may be a string or bytes.
 *  Throws instead of silently truncating when the archive exceeds what the classic
 *  (non-zip64) format can represent: >65535 entries used to wrap the EOCD uint16 count
 *  and drop files on extraction (70000 files silently became 4464). */
export function zipStore(
  files: Map<string, string | Uint8Array> | Record<string, string | Uint8Array>,
  limits: ZipStoreLimits = {},
): Uint8Array {
  const maxEntries = limits.maxEntries ?? 0xffff;
  const maxBytes = limits.maxBytes ?? 0xffffffff;
  const list: Array<[string, string | Uint8Array]> = files instanceof Map ? [...files] : Object.entries(files);
  if (list.length > maxEntries) {
    throw new Error(
      `datapack too large for zip: ${list.length} files (max ${maxEntries}); the zip end-of-central-directory entry count is 16-bit and this writer has no zip64 support - split the export or lower the frame count`,
    );
  }
  const local: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  let cdSize = 0;

  for (const [path, content] of list) {
    const name = enc.encode(path);
    const data = typeof content === "string" ? enc.encode(content) : content;
    if (data.length > maxBytes) {
      throw new Error(
        `datapack too large for zip: entry "${path}" is ${data.length} bytes (max ${maxBytes} in a non-zip64 archive)`,
      );
    }
    const crc = crc32(data);

    const lh = new Uint8Array(30 + name.length);
    const ldv = new DataView(lh.buffer);
    ldv.setUint32(0, 0x04034b50, true); // local file header
    ldv.setUint16(4, 20, true); // version needed
    ldv.setUint16(8, 0, true); // method 0 = store
    // last-mod TIME @10 stays 0 (00:00:00); DATE @12 = 0x21 (1980-01-01)
    ldv.setUint16(12, 0x21, true);
    ldv.setUint32(14, crc, true);
    ldv.setUint32(18, data.length, true); // compressed size
    ldv.setUint32(22, data.length, true); // uncompressed size
    ldv.setUint16(26, name.length, true);
    lh.set(name, 30);
    local.push(lh, data);

    const cd = new Uint8Array(46 + name.length);
    const cdv = new DataView(cd.buffer);
    cdv.setUint32(0, 0x02014b50, true); // central dir header
    cdv.setUint16(4, 20, true);
    cdv.setUint16(6, 20, true);
    cdv.setUint16(10, 0, true); // store
    // central-directory offsets shift by 2 vs the local header: TIME @12, DATE @14.
    // The DATE value 0x21 used to be written into the TIME slot (@12), leaving date 0 -
    // `unzip -l` showed the invalid "00-00-1980 00:01". Mirror the local header exactly.
    cdv.setUint16(12, 0, true); // last-mod time (00:00:00, matches local @10)
    cdv.setUint16(14, 0x21, true); // dos date 1980-01-01 (matches local @12)
    cdv.setUint32(16, crc, true);
    cdv.setUint32(20, data.length, true);
    cdv.setUint32(24, data.length, true);
    cdv.setUint16(28, name.length, true);
    cdv.setUint32(42, offset, true); // local header offset
    cd.set(name, 46);
    central.push(cd);
    cdSize += cd.length;

    offset += lh.length + data.length;
  }

  // Every stored local-header offset is < the final `offset`, and the EOCD stores
  // both the central-directory start (== offset) and its size as uint32: one check
  // here proves every 32-bit field in the archive fits.
  if (offset > maxBytes || cdSize > maxBytes) {
    throw new Error(
      `datapack too large for zip: archive spans ${offset} bytes (max ${maxBytes} in a non-zip64 archive) - split the export or lower the frame count`,
    );
  }

  const eocd = new Uint8Array(22);
  const edv = new DataView(eocd.buffer);
  edv.setUint32(0, 0x06054b50, true); // end of central directory
  edv.setUint16(8, list.length, true);
  edv.setUint16(10, list.length, true);
  edv.setUint32(12, cdSize, true);
  edv.setUint32(16, offset, true);

  const total = offset + cdSize + 22;
  const out = new Uint8Array(total);
  let p = 0;
  for (const c of local) { out.set(c, p); p += c.length; }
  for (const c of central) { out.set(c, p); p += c.length; }
  out.set(eocd, p);
  return out;
}

/** Read a store-only (or any) zip's central directory and return path→bytes. */
export function unzip(bytes: Uint8Array): Map<string, Uint8Array> {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("not a zip (no end-of-central-directory record)");
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const out = new Map<string, Uint8Array>();
  for (let n = 0; n < count; n++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error("corrupt central directory");
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const localOff = dv.getUint32(p + 42, true);
    const name = dec.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    const lNameLen = dv.getUint16(localOff + 26, true);
    const lExtraLen = dv.getUint16(localOff + 28, true);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const size = dv.getUint32(localOff + 22, true);
    out.set(name, bytes.subarray(dataStart, dataStart + size));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/** Convenience: unzip + decode every entry as UTF-8 text. */
export function unzipText(bytes: Uint8Array): Map<string, string> {
  const out = new Map<string, string>();
  for (const [k, v] of unzip(bytes)) out.set(k, dec.decode(v));
  return out;
}
