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
