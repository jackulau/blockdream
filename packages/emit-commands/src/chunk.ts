/**
 * Per-function command budget. A frame whose `setblock` count exceeds this is
 * split into chained sub-functions to avoid a single oversized function (which
 * stresses `maxCommandChainLength` and per-tick execution). Conservative default.
 */
export const DEFAULT_MAX_COMMANDS = 8000;

export function chunk<T>(arr: T[], size: number): T[][] {
  if (size <= 0) throw new Error("chunk size must be > 0");
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * Write a function body that may exceed the per-function command limit.
 *
 * - If `bodyLines.length <= limit`: writes a single `<basePath>.mcfunction`.
 * - Else: writes `<basePath>/part<k>.mcfunction` chunks and a parent
 *   `<basePath>.mcfunction` that calls each part via `partRef(k)`.
 *
 * `basePath` is the file path WITHOUT the `.mcfunction` extension.
 * Returns the number of sub-functions written for the body (0 if single, else N parts).
 */
export function writeSplitFunction(
  files: Map<string, string>,
  basePath: string,
  bodyLines: string[],
  limit: number,
  partRef: (partIndex: number) => string,
  header?: string,
): number {
  const head = header ? header + "\n" : "";
  if (bodyLines.length <= limit) {
    files.set(`${basePath}.mcfunction`, head + bodyLines.join("\n") + "\n");
    return 0;
  }
  const parts = chunk(bodyLines, limit);
  parts.forEach((p, k) => {
    files.set(`${basePath}/part${k}.mcfunction`, `# part ${k}/${parts.length}\n` + p.join("\n") + "\n");
  });
  const parent = [header, ...parts.map((_, k) => partRef(k))].filter(Boolean).join("\n") + "\n";
  files.set(`${basePath}.mcfunction`, parent);
  return parts.length;
}
