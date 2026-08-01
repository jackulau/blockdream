import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32Reference, crc32Sliced, unzip, unzipText, zipStore } from "../src/zip";

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  return (s[(s.length - 1) >> 1]! + s[s.length >> 1]!) / 2;
};

// Deterministic LCG bytes so failures reproduce.
function randomBytes(len: number, seed: number): Uint8Array {
  let s = seed | 0;
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff;
    out[i] = s & 0xff;
  }
  return out;
}

describe("crc32 slice-by-8", () => {
  it("is bit-identical to the reference on awkward lengths (0,1,7,8,9,63,64,65,1MB)", () => {
    for (const [k, len] of [0, 1, 7, 8, 9, 63, 64, 65, 1 << 20].entries()) {
      const buf = randomBytes(len, 0xc0ffee + k * 7919);
      expect(crc32Sliced(buf), `len ${len}`).toBe(crc32Reference(buf));
    }
    // known-answer sanity: CRC-32 of "123456789" is 0xcbf43926
    expect(crc32Sliced(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
    expect(crc32Reference(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
  });

  it("is byte-identical to the reference AND faster (same-run interleaved timing)", { retry: 2, timeout: 60000 }, () => {
    const buf = randomBytes(6 * (1 << 20) + 5, 0xbadc0de); // multi-MB, non-multiple-of-8 tail
    // warmup + identity
    expect(crc32Sliced(buf)).toBe(crc32Reference(buf));
    const refTimes: number[] = [];
    const optTimes: number[] = [];
    const timed = (fn: () => unknown): number => {
      const t = performance.now();
      fn();
      return performance.now() - t;
    };
    let sink = 0;
    const runRef = () => (sink ^= crc32Reference(buf));
    const runOpt = () => (sink ^= crc32Sliced(buf));
    for (let iter = 0; iter < 10; iter++) {
      if (iter % 2 === 0) {
        refTimes.push(timed(runRef));
        optTimes.push(timed(runOpt));
      } else {
        optTimes.push(timed(runOpt));
        refTimes.push(timed(runRef));
      }
    }
    expect(sink).toBe(0); // even number of xors of equal values; also defeats DCE
    const refMs = median(refTimes);
    const optMs = median(optTimes);
    expect(optMs).toBeGreaterThan(0);
    expect(optMs).toBeLessThan(refMs); // measured ~3-5x locally; gate only strictly-faster
  });
});

describe("zipStore roundtrip", () => {
  it("stores strings and bytes and unzips them back byte-for-byte", () => {
    const bytes = randomBytes(1234, 42);
    const zip = zipStore(new Map<string, string | Uint8Array>([
      ["pack.mcmeta", '{"pack":{}}'],
      ["data/ns/function/setup.mcfunction", "say hi\n"],
      ["bin/blob", bytes],
    ]));
    const back = unzip(zip);
    expect([...back.keys()].sort()).toEqual(["bin/blob", "data/ns/function/setup.mcfunction", "pack.mcmeta"]);
    expect(back.get("bin/blob")).toEqual(bytes);
    expect(unzipText(zip).get("data/ns/function/setup.mcfunction")).toBe("say hi\n");
  });
});

describe("zipStore last-mod timestamps (central directory mirrors the local header)", () => {
  // central-directory offsets are the local header's shifted by 2: TIME @12, DATE @14.
  // The DATE value 0x21 was once written into the central TIME slot (@12), leaving the
  // date field 0 - `unzip -l` listed the invalid "00-00-1980 00:01".
  it("central time/date bytes equal the local header's (date 1980-01-01, time 00:00)", () => {
    const zip = zipStore(new Map([["pack.mcmeta", '{"pack":{}}']]));
    const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    // local file header at offset 0: time @10, date @12
    expect(dv.getUint32(0, true)).toBe(0x04034b50);
    const localTime = dv.getUint16(10, true);
    const localDate = dv.getUint16(12, true);
    expect(localTime).toBe(0); // 00:00:00
    expect(localDate).toBe(0x21); // 1980-01-01
    // first central-directory header: time @+12, date @+14
    let cd = -1;
    for (let i = 0; i < zip.length - 3; i++) {
      if (dv.getUint32(i, true) === 0x02014b50) { cd = i; break; }
    }
    expect(cd).toBeGreaterThan(0);
    expect(dv.getUint16(cd + 12, true)).toBe(localTime); // central TIME == local time (was 0x21)
    expect(dv.getUint16(cd + 14, true)).toBe(localDate); // central DATE == local date (was 0)
  });

  it("a real `unzip -l` lists 1980-01-01 00:00, not the corrupt 00-00-1980", () => {
    const dir = mkdtempSync(join(tmpdir(), "blockdream-zip-"));
    try {
      const p = join(dir, "pack.zip");
      writeFileSync(p, zipStore(new Map([["data/ns/function/setup.mcfunction", "say hi\n"]])));
      let out: string;
      try {
        out = execFileSync("unzip", ["-l", p]).toString();
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return; // no unzip binary here; byte assertions above still gate
        throw e;
      }
      // Info-ZIP prints MM-DD-YYYY (some builds YYYY-MM-DD); either way it must be Jan 1 1980, 00:00
      expect(out).toMatch(/01-01-1980|1980-01-01/);
      expect(out).toContain("00:00");
      expect(out).not.toContain("00-00-1980");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("zipStore non-zip64 format limits", () => {
  it("accepts exactly 65535 entries and every file survives extraction", () => {
    const files = new Map<string, string>();
    for (let i = 0; i < 0xffff; i++) files.set(`f/${i}`, "");
    const zip = zipStore(files);
    expect(unzip(zip).size).toBe(0xffff);
  });

  it("throws a clear error at 65536 entries instead of silently dropping files", () => {
    const files = new Map<string, string>();
    for (let i = 0; i <= 0xffff; i++) files.set(`f/${i}`, "");
    expect(() => zipStore(files)).toThrowError(/datapack too large for zip: 65536 files \(max 65535\)/);
  });

  it("throws when an entry exceeds the uint32 size field (guard exercised via injected limit)", () => {
    const files = new Map<string, string | Uint8Array>([["big", randomBytes(2048, 7)]]);
    expect(() => zipStore(files, { maxBytes: 1024 })).toThrowError(/entry "big" is 2048 bytes \(max 1024/);
    expect(() => zipStore(files, { maxBytes: 4096 })).not.toThrow();
  });

  it("throws when the archive spans past the uint32 offset field (guard exercised via injected limit)", () => {
    // each entry fits, but the running offset crosses the injected ceiling
    const files = new Map<string, string | Uint8Array>([
      ["a", randomBytes(700, 1)],
      ["b", randomBytes(700, 2)],
    ]);
    expect(() => zipStore(files, { maxBytes: 1024 })).toThrowError(/archive spans \d+ bytes \(max 1024/);
  });
});
