import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PALETTE_DATA } from "./versions";

export * from "./versions";

/** A single renderable Minecraft map color. */
export interface MapColor {
  /** Full map color id written into the map `colors` byte array: baseId*4 + shadeIndex. */
  mapColorId: number;
  /** Base color id (1..61 for 1.21.x; 0 = NONE/transparent, excluded here). */
  baseId: number;
  /** Shade index 0..3 → multiplier [180, 220, 255, 135]. */
  shadeIndex: number;
  /** The shade multiplier applied to the base RGB (out of 255). */
  mult: number;
  r: number;
  g: number;
  b: number;
}

export interface MapPalette {
  edition: "java" | "bedrock";
  version: string;
  source: string;
  shadeMultipliers: number[];
  baseCount: number;
  usableColorCount: number;
  note: string;
  colors: MapColor[];
}

const DATA_DIR = fileURLToPath(new URL("../data/", import.meta.url));

const cache = new Map<string, MapPalette>();

/**
 * Resolve a requested version to the palette data file that carries those colors.
 * Tries `<prefix>-<version>.json` first (so a future version-specific file wins
 * if added later), then falls back to the canonical file for the supported line.
 * The map-color table and solid-block colors are stable across all of 1.21.x, so
 * any patch version aliases cleanly to the canonical file instead of an ENOENT.
 */
function resolveFileKey(prefix: string, version: string, canonical: string): string {
  const candidates = version === canonical ? [version] : [version, canonical];
  for (const v of candidates) {
    const fileKey = `${prefix}-${v}`;
    if (existsSync(`${DATA_DIR}${fileKey}.json`)) return fileKey;
  }
  throw new Error(`no palette data for ${prefix} version "${version}" (have "${canonical}")`);
}

function loadJson<T>(fileKey: string): T {
  return JSON.parse(readFileSync(`${DATA_DIR}${fileKey}.json`, "utf8")) as T;
}

/**
 * Load the Java map-color palette for a pinned version (default 1.21.9).
 *
 * These are the colors written directly into a filled map's `colors` byte array.
 * Because we author that array ourselves, the game does NOT biome-tint them — all
 * 244 ids (61 bases × 4 shades) are usable verbatim on both Java and Bedrock.
 */
export function getJavaMapPalette(version = PALETTE_DATA.javaMap): MapPalette {
  const fileKey = resolveFileKey("java-map-colors", version, PALETTE_DATA.javaMap);
  const hit = cache.get(fileKey);
  if (hit) return hit;
  const parsed = loadJson<MapPalette>(fileKey);
  cache.set(fileKey, parsed);
  return parsed;
}

/** Map color id → MapColor lookup for a palette. */
export function indexByMapColorId(p: MapPalette): Map<number, MapColor> {
  return new Map(p.colors.map((c) => [c.mapColorId, c]));
}

/**
 * Load the Bedrock map-color palette. Filled-map color indices are shared across
 * editions, and direct-written maps are not biome-tinted on either edition, so
 * this is the same RGB table as Java — verified equal by test.
 */
export function getBedrockMapPalette(version = PALETTE_DATA.bedrockMap): MapPalette {
  const fileKey = resolveFileKey("bedrock-map-colors", version, PALETTE_DATA.bedrockMap);
  const hit = cache.get(fileKey);
  if (hit) return hit;
  const parsed = loadJson<MapPalette>(fileKey);
  cache.set(fileKey, parsed);
  return parsed;
}

/**
 * The cross-edition INTERSECTION for the direct-write map path: the set of map
 * colors that render identically on Java and Bedrock. Because we author the
 * `colors` array ourselves (no biome tint), this is the full shared table.
 * Throws if the two editions' RGB tables ever diverge for a shared id.
 */
export function getCrossEditionMapPalette(version = "1.21"): MapPalette {
  const java = getJavaMapPalette("1.21.9");
  const bedrock = getBedrockMapPalette(version);
  const bj = indexByMapColorId(bedrock);
  for (const c of java.colors) {
    const b = bj.get(c.mapColorId);
    if (!b || b.r !== c.r || b.g !== c.g || b.b !== c.b) {
      throw new Error(`cross-edition divergence at mapColorId ${c.mapColorId}`);
    }
  }
  return { ...java, edition: "java", source: "cross-edition intersection (java≡bedrock)" };
}

// --- Block-build palette (placed solid blocks, not map items) ---------------

export interface BlockEntry {
  displayName: string;
  /** Namespaced block id, e.g. "minecraft:white_concrete" (shared Java/Bedrock for the solid set). */
  id: string;
  args: Record<string, string>;
  supportRequired: boolean;
  flammable: boolean;
  /** Biome-tinted on BOTH editions when placed → excluded from the cross-edition solid set. */
  biomeDependent: boolean;
}

