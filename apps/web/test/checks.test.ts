// Run the standalone invariant checks as part of `pnpm test` so they can't silently rot.
// These are texture-free, source-only checks:
//  - browser-safe: the emit-commands "." entry pulls in no node: builtins (vite must bundle it)
//  - render-loop: the viewer's display is decoupled from generation (smooth canvas regardless of gen rate)
//  - docs gate (repo-root scripts/check-docs.mjs): required docs + sections, no stale serve paths,
//    no pre-rebrand identifiers, python -m snippets map to real modules
// (check-texture-coverage.mjs needs the gitignored local block textures, so it stays a manual `pnpm check`.)

import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scripts = fileURLToPath(new URL("../scripts/", import.meta.url));
const rootScripts = fileURLToPath(new URL("../../../scripts/", import.meta.url));

function run(name: string, cwd: string = scripts): { code: number; out: string } {
  try {
    const out = execFileSync("node", [name], { cwd, encoding: "utf8" });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? 1, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

describe("web invariant checks (wired into CI)", () => {
  it("emit-commands default entry is browser-safe (no node: imports)", () => {
    const r = run("check-emit-browser-safe.mjs");
    expect(r.out).toContain("browser-safe");
    expect(r.code).toBe(0);
  });

  it("viewer display loop is decoupled from generation", () => {
    const r = run("check-render-loop.mjs");
    expect(r.out).toContain("decoupled");
    expect(r.code).toBe(0);
  });

  it("docs are fresh: required docs present, no stale serve paths or pre-rebrand identifiers", () => {
    const r = run("check-docs.mjs", rootScripts);
    expect(r.out).toContain("required docs present");
    expect(r.out).toContain("no pre-rebrand identifiers or stale serve paths");
    expect(r.code).toBe(0);
  });

  it("every page credits the author and the landing page deep-links the repo (check-attribution)", () => {
    const r = run("check-attribution.mjs");
    expect(r.out).toContain("attribution ok");
    expect(r.code).toBe(0);
  });
});
