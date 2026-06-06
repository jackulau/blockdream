// Package a generated datapack (a files Map<path,string> from @mineworld/emit-commands)
// into a real, droppable Minecraft datapack .zip in the browser — store-only (datapacks
// don't need compression) via fflate — and trigger a download.

import { zipSync, strToU8 } from "fflate";

/** Files Map → a store-only zip (Uint8Array). The zip IS a valid datapack: drop it into
 *  a world's `datapacks/` folder and `/reload`. */
export function zipDatapack(files: Map<string, string>): Uint8Array {
  const entries: Record<string, Uint8Array> = {};
  for (const [path, content] of files) entries[path] = strToU8(content);
  return zipSync(entries, { level: 0 }); // store (no deflate) — fast, simple, valid
}

/** Trigger a browser download of bytes under `name`. */
export function downloadBytes(name: string, bytes: Uint8Array): void {
  const blob = new Blob([bytes], { type: "application/zip" });
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
