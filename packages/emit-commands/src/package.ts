// Package generated packs into ready-to-drop archives:
//  - Java datapack  → store-only .zip (drop into <world>/datapacks/, then /reload)
//  - Bedrock pack   → .mcpack (a store-only zip; double-click to import into the game)
// Both validate by round-trip (zip → unzip → structure check) in package.test.ts.

import { zipStore, unzipText } from "./zip";

export interface PackLike {
  files: Map<string, string>;
}

/** Java datapack .zip. The zip IS the datapack: drop it straight into <world>/datapacks/. */
export function packageJavaDatapack(pack: PackLike): Uint8Array {
  return zipStore(pack.files);
}

/**
 * Bedrock .mcpack (store-only zip). `stripPrefix` lets a pack whose files live under a
 * folder (e.g. the Script addon's "behavior_pack/") be repackaged so manifest.json sits at
 * the archive root, which is what Bedrock's importer expects.
 */
export function packageMcpack(files: Map<string, string>, opts: { stripPrefix?: string } = {}): Uint8Array {
  const strip = opts.stripPrefix;
  if (!strip) return zipStore(files);
  const out = new Map<string, string>();
  for (const [k, v] of files) out.set(k.startsWith(strip) ? k.slice(strip.length) : k, v);
  return zipStore(out);
}

export interface ArchiveCheck {
  ok: boolean;
  errors: string[];
}

/** Structural validation of a Java datapack archive: pack.mcmeta at root + a tick tag. */
export function validateJavaDatapackArchive(bytes: Uint8Array): ArchiveCheck {
  const errors: string[] = [];
  const files = unzipText(bytes);
  if (!files.has("pack.mcmeta")) errors.push("missing pack.mcmeta at archive root");
  else {
    try {
      const fmt = JSON.parse(files.get("pack.mcmeta")!).pack?.pack_format;
      if (typeof fmt !== "number") errors.push("pack.mcmeta has no numeric pack_format");
    } catch {
      errors.push("pack.mcmeta is not valid JSON");
    }
  }
  if (![...files.keys()].some((k) => k === "data/minecraft/tags/function/tick.json")) {
    errors.push("missing data/minecraft/tags/function/tick.json (driver is never invoked)");
  }
  if (![...files.keys()].some((k) => /^data\/[a-z0-9_-]+\/function\/.+\.mcfunction$/.test(k))) {
    errors.push("no namespaced .mcfunction files");
  }
  return { ok: errors.length === 0, errors };
}

/** Structural validation of a Bedrock .mcpack archive: manifest.json with header+module UUIDs at root. */
export function validateBedrockMcpackArchive(bytes: Uint8Array): ArchiveCheck {
  const errors: string[] = [];
  const files = unzipText(bytes);
  if (!files.has("manifest.json")) {
    errors.push("missing manifest.json at archive root (Bedrock importer needs it there)");
    return { ok: false, errors };
  }
  try {
    const m = JSON.parse(files.get("manifest.json")!);
    if (m.format_version !== 2) errors.push("manifest format_version must be 2");
    if (!m.header?.uuid) errors.push("manifest header.uuid missing");
    if (!Array.isArray(m.modules) || !m.modules[0]?.uuid) errors.push("manifest modules[0].uuid missing");
  } catch {
    errors.push("manifest.json is not valid JSON");
  }
  return { ok: errors.length === 0, errors };
}
