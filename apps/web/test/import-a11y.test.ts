import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { audioAnalysisFailedText } from "../src/ui-feedback";

// Audio + a11y surfacing (goal 089 D11).
// (a) musicToggle is disabled on EVERY import and only re-enabled when a transcription lands;
//     the audio-analysis catch only log.warn-ed, so a decode failure left "Note blocks"
//     greyed forever with no reason - while the audio-mode select still offered "note
//     blocks" (silence). The HUD now carries the reason.
// (b) section-03's file input was display:none inside a non-focusable label - unreachable by
//     keyboard (section-02's ba-file is visible + focusable). Fixed with the visually-hidden
//     clip pattern, which keeps the input in the tab order.
// (c) id="v3-arrange-row" was referenced by nothing - removed.

const read = (p: string): string => readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8");
const showcase = read("../src/showcase.ts");
const index = read("../index.html");

describe("(a) audio-analysis failure carries a visible reason", () => {
  it("the failure text names the clip, the reason, and what the silence means", () => {
    const t = audioAnalysisFailedText("clip.mp4", "decodeAudioData failed");
    expect(t).toContain("clip.mp4");
    expect(t).toContain("decodeAudioData failed");
    expect(t).toContain("note blocks unavailable");
    expect(t).toContain('"note blocks" audio mode will stay silent');
  });

  it("the showcase writes it to the HUD in the audio catch (not just log.warn)", () => {
    expect(showcase).toContain("audioAnalysisFailedText(video.name, (err as Error).message)");
    // the catch still logs for debugging, but no longer ONLY logs
    expect(showcase).toMatch(/log\.warn\("audio analysis failed", err\);[\s\S]{0,500}audioAnalysisFailedText/);
  });

  it("the reason survives playback: onFrame's per-frame HUD line carries it", () => {
    // a one-shot hud.textContent write in the catch is erased by onFrame on the next frame
    // advance (~50-100ms into playback) - the failed clip is PLAYING when the catch runs, so
    // the reason must ride the per-frame line, not race it.
    expect(showcase).toMatch(/audioFailNote = audioAnalysisFailedText/);
    expect(showcase).toMatch(/drag to orbit\$\{audioFailNote \? ` · \$\{audioFailNote\}` : ""\}/);
    // and a fresh import clears it, so a prior clip's failure never haunts the next one
    expect(showcase).toMatch(/current3dMusic = \[\];[^\n]*\n\s*audioFailNote = null;/);
  });
});

describe("(b) section-03 file input is keyboard reachable", () => {
  it("the input is no longer display:none (which removes it from the tab order)", () => {
    const importInput = index.match(/<input id="v3-import"[^>]*>/)?.[0] ?? "";
    expect(importInput).not.toBe("");
    expect(importInput).not.toContain("display:none");
    expect(importInput).toContain('class="visually-hidden"');
    expect(importInput).not.toContain("tabindex=\"-1\"");
    expect(importInput).not.toContain("disabled");
  });

  it("the visually-hidden pattern hides without display:none and the label shows focus", () => {
    expect(index).toMatch(/\.visually-hidden \{[^}]*clip-path/);
    expect(index.match(/\.visually-hidden \{[^}]*\}/)?.[0]).not.toContain("display: none");
    expect(index).toContain("label.ui:focus-within");
  });

  it("section-02's ba-file stays a plainly visible, focusable input (the good precedent)", () => {
    const baFile = index.match(/<input id="ba-file"[^>]*>/)?.[0] ?? "";
    expect(baFile).not.toBe("");
    expect(baFile).not.toContain("display:none");
    expect(baFile).not.toContain("visually-hidden");
  });
});

describe("(c) dead markup", () => {
  it("the unreferenced v3-arrange-row id is gone (from markup and code alike)", () => {
    expect(index).not.toContain("v3-arrange-row");
    expect(showcase).not.toContain("v3-arrange-row");
  });
});
