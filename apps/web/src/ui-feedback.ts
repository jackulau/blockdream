// Pure UI-feedback decisions for the showcase (goal 088 D11) - DOM-free on purpose, in the
// repo's pure-core style: every "what should the page say / which controls flip" rule lives
// here and is unit-tested in node, while showcase.ts only wires the results to elements.

/** Section 03 dies entirely when WebGL is unavailable (Viewer3D's WebGLRenderer throws in
 *  setup3dViewer). These are the section's interactive controls - all disabled on that
 *  failure so the section reads as unavailable instead of silently dead. */
export const SECTION3_CONTROL_IDS: readonly string[] = [
  "v3-play",
  "v3-scrub",
  "v3-anim",
  "v3-depth",
  "v3-rebuild",
  "v3-download",
  "v3-gif",
  "v3-png",
  "v3-arrange",
  "v3-arrange-target",
  "v3-music-toggle",
  "v3-import",
  "v3-fps",
  "v3-res",
  "v3-audio-mode",
  "v3-url",
  "v3-url-go",
];

/** HUD line when the 3D viewer cannot start (was: "building…" forever with dead controls). */
export function viewer3dUnavailableText(msg: string): string {
  return `3D viewer unavailable: ${msg} (WebGL required)`;
}

/** HUD line when the browser's autoplay policy blocks clip audio / the note-block synth. */
export const AUDIO_BLOCKED_TEXT = "audio blocked by the browser - click play again to enable sound";

/** The fps/resolution selects are read once at import time. Changing them mid-clip used to be
 *  a silent no-op; now the HUD says when the change takes effect. Null when nothing is loaded
 *  (the next import simply uses the new value - nothing to explain). */
export function settingsChangeNote(clipLoaded: boolean): string | null {
  return clipLoaded ? "fps/resolution applies on the next import - re-import to apply" : null;
}

/** §02 export status line. A still is honest as "1 frame"; an animated GIF says explicitly
 *  that only the current frame exports here (the full animation lives in section 03). */
export function blockArtExportText(width: number, height: number, frameCount: number): string {
  const base = `${width}×${height} = ${width * height} blocks`;
  return frameCount > 1
    ? `${base} · animated GIF: exporting the current frame only - use section 03 for the full animation`
    : `${base} · 1 frame`;
}

/** Reset only does anything while connected (Viewer.reset() early-returns otherwise) - the
 *  button follows the same connect/disconnect transitions the status pill shows. */
export function resetDisabled(cls: "ok" | "err" | "idle"): boolean {
  return cls !== "ok";
}