export interface BlockBase {
  /** cerus map baseId (1..61). */
  baseId: number;
  mapartKey: number;
  rgb: { r: number; g: number; b: number };
  representative: BlockEntry | null;
  blockCount: number;
  blocks: BlockEntry[];
}

export interface BlockPalette {
  edition: string;
  version: string;
  source: string;
  baseCount: number;
  note: string;
  bases: BlockBase[];
}

// --- Full solid-block color palette (wide gamut, from texture averages) -----

export interface BlockColor {
  id: string;
  name: string;
  r: number;
  g: number;
  b: number;
  /** texture variance (high = noisy/patterned; prefer low for clean pixel art). */
  noise: number;
  family: string;
}

export interface BlockColorPalette {
  edition: string;
  version: string;
  source: string;
  note: string;
  count: number;
  blocks: BlockColor[];
}

/** The wide-gamut biome-independent solid-block color set (~301 blocks). */
export function getFullBlockColorPalette(version = PALETTE_DATA.block): BlockColorPalette {
  const fileKey = resolveFileKey("java-block-colors", version, PALETTE_DATA.block);
  const hit = cache.get(fileKey) as unknown as BlockColorPalette | undefined;
  if (hit) return hit;
  const parsed = loadJson<BlockColorPalette>(fileKey);
  cache.set(fileKey, parsed as unknown as MapPalette);
  return parsed;
}

/**
 * The full solid-block set shaped as a MapPalette for the color-core matcher.
 * `mapColorId` carries the block's index so the caller recovers which block to
 * place (it is NOT a map-item color id — this is the block-build path).
 */
export function getFullBlockMapPalette(version = "1.21"): {
  palette: MapPalette;
  blockByMapColorId: Map<number, BlockColor>;
} {
  const bp = getFullBlockColorPalette(version);
  const colors: MapColor[] = [];
  const blockByMapColorId = new Map<number, BlockColor>();
  bp.blocks.forEach((blk, i) => {
    colors.push({ mapColorId: i, baseId: i, shadeIndex: 2, mult: 255, r: blk.r, g: blk.g, b: blk.b });
    blockByMapColorId.set(i, blk);
  });
  return {
    palette: {
      edition: "java",
      version,
      source: bp.source,
      shadeMultipliers: [180, 220, 255, 135],
      baseCount: colors.length,
      usableColorCount: colors.length,
      note: "full solid-block build palette (wide gamut); mapColorId = block index",
      colors,
    },
    blockByMapColorId,
  };
}

export function getJavaBlockPalette(version = PALETTE_DATA.block): BlockPalette {
  const fileKey = resolveFileKey("java-block-palette", version, PALETTE_DATA.block);
  const hit = cache.get(fileKey) as unknown as BlockPalette | undefined;
  if (hit) return hit;
  const parsed = loadJson<BlockPalette>(fileKey);
  cache.set(fileKey, parsed as unknown as MapPalette);
  return parsed;
}

/**
 * The cross-edition-safe SOLID block set, shaped as a MapPalette so it can be fed
 * straight into the color-core matcher. One entry per base that has a
 * biome-independent, support-free solid block (concrete/wool/terracotta/etc),
 * using the block's full (×255) base color. `mapColorId` carries the base's
 * full-shade map color id so the caller can recover which block to place.
 *
 * (Flat builds only — staircased 4-shade block mapart is a later refinement.)
 */
export function getSolidBlockMapPalette(version = "1.21"): {
  palette: MapPalette;
  blockByMapColorId: Map<number, BlockEntry>;
} {
  const bp = getJavaBlockPalette(version);
  const colors: MapColor[] = [];
  const blockByMapColorId = new Map<number, BlockEntry>();
  for (const base of bp.bases) {
    const block =
      base.representative && !base.representative.biomeDependent && !base.representative.supportRequired
        ? base.representative
        : base.blocks.find((b) => !b.biomeDependent && !b.supportRequired) ?? null;
    if (!block) continue;
    const mapColorId = base.baseId * 4 + 2; // full (×255) shade
    colors.push({ mapColorId, baseId: base.baseId, shadeIndex: 2, mult: 255, ...base.rgb });
    blockByMapColorId.set(mapColorId, block);
  }
  return {
    palette: {
      edition: "java",
      version,
      source: "cross-edition solid-block set (biome-independent, support-free)",
      shadeMultipliers: [180, 220, 255, 135],
      baseCount: colors.length,
      usableColorCount: colors.length,
      note: "flat solid-block build palette; pair with shade multipliers for staircased mapart",
      colors,
    },
    blockByMapColorId,
  };
}
