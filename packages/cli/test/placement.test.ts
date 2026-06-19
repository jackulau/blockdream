import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { render } from "../src/render";
import { rotateYQuarterTurns, createVolume, setVoxel, getVoxel, countSolid } from "@blockdream/voxel";

// goal 043: users designate how a build spawns in Minecraft - origin COORDINATES (D1) and
// facing DIRECTION (D2). Uses the model3d cube path (no image decode) for fast determinism.

const CUBE_OBJ = `
v 0 0 0 0.8 0.1 0.1
v 1 0 0 0.8 0.1 0.1
v 1 1 0 0.1 0.1 0.8
v 0 1 0 0.1 0.1 0.8
v 0 0 1 0.8 0.1 0.1
v 1 0 1 0.8 0.1 0.1
v 1 1 1 0.1 0.1 0.8
v 0 1 1 0.1 0.1 0.8
f 1 2 3
f 1 3 4
f 5 6 7
f 5 7 8
f 1 5 8
f 1 8 4
f 2 6 7
f 2 7 3
f 4 3 7
f 4 7 8
f 1 2 6
f 1 6 5
`;

const dir = mkdtempSync(join(tmpdir(), "bd-placement-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function writeObj(name: string): string {
  const p = join(dir, name);
  writeFileSync(p, CUBE_OBJ);
  return p;
}
/** All setblock/fill anchor coords across a render's .mcfunction files. */
function coords(filesWritten: string[]): Array<{ x: number; y: number; z: number }> {
  const body = filesWritten
    .filter((f) => f.endsWith(".mcfunction"))
    .map((f) => readFileSync(f, "utf8"))
    .join("\n");
  const out: Array<{ x: number; y: number; z: number }> = [];
  for (const m of body.matchAll(/^(?:setblock|fill) (-?\d+) (-?\d+) (-?\d+)/gm)) {
    out.push({ x: +m[1]!, y: +m[2]!, z: +m[3]! });
  }
  return out;
}
const framesBody = (filesWritten: string[]): string =>
  readFileSync(filesWritten.find((f) => /frames/.test(f) && f.endsWith(".mcfunction"))!, "utf8");

describe("--origin: build spawns at the designated coordinates (D1)", () => {
  it("shifts the whole datapack build to the origin corner", () => {
    const O = { x: 100, y: 70, z: -50 };
    const res = render({ input: writeObj("o.obj"), out: join(dir, "o"), target: "model3d", width: 10, height: 10, origin: O });
    const cs = coords(res.filesWritten);
    expect(cs.length).toBeGreaterThan(0);
    for (const c of cs) {
      expect(c.x).toBeGreaterThanOrEqual(O.x);
      expect(c.y).toBeGreaterThanOrEqual(O.y);
      expect(c.z).toBeGreaterThanOrEqual(O.z);
    }
    // the build's min corner sits exactly at the origin
    expect(Math.min(...cs.map((c) => c.x))).toBe(O.x);
    expect(Math.min(...cs.map((c) => c.y))).toBe(O.y);
    expect(Math.min(...cs.map((c) => c.z))).toBe(O.z);
  });

  it("defaults to 0,64,0 when --origin is omitted", () => {
    const res = render({ input: writeObj("d.obj"), out: join(dir, "d"), target: "model3d", width: 10, height: 10 });
    const cs = coords(res.filesWritten);
    expect(Math.min(...cs.map((c) => c.x))).toBe(0);
    expect(Math.min(...cs.map((c) => c.y))).toBe(64);
    expect(Math.min(...cs.map((c) => c.z))).toBe(0);
  });
});

describe("rotateYQuarterTurns: exact, lossless yaw (D2 core)", () => {
  it("odd turns swap the X/Z footprint and preserve every voxel (no clip)", () => {
    const v = createVolume(4, 2, 6); // W×H×D, deliberately non-cubic
    setVoxel(v, 0, 0, 0, 5);
    setVoxel(v, 3, 1, 5, 7);
    setVoxel(v, 1, 0, 2, 9);
    const r1 = rotateYQuarterTurns(v, 1);
    expect([r1.sx, r1.sy, r1.sz]).toEqual([6, 2, 4]); // footprint swapped
    expect(countSolid(r1)).toBe(countSolid(v)); // lossless
    const r3 = rotateYQuarterTurns(v, 3);
    expect([r3.sx, r3.sy, r3.sz]).toEqual([6, 2, 4]);
    expect(countSolid(r3)).toBe(countSolid(v));
    const r2 = rotateYQuarterTurns(v, 2);
    expect([r2.sx, r2.sy, r2.sz]).toEqual([4, 2, 6]); // 180° keeps dims
    expect(countSolid(r2)).toBe(countSolid(v));
  });

  it("four quarter-turns return voxel-for-voxel identity", () => {
    const v = createVolume(4, 3, 5);
    setVoxel(v, 0, 0, 0, 3);
    setVoxel(v, 3, 2, 4, 8);
    setVoxel(v, 2, 1, 1, 4);
    let r = v;
    for (let i = 0; i < 4; i++) r = rotateYQuarterTurns(r, 1);
    expect([r.sx, r.sy, r.sz]).toEqual([4, 3, 5]);
    for (let z = 0; z < 5; z++)
      for (let y = 0; y < 3; y++)
        for (let x = 0; x < 4; x++) expect(getVoxel(r, x, y, z)).toBe(getVoxel(v, x, y, z));
  });

  it("turns is taken mod 4 (0 = identity)", () => {
    const v = createVolume(3, 3, 3);
    setVoxel(v, 0, 1, 2, 6);
    expect(rotateYQuarterTurns(v, 0)).toBe(v);
    expect(rotateYQuarterTurns(v, 4).sx).toBe(3);
  });
});

describe("--facing: orient the build (D2)", () => {
  it("each direction renders a valid build; rotated facings differ from south", () => {
    const south = render({ input: writeObj("fs.obj"), out: join(dir, "fs"), target: "model3d", width: 12, height: 8, facing: "south" });
    const east = render({ input: writeObj("fe.obj"), out: join(dir, "fe"), target: "model3d", width: 12, height: 8, facing: "east" });
    const north = render({ input: writeObj("fn.obj"), out: join(dir, "fn"), target: "model3d", width: 12, height: 8, facing: "north" });
    for (const r of [south, east, north]) expect(coords(r.filesWritten).length).toBeGreaterThan(0);
    // a static yaw changes where the blocks land
    expect(framesBody(east.filesWritten)).not.toBe(framesBody(south.filesWritten));
    expect(framesBody(north.filesWritten)).not.toBe(framesBody(south.filesWritten));
  });

  it("default (no --facing) equals explicit south", () => {
    const def = render({ input: writeObj("fd.obj"), out: join(dir, "fd"), target: "model3d", width: 10, height: 10 });
    const south = render({ input: writeObj("fsd.obj"), out: join(dir, "fsd"), target: "model3d", width: 10, height: 10, facing: "south" });
    expect(framesBody(def.filesWritten)).toBe(framesBody(south.filesWritten));
  });
});
