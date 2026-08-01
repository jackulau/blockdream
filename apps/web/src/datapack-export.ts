// Package a generated datapack (a files Map<path,string> from @blockdream/emit-commands)
// into a real, droppable Minecraft datapack .zip in the browser - store-only (datapacks
// don't need compression) via fflate - and trigger a download.

import { zipSync, strToU8 } from "fflate";
// Pure-data subpath (no node:fs) - the registry is the single source of truth for versions.
import { MC_VERSIONS } from "@blockdream/palette/versions";

// Playback planning moved to @blockdream/emit-commands (tick-plan.ts) so the CLI resamples
// >20 fps clips identically to this exporter; re-exported here to keep existing imports.
export { planTickPlayback, type TickPlan } from "@blockdream/emit-commands";

/** Human-readable supported Java range, DERIVED from the version registry - never hardcoded.
 *  This string ships inside every exported pack's HOW_TO_LOAD.txt, so a stale hardcode would
 *  bundle wrong instructions into every download (it said "1.21 through 1.21.10" while the
 *  registry already reached 26.2). */
export const JAVA_VERSION_RANGE = `${MC_VERSIONS[0]!.id} through ${MC_VERSIONS[MC_VERSIONS.length - 1]!.id}`;

/** Export-budget ceiling on per-frame .mcfunction files in one web-exported datapack.
 *  2191 frames is the largest pack validated end-to-end on a REAL server (whole-video
 *  Bad Apple e2e, goal 083) - never set this below 2191; that size is a shipped, proven
 *  capability. 2600 adds modest headroom; beyond it a pack has never been proven to
 *  /reload in-game, so the export warns (it does NOT hard-fail - the CLI covers the
 *  same risk with an explicit --max-frames / maxFrames flag, the web warns instead). */
export const EXPORT_FRAME_BUDGET = 2600;

export interface ExportBudget {
  frameCount: number; // planned per-frame function files (one .mcfunction per frame)
  budget: number; // the documented ceiling this plan was checked against
  warn: boolean; // true when frameCount exceeds the budget
  message: string; // human-readable status for the UI (warning text when warn=true)
}

/** Pure export-budget guard: given the number of frames about to be emitted (one function
 *  file each), report whether the pack exceeds the documented budget. Callers surface the
 *  warning (console + status element) BEFORE zipping; the export itself still proceeds. */
export function planExportBudget(frameCount: number, budget: number = EXPORT_FRAME_BUDGET): ExportBudget {
  const warn = frameCount > budget;
  const message = warn
    ? `${frameCount} frame function files exceeds the tested budget of ${budget} ` +
      `(largest real-server-validated pack: 2191 frames). The pack will still be built, ` +
      `but /reload may be slow or fail; consider a shorter clip or a lower fps.`
    : `${frameCount} frame function files (within the ${budget}-frame budget)`;
  return { frameCount, budget, warn, message };
}

/** Where a pack builds when the caller doesn't say: the emitters' shared default origin. */
export interface PackOrigin { x: number; y: number; z: number }
const DEFAULT_ORIGIN: PackOrigin = { x: 0, y: 64, z: 0 };

/** Step-by-step in-game load guide, derived from the pack's own namespace AND its real origin,
 *  bundled into the zip so the instructions travel with the download (the "how do I load this"
 *  answer ships with it). A dragged/arranged export used to still claim "around x=0 y=64 z=0"
 *  and "/tp 0 80 0" no matter where the pack actually builds. */
export function loadInstructions(files: Map<string, string>, origin: PackOrigin = DEFAULT_ORIGIN): string {
  const setup = [...files.keys()].find((k) => /^data\/[^/]+\/function\/setup\.mcfunction$/.test(k));
  const ns = setup ? setup.split("/")[1]! : "blockdream";
  const title = `HOW TO LOAD THIS INTO MINECRAFT (Java Edition - any release ${JAVA_VERSION_RANGE})`;
  return [
    title,
    "=".repeat(title.length),
    "(One pack works across the whole supported line - it declares supported_formats,",
    " so Minecraft loads it without the red 'incompatible pack' warning on any of them.)",
    "",
    "1. Find your world's datapacks folder:",
    "     Singleplayer: open the world, pause, 'Open World Folder' then datapacks/",
    "     (or .minecraft/saves/<world>/datapacks/ ; servers: <server>/world/datapacks/)",
    "2. Drop this .zip into that datapacks/ folder. Do NOT unzip it.",
    "3. In game run:  /reload",
    "4. Build it:     /function " + ns + ":setup",
    `     The build appears at the pack's FIXED origin (around x=${origin.x} y=${origin.y} z=${origin.z} - the`,
    "     coordinates inside the frame functions are absolute). setup first CLEARS",
    "     that whole box to air, so do NOT run it inside your base; teleport over",
    `     (/tp ${origin.x} ${origin.y + 16} ${origin.z}) to watch it build.`,
    "5. Animate it:   /function " + ns + ":start     ( /function " + ns + ":stop to pause )",
    "     stop also releases the force-loaded chunks; start re-acquires them.",
    "",
    "Full guide (Bedrock too): docs/load-into-minecraft.md in the repo.",
    "",
    "Made with blockdream.",
    "",
  ].join("\n");
}

/** Files Map → a store-only zip (Uint8Array). The zip IS a valid datapack: drop it into a world's
 *  `datapacks/` folder and `/reload`. A HOW_TO_LOAD.txt is bundled in (Minecraft ignores it). */
export function zipDatapack(files: Map<string, string>, origin: PackOrigin = DEFAULT_ORIGIN): Uint8Array {
  const entries: Record<string, Uint8Array> = {};
  for (const [path, content] of files) entries[path] = strToU8(content);
  entries["HOW_TO_LOAD.txt"] = strToU8(loadInstructions(files, origin));
  return zipSync(entries, { level: 0 }); // store (no deflate) - fast, simple, valid
}

/** Trigger a browser download of bytes under `name`. */
export function downloadBytes(name: string, bytes: Uint8Array): void {
  // copy into a fresh ArrayBuffer-backed view - BlobPart rejects ArrayBufferLike-typed views
  const blob = new Blob([new Uint8Array(bytes)], { type: "application/zip" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Convenience: zip + download in one call. Pass the pack's REAL origin so the bundled
 *  HOW_TO_LOAD.txt points at where this pack actually builds. */
export function downloadDatapack(name: string, files: Map<string, string>, origin: PackOrigin = DEFAULT_ORIGIN): void {
  downloadBytes(name.endsWith(".zip") ? name : `${name}.zip`, zipDatapack(files, origin));
}
