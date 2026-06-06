// Resolve a map-color cell's base block → name / id / icon. The block-art quantizer
// emits a map-color per cell; each map color has a `baseId` (1..61) that picks the
// Minecraft block. There are no real textures in-repo, so the default icon is a
// generated swatch (block RGB + deterministic noise so it reads as a texture, not a
// flat chip); a real-texture mode fetches from an open minecraft-assets CDN.

import blockPalette from "@mineworld/palette/data/java-block-palette-1.21.json";

export interface BlockInfo {
  baseId: number;
  name: string;
  id: string;
  rgb: { r: number; g: number; b: number };
}

const BY_BASE = new Map<number, BlockInfo>();
for (const b of (blockPalette as { bases: Array<{ baseId: number; rgb: BlockInfo["rgb"]; representative: { displayName: string; id: string } }> }).bases) {
  BY_BASE.set(b.baseId, { baseId: b.baseId, name: b.representative.displayName, id: b.representative.id, rgb: b.rgb });
}

export function blockForBase(baseId: number): BlockInfo | undefined {
  return BY_BASE.get(baseId);
}

const clamp = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));
function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** A faithful generated icon: the block's average RGB plus a stable per-block noise
 *  pattern so e.g. stone vs planks read as different textured chips (offline, no assets). */
export function swatchDataUrl(info: BlockInfo, size = 26): string {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const ctx = c.getContext("2d")!;
  const img = ctx.createImageData(size, size);
  let s = hash(info.id) || 1;
  const { r, g, b } = info.rgb;
  for (let i = 0; i < size * size; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    const n = ((s >>> 24) / 255 - 0.5) * 26; // ±13 luminance noise
    const o = i * 4;
    img.data[o] = clamp(r + n);
    img.data[o + 1] = clamp(g + n);
    img.data[o + 2] = clamp(b + n);
    img.data[o + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return c.toDataURL();
}

// --- real local textures (extracted from the official jar by scripts/fetch-block-textures.py) ---
// Served from /blocks/<file>.png with /blocks/manifest.json mapping id -> file. Gitignored,
// local-only. Absent until the fetch script is run → callers fall back to swatchDataUrl.

let MANIFEST: Record<string, string> | null = null;
let manifestVersion = "";

/** Fetch the local texture manifest once. Resolves even if it's missing (→ no textures). */
export async function loadTextureManifest(): Promise<boolean> {
  if (MANIFEST) return true;
  try {
    const r = await fetch("/blocks/manifest.json", { cache: "no-cache" });
    if (!r.ok) return false;
    const j = (await r.json()) as { textures?: Record<string, string>; version?: string };
    MANIFEST = j.textures ?? {};
    manifestVersion = j.version ?? "";
    return true;
  } catch {
    return false;
  }
}

export function hasLocalTextures(): boolean {
  return !!MANIFEST && Object.keys(MANIFEST).length > 0;
}

export function textureVersion(): string {
  return manifestVersion;
}

/** Local real-texture URL for a block id, or null if we have no texture for it. */
export function localTextureUrl(id: string): string | null {
  const file = MANIFEST?.[id];
  return file ? `/blocks/${file}` : null;
}
