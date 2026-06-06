// Node-only: write a generated pack's file map to disk. Kept out of the pure index so the
// generators (generateJavaDatapack, generateVoxelDatapack) stay importable in the browser.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { GeneratedPack } from "./datapack";

/** Write a generated pack's file map to disk under destDir. */
export function writePack(pack: GeneratedPack, destDir: string): void {
  for (const [rel, content] of pack.files) {
    const abs = join(destDir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
}
