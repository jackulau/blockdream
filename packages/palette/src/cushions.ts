/**
 * Cushions (Java 26.3 Snapshot 3) - EXPERIMENTAL, snapshot-only, honestly scoped.
 *
 * What the snapshot actually ships (see docs/cushions-26.3.md, wiki-sourced):
 * cushions are ENTITIES (entity id `cushion`, color as entity data), flat 0.25-tall
 * pads that sit only on TOP of horizontal surfaces, in the 16 dye colors. They are
 * NOT blocks: no vertical placement, no documented map color, no light behavior.
 * A cushion pixel WALL is therefore impossible; the closest honest visualization is
 * a top-down FLOOR MOSAIC - one summoned cushion per pixel - which this module
 * generates. Everything here is gated behind an explicit experimental opt-in and
 * deliberately kept OUT of the release version registry (versions.ts stays
 * release-only; snapshot formats churn weekly).
 */

export interface CushionColor {
  /** dye name = the `color` entity-data string, e.g. "light_blue" */
  color: string;
  /** item id in the snapshot, e.g. "light_blue_cushion" */
  itemId: string;
  /** approximate sRGB - the wool/dye base map colors. The wiki does NOT publish the
   *  cushion textures' RGB values, so this is a labeled approximation for matching. */
  rgb: readonly [number, number, number];
}

/** All 16 cushion colors (full dye set), as documented on the wiki for Snapshot 3. */
export const CUSHION_COLORS: readonly CushionColor[] = [
  { color: "white", itemId: "white_cushion", rgb: [249, 255, 254] },
  { color: "orange", itemId: "orange_cushion", rgb: [249, 128, 29] },
  { color: "magenta", itemId: "magenta_cushion", rgb: [199, 78, 189] },
  { color: "light_blue", itemId: "light_blue_cushion", rgb: [58, 179, 218] },
  { color: "yellow", itemId: "yellow_cushion", rgb: [254, 216, 61] },
  { color: "lime", itemId: "lime_cushion", rgb: [128, 199, 31] },
  { color: "pink", itemId: "pink_cushion", rgb: [243, 139, 170] },
  { color: "gray", itemId: "gray_cushion", rgb: [71, 79, 82] },
  { color: "light_gray", itemId: "light_gray_cushion", rgb: [157, 157, 151] },
  { color: "cyan", itemId: "cyan_cushion", rgb: [22, 156, 156] },
  { color: "purple", itemId: "purple_cushion", rgb: [137, 50, 184] },
  { color: "blue", itemId: "blue_cushion", rgb: [60, 68, 170] },
  { color: "brown", itemId: "brown_cushion", rgb: [131, 84, 50] },
  { color: "green", itemId: "green_cushion", rgb: [94, 124, 22] },
  { color: "red", itemId: "red_cushion", rgb: [176, 46, 38] },
  { color: "black", itemId: "black_cushion", rgb: [29, 29, 33] },
];

/** Snapshot format stamps (wiki: Java Edition 26.3 Snapshot 3, released 2026-07-07).
 *  NOT part of MC_VERSIONS - snapshots are not releases and their formats churn. */
export const CUSHION_SNAPSHOT = {
  id: "26.3-snapshot-3",
  dataPackFormat: 110,
  resourcePackFormat: 91,
  dataVersion: 5001,
  entityId: "minecraft:cushion",
} as const;

/** Entity-count ceiling for a generated mosaic. Every pixel is a separate no-collision
 *  entity; thousands of them are an entity-performance stress, not a normal build. */
export const CUSHION_MOSAIC_MAX_ENTITIES = 4096;

/** Index into CUSHION_COLORS of the nearest cushion color to an sRGB pixel (squared
 *  sRGB distance - preview-grade matching for a 16-color approximate palette). */
