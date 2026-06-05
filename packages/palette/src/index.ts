import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

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
 * Load the Java map-color palette for a pinned version (default 1.21.9).
 *
 * These are the colors written directly into a filled map's `colors` byte array.
 * Because we author that array ourselves, the game does NOT biome-tint them — all
 * 244 ids (61 bases × 4 shades) are usable verbatim on both Java and Bedrock.
 */
export function getJavaMapPalette(version = "1.21.9"): MapPalette {
  const key = `java-map-colors-${version}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const raw = readFileSync(`${DATA_DIR}${key}.json`, "utf8");
  const parsed = JSON.parse(raw) as MapPalette;
  cache.set(key, parsed);
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
export function getBedrockMapPalette(version = "1.21"): MapPalette {
  const key = `bedrock-map-colors-${version}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const raw = readFileSync(`${DATA_DIR}${key}.json`, "utf8");
  const parsed = JSON.parse(raw) as MapPalette;
  cache.set(key, parsed);
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

export function getJavaBlockPalette(version = "1.21"): BlockPalette {
  const key = `java-block-palette-${version}`;
  const hit = cache.get(key) as BlockPalette | undefined;
  if (hit) return hit;
  const raw = readFileSync(`${DATA_DIR}${key}.json`, "utf8");
  const parsed = JSON.parse(raw) as BlockPalette;
  cache.set(key, parsed as unknown as MapPalette);
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
