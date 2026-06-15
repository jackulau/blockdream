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

function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = (CRC_TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8)) >>> 0;
  return (c ^ 0xffffffff) >>> 0;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Build a store-only zip from a path→content map. `content` may be a string or bytes. */
export function zipStore(files: Map<string, string | Uint8Array> | Record<string, string | Uint8Array>): Uint8Array {
  const list: Array<[string, string | Uint8Array]> = files instanceof Map ? [...files] : Object.entries(files);
  const local: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  let cdSize = 0;

  for (const [path, content] of list) {
    const name = enc.encode(path);
    const data = typeof content === "string" ? enc.encode(content) : content;
    const crc = crc32(data);

    const lh = new Uint8Array(30 + name.length);
    const ldv = new DataView(lh.buffer);
    ldv.setUint32(0, 0x04034b50, true); // local file header
    ldv.setUint16(4, 20, true); // version needed
    ldv.setUint16(8, 0, true); // method 0 = store
    ldv.setUint16(12, 0x21, true); // dos date (1980-01-01)
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
    cdv.setUint16(12, 0x21, true);
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
