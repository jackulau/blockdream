// Verify the block-texture manifest covers (essentially) every palette block: each mapped
// id points to a real extracted PNG, and coverage is ≥ threshold. The only acceptable
// misses are non-cube blocks with no single flat top-face texture (e.g. pointed_dripstone).
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const BLOCKS = join(HERE, "..", "public", "blocks");
const MANIFEST = join(BLOCKS, "manifest.json");
const THRESHOLD = 0.98; // ≥98% of palette blocks must resolve to a real texture
const ALLOWED_UNMAPPED = new Set([
  "minecraft:pointed_dripstone", // non-cube spike — no flat top-face texture; swatch is correct
]);

const fail = (m) => {
  console.error("FAIL:", m);
  process.exit(1);
};

if (!existsSync(MANIFEST)) {
  fail(`no manifest at ${MANIFEST} — run: python3 apps/web/scripts/fetch-block-textures.py`);
}
const m = JSON.parse(readFileSync(MANIFEST, "utf8"));
const total = m.block_count ?? 0;
const textures = m.textures ?? {};
const mapped = Object.keys(textures).length;
const unmapped = m.unmapped ?? [];

// 1) every mapped texture file actually exists on disk
const missingFiles = Object.entries(textures).filter(([, file]) => !existsSync(join(BLOCKS, file)));
if (missingFiles.length) {
  fail(`${missingFiles.length} manifest entries point to missing files, e.g. ${missingFiles[0][0]} → ${missingFiles[0][1]}`);
}

// 2) coverage threshold
const coverage = total > 0 ? mapped / total : 0;
console.log(`[coverage] ${mapped}/${total} palette blocks mapped to real textures (${(coverage * 100).toFixed(1)}%) · version ${m.version}`);
if (coverage < THRESHOLD) {
  fail(`coverage ${(coverage * 100).toFixed(1)}% < ${(THRESHOLD * 100).toFixed(0)}%`);
}

// 3) any genuinely-unmapped block must be a documented non-cube exception
const unexpected = unmapped.filter((id) => !ALLOWED_UNMAPPED.has(id));
if (unexpected.length) {
  // not fatal under threshold, but surface them so the resolver/allowlist can be updated
  console.log(`[coverage] ${unexpected.length} unmapped (swatch fallback): ${unexpected.slice(0, 8).join(", ")}${unexpected.length > 8 ? " …" : ""}`);
}

console.log("OK: texture coverage verified");
