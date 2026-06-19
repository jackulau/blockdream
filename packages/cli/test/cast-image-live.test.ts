import { describe, it, expect } from "vitest";
import { castImageFrames, frameToWallCommands, type WallFrame } from "../src/rcon-bridge";

// synthetic RGB frame: cb(x,y) → [r,g,b]
function rgbFrame(w: number, h: number, cb: (x: number, y: number) => [number, number, number]): WallFrame {
  const pixels = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const [r, g, b] = cb(x, y);
      const i = (y * w + x) * 3;
      pixels[i] = r;
      pixels[i + 1] = g;
      pixels[i + 2] = b;
    }
  return { width: w, height: h, pixels };
}

const RED: [number, number, number] = [220, 20, 20];
const BLUE: [number, number, number] = [20, 20, 220];
const ORIGIN = { x: 0, y: 64, z: 0 };

describe("castImageFrames (cast a static image / animation live)", () => {
  it("paints each frame once in order for a single loop", async () => {
    const frames = ["a", "b", "c"];
    const seen: Array<{ f: string; i: number }> = [];
    const n = await castImageFrames(frames, async (f, i) => {
      seen.push({ f, i });
    });
    expect(n).toBe(3);
    expect(seen).toEqual([{ f: "a", i: 0 }, { f: "b", i: 1 }, { f: "c", i: 2 }]);
  });

  it("repeats the sequence --loops times with a continuous paint index", async () => {
    const seen: number[] = [];
    const n = await castImageFrames(["a", "b"], async (_f, i) => {
      seen.push(i);
    }, { loops: 3 });
    expect(n).toBe(6);
    expect(seen).toEqual([0, 1, 2, 3, 4, 5]); // index keeps climbing across loops (delta stays continuous)
  });

  it("loops <= 0 runs endlessly until shouldStop", async () => {
    let count = 0;
    const n = await castImageFrames(["a", "b"], async () => {
      count++;
    }, { loops: 0, shouldStop: () => count >= 5 });
    expect(n).toBe(5); // stopped mid-stream, not infinite
  });

  it("paces frames at --fps using the injected clock/sleep (not the last frame)", async () => {
    const slept: number[] = [];
    let clock = 0;
    await castImageFrames(["a", "b", "c"], async () => {
      clock += 10; // each paint "takes" 10ms
    }, {
      fps: 20, // 50ms/frame
      now: () => clock,
      sleep: async (ms) => {
        slept.push(ms);
        clock += ms;
      },
    });
    // 2 inter-frame sleeps (not after the final frame), each 50 - 10 = 40ms
    expect(slept).toEqual([40, 40]);
  });

  it("throws on an empty frame list", async () => {
    await expect(castImageFrames([], async () => {})).rejects.toThrow(/no frames/);
  });

  it("drives a real delta animation: frame 0 is a full keyframe, frame 1 a smaller delta", async () => {
    const W = 12, H = 12;
    // checkerboard keyframe → adjacent cells differ → greedy-box can't merge → many commands
    const a = rgbFrame(W, H, (x, y) => (((x + y) & 1) ? RED : BLUE));
    // same board with cell (0,0) flipped (BLUE → RED) → exactly one changed cell vs `a`
    const b = rgbFrame(W, H, (x, y) => (x === 0 && y === 0 ? RED : ((x + y) & 1) ? RED : BLUE));
    let prev: WallFrame | undefined;
    const counts: number[] = [];
    await castImageFrames([a, b], async (frame) => {
      const wall = frameToWallCommands(frame, ORIGIN, prev, { dither: "none" });
      counts.push(wall.commands.length);
      prev = frame;
    });
    expect(counts[0]).toBeGreaterThan(10); // keyframe paints the whole (un-mergeable) wall
    expect(counts[1]).toBeLessThan(counts[0]!); // frame 1 is a delta, far smaller
    expect(counts[1]).toBe(1); // exactly the one changed cell
  });
});
