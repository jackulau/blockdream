import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { render } from "../src/render";
import { rotateYQuarterTurns, createVolume, setVoxel, getVoxel, countSolid, spinSequence, padXZToSquare, BAKEABLE_ANIMS } from "@blockdream/voxel";
import { DEFAULT_MAX_COMMANDS } from "@blockdream/emit-commands";
import { readMcStructure } from "@blockdream/emit-bedrock";

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

describe("--animate spin: bake a rotating-build datapack (D3)", () => {
  it("spin is a bakeable animation alongside explode/wave/buildup", () => {
    expect(BAKEABLE_ANIMS as readonly string[]).toContain("spin");
    expect(BAKEABLE_ANIMS as readonly string[]).toContain("explode");
  });

  it("padXZToSquare squares a non-cubic footprint, keeping height + every voxel", () => {
    const v = createVolume(8, 5, 2); // shallow depth (the common build shape)
    setVoxel(v, 0, 0, 0, 4);
    setVoxel(v, 7, 4, 1, 6);
    const p = padXZToSquare(v);
    expect([p.sx, p.sz]).toEqual([8, 8]); // squared to max(8,2)
    expect(p.sy).toBe(5);
    expect(countSolid(p)).toBe(countSolid(v)); // padding only adds air
  });

  it("spinSequence emits N frames that don't clip (frame 0 identity, count ~preserved)", () => {
    const v = createVolume(10, 6, 3); // non-cubic: would clip under the sampling rotateY
    for (let i = 0; i < 10; i++) setVoxel(v, i, i % 6, (i * 2) % 3, 5);
    const base = countSolid(v);
    const seq = spinSequence(v, 8);
    expect(seq.length).toBe(8);
    expect(countSolid(seq[0]!)).toBe(base); // 0° = identity (after cube-pad, padding is air)
    for (const f of seq) expect(countSolid(f)).toBeGreaterThan(base * 0.6); // rigid turn, no wholesale clip
  });

  it("render --animate spin produces a multi-frame datapack", () => {
    const res = render({ input: writeObj("sp.obj"), out: join(dir, "sp"), target: "model3d", width: 12, height: 12, animate: "spin", animateFrames: 6 });
    expect(res.frameCount).toBe(6);
  });
});

/** Every emitted .mcfunction must respect the per-function command budget and the 32768 /fill cap. */
function assertBudget(filesWritten: string[]): number {
  const fns = filesWritten.filter((f) => f.endsWith(".mcfunction"));
  let totalPlacements = 0;
  for (const f of fns) {
    const lines = readFileSync(f, "utf8").split("\n").filter((l) => /^(setblock|fill) /.test(l));
    totalPlacements += lines.length;
    expect(lines.length, `${f} within per-function budget`).toBeLessThanOrEqual(DEFAULT_MAX_COMMANDS);
    for (const l of lines) {
      const m = /^fill (-?\d+) (-?\d+) (-?\d+) (-?\d+) (-?\d+) (-?\d+)/.exec(l);
      if (m) {
        const vol = (Math.abs(+m[4]! - +m[1]!) + 1) * (Math.abs(+m[5]! - +m[2]!) + 1) * (Math.abs(+m[6]! - +m[3]!) + 1);
        expect(vol, `${l} within 32768 /fill cap`).toBeLessThanOrEqual(32768);
      }
    }
  }
  return totalPlacements;
}

describe("--origin stamps the Bedrock .mcstructure world origin (044 D2)", () => {
  it("structure_world_origin equals the supplied origin", () => {
    const O = { x: 12, y: 70, z: -8 };
    const res = render({ input: writeObj("so.obj"), out: join(dir, "so"), target: "model3d", edition: "bedrock", width: 10, height: 10, origin: O });
    const sf = res.filesWritten.find((f) => f.endsWith(".mcstructure"))!;
    expect(readMcStructure(readFileSync(sf)).origin).toEqual([12, 70, -8]);
  });

  it("defaults to 0,0,0 when --origin omitted", () => {
    const res = render({ input: writeObj("sd.obj"), out: join(dir, "sd"), target: "model3d", edition: "bedrock", width: 10, height: 10 });
    const sf = res.filesWritten.find((f) => f.endsWith(".mcstructure"))!;
    expect(readMcStructure(readFileSync(sf)).origin).toEqual([0, 0, 0]);
  });
});

describe("larger builds hold up: budgets + new controls compose at scale (D4)", () => {
  it("a large 64³ build emits a valid datapack within every command budget", () => {
    const res = render({ input: writeObj("big.obj"), out: join(dir, "big"), target: "model3d", width: 64, height: 64 });
    expect(res.filesWritten.length).toBeGreaterThan(0);
    expect(assertBudget(res.filesWritten)).toBeGreaterThan(0); // real, non-trivial build
  });

  it("origin + facing + spin all compose on a larger build (no clip, budgets hold, origin respected)", () => {
    const O = { x: 200, y: 80, z: -100 };
    const res = render({
      input: writeObj("big2.obj"), out: join(dir, "big2"), target: "model3d",
      width: 40, height: 40, origin: O, facing: "east", animate: "spin", animateFrames: 4,
    });
    expect(res.frameCount).toBe(4);
    assertBudget(res.filesWritten);
    const cs = coords(res.filesWritten);
    expect(Math.min(...cs.map((c) => c.x))).toBeGreaterThanOrEqual(O.x); // origin honoured under facing+spin
    expect(Math.min(...cs.map((c) => c.y))).toBeGreaterThanOrEqual(O.y);
  }, 20000);

  it("a larger --animate spin build emits a valid datapack within budget (exercises optimized spinSequence)", () => {
    const res = render({ input: writeObj("spinbig.obj"), out: join(dir, "spinbig"), target: "model3d", width: 40, height: 40, animate: "spin", animateFrames: 6 });
    expect(res.frameCount).toBe(6);
    expect(assertBudget(res.filesWritten)).toBeGreaterThan(0);
  }, 15000);

  it("a large non-cubic build spins without exploding the voxel count beyond its swept footprint", () => {
    const v = createVolume(96, 48, 6); // wide, shallow - the real build shape
    for (let i = 0; i < 96; i += 3) setVoxel(v, i, i % 48, i % 6, 5);
    const seq = spinSequence(v, 8);
    // cube-pads X/Z to 96 (the swept radius), NOT to a 96³ over-pad of Y
    expect([seq[0]!.sx, seq[0]!.sy, seq[0]!.sz]).toEqual([96, 48, 96]);
    expect(countSolid(seq[0]!)).toBe(countSolid(v)); // identity frame loses nothing
  });
});
