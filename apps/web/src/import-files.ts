// Pure, DOM-free classification of a §03 voxel-builder import file. ALL entry points - the
// #v3-import picker, drag & drop onto the canvas area, and the pasted-URL fetch - funnel their
// File(s) into importFiles, whose dispatch asks classifyImportFile what each file IS. Keeping the
// decision in one unit-tested module (like anim-source.ts / canvas-mod.ts) means the three entry
// points can never drift apart in what they accept.
//
// Extension is primary (case-insensitive, tolerant of a URL-derived name carrying a ?query or
// #fragment); MIME type is the fallback for names without a useful extension - fetchAsFile names
// a bare-path URL "import" and relies on the response Content-Type to route it.

import { isVideoFile } from "./video";

/** What §03 does with a file - mirrors the importFiles dispatch branches one-to-one. */
export type ImportKind = "glb" | "gltf" | "obj" | "gif" | "video" | "image" | "unsupported";

/** The two fields classification needs (a DOM File satisfies this). */
export interface ImportFileLike {
  name?: string;
  type?: string;
}

/** Drop a URL-style ?query / #fragment so "loop.gif?width=800" still reads as a .gif. */
const cleanName = (name: string): string => name.split(/[?#]/, 1)[0]!;

/** Lower-cased extension of a (cleaned) file name, "" when there is none. */
function extOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/** Still-image extensions the builder solidifies (a GIF is its own, animated branch). */
const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "webp", "bmp", "avif"]);

/**
 * Classify one import file. Priority mirrors the importFiles dispatch: models (glb/glTF/obj)
 * beat clips, an animated GIF beats the generic still-image branch, and video is detected by
 * the same isVideoFile used by the decoder itself.
 */
export function classifyImportFile(f: ImportFileLike): ImportKind {
  const name = cleanName(f.name ?? "");
  const type = (f.type ?? "").toLowerCase();
  const ext = extOf(name);
  if (ext === "glb" || type === "model/gltf-binary") return "glb";
  if (ext === "gltf" || type === "model/gltf+json") return "gltf";
  if (ext === "obj") return "obj";
  if (ext === "gif" || type === "image/gif") return "gif";
  if (isVideoFile({ name, type })) return "video";
  if (IMAGE_EXT.has(ext) || type.startsWith("image/")) return "image";
  return "unsupported";
}
