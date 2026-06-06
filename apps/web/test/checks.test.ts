// Run the standalone invariant checks as part of `pnpm test` so they can't silently rot.
// These are texture-free, source-only checks:
//  - browser-safe: the emit-commands "." entry pulls in no node: builtins (vite must bundle it)
//  - render-loop: the viewer's display is decoupled from generation (smooth canvas regardless of gen rate)
// (check-texture-coverage.mjs needs the gitignored local block textures, so it stays a manual `pnpm check`.)

import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scripts = fileURLToPath(new URL("../scripts/", import.meta.url));

function run(name: string): { code: number; out: string } {
  try {
    const out = execFileSync("node", [name], { cwd: scripts, encoding: "utf8" });
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
});
