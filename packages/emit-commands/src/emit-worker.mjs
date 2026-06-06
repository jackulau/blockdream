// Pure worker (node worker_threads): fill-batch a chunk of frames off the main thread.
// Dependency-free + plain JS so it runs in a worker without a TS build step. Kept in
// lockstep with fill.ts by parallel.test.ts (parallel output must equal serial output).
import { parentPort } from "node:worker_threads";

function fillBatch(cells, table) {
  const resolve = (id) => table[id] ?? "minecraft:air";
  const rows = new Map();
  for (const c of cells) {
    const k = `${c.y}|${c.z}`;
    let r = rows.get(k);
    if (!r) rows.set(k, (r = []));
    r.push(c);
  }
  const keys = [...rows.keys()].sort((a, b) => {
    const [ay, az] = a.split("|").map(Number);
    const [by, bz] = b.split("|").map(Number);
    return az - bz || ay - by;
  });
  const lines = [];
  for (const k of keys) {
    const row = rows.get(k).sort((a, b) => a.x - b.x);
    let i = 0;
    while (i < row.length) {
      const start = row[i];
      const block = resolve(start.mapColorId);
      let j = i;
      while (j + 1 < row.length && row[j + 1].x === row[j].x + 1 && resolve(row[j + 1].mapColorId) === block) j++;
      const end = row[j];
      lines.push(j > i ? `fill ${start.x} ${start.y} ${start.z} ${end.x} ${end.y} ${end.z} ${block} replace` : `setblock ${start.x} ${start.y} ${start.z} ${block} replace`);
      i = j + 1;
    }
  }
  return lines;
}

parentPort.on("message", (msg) => {
  // msg: { jobs: [{ index, cells }], table }
  const out = msg.jobs.map((j) => ({ index: j.index, lines: fillBatch(j.cells, msg.table) }));
  parentPort.postMessage(out);
});
