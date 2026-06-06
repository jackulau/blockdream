// Pure worker (node worker_threads): fill-batch a chunk of frames off the main thread.
// The algorithm is single-sourced in fill-batch.mjs (imported here AND by fill.ts), so the
// parallel path can never drift from the serial path. parallel.test.ts asserts byte-identity.
import { parentPort } from "node:worker_threads";
import { fillBatch } from "./fill-batch.mjs";

parentPort.on("message", (msg) => {
  // msg: { jobs: [{ index, cells }], table }
  const resolve = (id) => msg.table[id] ?? "minecraft:air";
  const out = msg.jobs.map((j) => ({ index: j.index, lines: fillBatch(j.cells, resolve) }));
  parentPort.postMessage(out);
});
