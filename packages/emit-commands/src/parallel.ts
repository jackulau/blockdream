// Multi-core emission: spread the CPU-bound per-frame work (fill-batching) across real
// OS threads (node worker_threads), then merge in frame order. Output is byte-identical
// to the serial path — parallelism is an efficiency win, never a correctness change.
// (The browser viewer uses vite-native Workers for the same effect in-page.)

import { Worker } from "node:worker_threads";
import { cpus } from "node:os";
import { fillBatch, type PlacedCell } from "./fill";

const WORKER_URL = new URL("./emit-worker.mjs", import.meta.url);

export interface ParallelOptions {
  concurrency?: number; // default = cpus-1 (min 1)
  parallel?: boolean; // default true; false → serial
}

/** In-process ordered concurrent map (deterministic; serial-identical). */
export async function parallelMap<T, R>(items: T[], fn: (item: T, index: number) => R | Promise<R>, concurrency = 4): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!, i);
    }
  };
  const lanes = Math.max(1, Math.min(concurrency, items.length || 1));
  await Promise.all(Array.from({ length: lanes }, worker));
  return out;
}

/**
 * Fill-batch many frames across worker threads, merged back in frame order. Identical to
 * `frames.map(cells => fillBatch(cells, …))`, just spread over cores. Serial fallback when
 * parallel is off, there's ≤1 frame, or only one lane is requested.
 */
export async function fillBatchFrames(
  frames: PlacedCell[][],
  table: Record<number, string>,
  opts: ParallelOptions = {},
): Promise<string[][]> {
  const resolve = (id: number) => table[id] ?? "minecraft:air";
  const n = Math.max(1, opts.concurrency ?? Math.max(1, cpus().length - 1));
  if (opts.parallel === false || frames.length <= 1 || n === 1) {
    return frames.map((cells) => fillBatch(cells, resolve));
  }

  // round-robin frames into n worker buckets
  const buckets: Array<Array<{ index: number; cells: PlacedCell[] }>> = Array.from({ length: n }, () => []);
  frames.forEach((cells, index) => buckets[index % n]!.push({ index, cells }));

  const results: string[][] = new Array(frames.length);
  await Promise.all(
    buckets
      .filter((b) => b.length > 0)
      .map(
        (jobs) =>
          new Promise<void>((resolve2, reject) => {
            const w = new Worker(WORKER_URL);
            w.once("message", (out: Array<{ index: number; lines: string[] }>) => {
              for (const r of out) results[r.index] = r.lines;
              void w.terminate().then(() => resolve2(), reject);
            });
            w.once("error", reject);
            w.postMessage({ jobs, table });
          }),
      ),
  );
  return results;
}
