// Package a generated datapack (a files Map<path,string> from @blockdream/emit-commands)
// into a real, droppable Minecraft datapack .zip in the browser — store-only (datapacks
// don't need compression) via fflate — and trigger a download.

import { zipSync, strToU8 } from "fflate";

/** Step-by-step in-game load guide, derived from the pack's own namespace, bundled into the zip so
 *  the instructions travel with the download (the "how do I load this" answer ships with it). */
export function loadInstructions(files: Map<string, string>): string {
  const setup = [...files.keys()].find((k) => /^data\/[^/]+\/function\/setup\.mcfunction$/.test(k));
  const ns = setup ? setup.split("/")[1]! : "blockdream_art";
  return [
    "HOW TO LOAD THIS INTO MINECRAFT (Java Edition — any 1.21.x: 1.21 through 1.21.10)",
    "================================================================================",
    "(One pack works across the whole 1.21 line — it declares supported_formats, so",
    " Minecraft loads it without the red 'incompatible pack' warning on any 1.21.x.)",
    "",
    "1. Find your world's datapacks folder:",
    "     Singleplayer: open the world, pause, 'Open World Folder' then datapacks/",
    "     (or .minecraft/saves/<world>/datapacks/ ; servers: <server>/world/datapacks/)",
    "2. Drop this .zip into that datapacks/ folder. Do NOT unzip it.",
    "3. In game run:  /reload",
    "4. Build it:     /function " + ns + ":setup",
    "     The build appears at the pack's FIXED origin (around x=0 y=64 z=0 — the",
    "     coordinates inside the frame functions are absolute). setup first CLEARS",
    "     that whole box to air, so do NOT run it inside your base; teleport over",
    "     (/tp 0 80 0) to watch it build.",
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
export function zipDatapack(files: Map<string, string>): Uint8Array {
  const entries: Record<string, Uint8Array> = {};
  for (const [path, content] of files) entries[path] = strToU8(content);
  entries["HOW_TO_LOAD.txt"] = strToU8(loadInstructions(files));
  return zipSync(entries, { level: 0 }); // store (no deflate) — fast, simple, valid
}

/** Trigger a browser download of bytes under `name`. */
export function downloadBytes(name: string, bytes: Uint8Array): void {
  // copy into a fresh ArrayBuffer-backed view — BlobPart rejects ArrayBufferLike-typed views
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

/** Convenience: zip + download in one call. */
export function downloadDatapack(name: string, files: Map<string, string>): void {
  downloadBytes(name.endsWith(".zip") ? name : `${name}.zip`, zipDatapack(files));
}