export function nearestCushion(r: number, g: number, b: number): number {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < CUSHION_COLORS.length; i++) {
    const [cr, cg, cb] = CUSHION_COLORS[i]!.rgb;
    const d = (r - cr) * (r - cr) + (g - cg) * (g - cg) + (b - cb) * (b - cb);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

export interface CushionMosaicOptions {
  /** REQUIRED opt-in. Cushions exist only in the 26.3 snapshot; refusing to generate
   *  without this flag keeps the experimental mode out of accidental release use. */
  experimental: boolean;
  /** world origin of the mosaic's north-west corner (cushions sit ON TOP of y) */
  origin?: { x: number; y: number; z: number };
  /** entity cap (default CUSHION_MOSAIC_MAX_ENTITIES) - excess rows are dropped, reported */
  maxEntities?: number;
}

export interface CushionMosaic {
  /** the mcfunction body (header comments + summon lines) */
  commands: string;
  /** entities actually emitted */
  entityCount: number;
  /** true when the image had more pixels than the entity cap allowed */
  truncated: boolean;
}

/**
 * Generate a top-down cushion FLOOR MOSAIC from an RGB image: one
 * `summon minecraft:cushion` per pixel, laid flat at y+1 on a floor plane, viewed
 * from above. This is the closest visualization the snapshot's cushions honestly
 * support (they cannot be placed on walls). The summon NBT follows the wiki's
 * documented entity data (`color` string); the header says it targets the 26.3
 * snapshot ONLY and has not been executed against a release server.
 */
export function cushionMosaicCommands(
  rgb: { width: number; height: number; data: Uint8Array },
  opts: CushionMosaicOptions,
): CushionMosaic {
  if (!opts.experimental) {
    throw new Error(
      "cushion mosaic is EXPERIMENTAL (26.3 snapshot only - cushions are entities, not blocks). " +
        "Pass the explicit experimental opt-in to generate it; see docs/cushions-26.3.md.",
    );
  }
  const { width, height, data } = rgb;
  if (width <= 0 || height <= 0 || data.length < width * height * 3) {
    throw new Error(`cushionMosaicCommands: bad RGB image ${width}x${height} (data ${data.length})`);
  }
  const o = opts.origin ?? { x: 0, y: 63, z: 0 };
  const cap = Math.max(1, Math.floor(opts.maxEntities ?? CUSHION_MOSAIC_MAX_ENTITIES));
  const lines: string[] = [
    `# EXPERIMENTAL: cushion floor mosaic - Java 26.3 SNAPSHOT ONLY (data pack format ${CUSHION_SNAPSHOT.dataPackFormat})`,
    `# Cushions are ENTITIES (flat pads on top of blocks), not blocks: this mosaic lies FLAT on the`,
    `# floor at y=${o.y + 1} and is viewed from above. No map color, no light behavior is documented.`,
    `# ${width}x${height} px, 16 dye colors (nearest match against wool-approximated RGB).`,
    `# Summon NBT follows the wiki-documented entity data; untested against a live snapshot server.`,
    `forceload add ${o.x} ${o.z} ${o.x + width - 1} ${o.z + height - 1}`,
  ];
  let count = 0;
  let truncated = false;
  outer: for (let py = 0; py < height; py++) {
    for (let px = 0; px < width; px++) {
      if (count >= cap) {
        truncated = true;
        break outer;
      }
      const j = (py * width + px) * 3;
      const c = CUSHION_COLORS[nearestCushion(data[j]!, data[j + 1]!, data[j + 2]!)]!;
      // center-of-block placement (numeric +0.5 - string-appending ".5" breaks at negative
      // coords: block -5's center is -4.5); image row 0 = north so it reads upright from above
      lines.push(`summon ${CUSHION_SNAPSHOT.entityId} ${o.x + px + 0.5} ${o.y + 1} ${o.z + py + 0.5} {color:"${c.color}"}`);
      count++;
    }
  }
  if (truncated) lines.push(`# TRUNCATED at ${cap} entities (${width * height} px requested) - entity-count ceiling`);
  return { commands: lines.join("\n") + "\n", entityCount: count, truncated };
}
