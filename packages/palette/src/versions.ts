/**
 * Minecraft version registry - the single source of truth for the format stamps
 * written into emitted artifacts (datapack pack_format, NBT DataVersion, Bedrock
 * block/engine versions) and for resolving a requested version to the palette
 * data file that actually carries those colors.
 *
 * Numbers are from the Minecraft Wiki "Pack format" and "Data version" tables.
 * The 1.21.x line is what the pipeline supports end-to-end (singular `function/`
 * datapack layout since 1.21, function macros since 1.20.2, `#minecraft:tick`
 * forever) - so one datapack with a `supported_formats` range genuinely loads
 * across the whole line. To support a newer patch, add one row here.
 */

export interface McVersion {
  /** Canonical id, e.g. "1.21.5". */
  id: string;
  /** Java data pack `pack_format` (written to pack.mcmeta). */
  packFormat: number;
  /** Java NBT `DataVersion` (written into map .dat and other saved NBT). */
  dataVersion: number;
}

/** Java release line (release builds only, not snapshots). 26.x is the year-based
 *  naming Mojang switched to after 1.21.11 (26.1 "Tiny Takeover", 26.2 "Chaos Cubed");
 *  pack formats grew minor versions there (94.1, 101.1, 107.1) — we stamp the major,
 *  which every release reads. Snapshot-only content (e.g. 26.3's cushion entities)
 *  deliberately does NOT get a row here: it lives behind an explicit experimental
 *  gate in ./cushions.ts, with its own snapshot format stamps. */
export const MC_VERSIONS: readonly McVersion[] = [
  { id: "1.21", packFormat: 48, dataVersion: 3953 },
  { id: "1.21.1", packFormat: 48, dataVersion: 3955 },
  { id: "1.21.2", packFormat: 57, dataVersion: 4080 },
  { id: "1.21.3", packFormat: 57, dataVersion: 4082 },
  { id: "1.21.4", packFormat: 61, dataVersion: 4189 },
  { id: "1.21.5", packFormat: 71, dataVersion: 4325 },
  { id: "1.21.6", packFormat: 80, dataVersion: 4435 },
  { id: "1.21.7", packFormat: 81, dataVersion: 4438 },
  { id: "1.21.8", packFormat: 81, dataVersion: 4440 },
  { id: "1.21.9", packFormat: 88, dataVersion: 4554 },
  { id: "1.21.10", packFormat: 88, dataVersion: 4556 },
  { id: "1.21.11", packFormat: 94, dataVersion: 4671 },
  { id: "26.1", packFormat: 101, dataVersion: 4786 },
  { id: "26.2", packFormat: 107, dataVersion: 4903 },
];

/**
 * Default target when no `--version` is given: the compatibility FLOOR of the
 * supported line. A floor pack_format + DataVersion is the most portable stamp -
 * the datapack's `supported_formats` range (below) opens it on newer patches, and
 * the game's DataFixerUpper upgrades floor-stamped NBT on load. (Older patches
 * cannot upgrade a *future* stamp, so the floor - not the latest - is the safe default.)
 */
export const DEFAULT_MC_VERSION = "1.21";

/**
 * `supported_formats` for the Java datapack pack.mcmeta. Declaring the full range
 * of the supported line lets a SINGLE generated datapack load without the
 * "incompatible" warning on every 1.21.x version, regardless of which exact
 * `pack_format` is stamped as the "home" version.
 */
export const JAVA_DATAPACK_SUPPORTED: { readonly min_inclusive: number; readonly max_inclusive: number } = {
  min_inclusive: MC_VERSIONS[0]!.packFormat,
  max_inclusive: MC_VERSIONS[MC_VERSIONS.length - 1]!.packFormat,
};

/**
 * Bedrock manifest `min_engine_version`. This is a FLOOR: a pack declaring
 * [1,21,0] loads on 1.21.0 and every later Bedrock version. Keep it at the floor
 * for maximum forward compatibility - do NOT raise it per requested version.
 */
export const BEDROCK_MIN_ENGINE: readonly [number, number, number] = [1, 21, 0];

/**
 * Bedrock packed block version int [major,minor,patch,revision] = 1.21.0.
 * Bedrock auto-upgrades older block versions on load, so this floor is also
 * forward-compatible across the whole line.
 */
export const BEDROCK_BLOCK_VERSION = 0x01_15_00_00;

/**
 * Canonical palette data-file keys. The map-color table and the solid-block color
 * set are stable across the entire 1.21.x line (these blocks have not changed
 * color), so every requested version resolves to one of these files.
 */
export const PALETTE_DATA = {
  /** java-map-colors-<key>.json */
  javaMap: "1.21.9",
  /** bedrock-map-colors-<key>.json */
  bedrockMap: "1.21",
  /** java-block-palette-<key>.json / java-block-colors-<key>.json */
  block: "1.21",
} as const;

/** True if `id` is a recognized version in the registry. */
export function isKnownMcVersion(id: string): boolean {
  return MC_VERSIONS.some((m) => m.id === id);
}

/**
 * Resolve a requested version string to its format stamps. Accepts any id in
 * {@link MC_VERSIONS}; `undefined`/empty → {@link DEFAULT_MC_VERSION}. Throws a
 * helpful error (listing supported ids) for an unrecognized version, rather than
 * letting a wrong stamp produce a silently-unloadable artifact downstream.
 */
export function resolveMcVersion(v?: string): McVersion {
  const id = (v ?? DEFAULT_MC_VERSION).trim() || DEFAULT_MC_VERSION;
  const exact = MC_VERSIONS.find((m) => m.id === id);
  if (exact) return exact;
  throw new Error(
    `unsupported Minecraft version "${id}". Supported: ${MC_VERSIONS.map((m) => m.id).join(", ")}`,
  );
}
