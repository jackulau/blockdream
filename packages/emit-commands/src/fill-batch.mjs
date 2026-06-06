// Single source of the X-run fill-batch algorithm. Plain JS so the worker thread
// (emit-worker.mjs) can import it with no TS build step; fill.ts re-exports it as the typed
// `fillBatch`. Collapses contiguous same-block runs along X into one `/fill`; singletons stay
// `/setblock`. Deterministic z→y→x ordering. (greedyBoxes in fill.ts is the stronger 3D merge;
// this X-only pass is what the parallel worker pool uses.)

export function fillBatch(cells, resolve) {
  const rows = new Map(); // (y,z) -> cells
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
      lines.push(
        j > i
          ? `fill ${start.x} ${start.y} ${start.z} ${end.x} ${end.y} ${end.z} ${block} replace`
          : `setblock ${start.x} ${start.y} ${start.z} ${block} replace`,
      );
      i = j + 1;
    }
  }
  return lines;
}
