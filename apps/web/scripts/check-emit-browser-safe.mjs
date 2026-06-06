// Assert the @mineworld/emit-commands default entry is browser-safe: no `node:` builtin is
// reachable through its import graph (so vite can bundle the in-browser datapack export).
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";

const repo = fileURLToPath(new URL("../../../", import.meta.url));
const entry = join(repo, "packages/emit-commands/src/index.ts");

function resolveSpec(fromFile, spec) {
  if (spec.startsWith(".")) {
    let p = resolve(dirname(fromFile), spec);
    if (!p.endsWith(".ts") && !p.endsWith(".mjs")) p += ".ts";
    return p;
  }
  const m = /^@mineworld\/([^/]+)$/.exec(spec);
  if (m) return join(repo, "packages", m[1], "src", "index.ts"); // follow workspace deps too
  return null; // external (e.g. fflate) — assumed browser-safe
}

const seen = new Set();
const offenders = [];
const stack = [entry];
while (stack.length) {
  const f = stack.pop();
  if (seen.has(f) || !existsSync(f)) continue;
  seen.add(f);
  const src = readFileSync(f, "utf8");
  // `import/export ... from "spec"` — skip TYPE-ONLY imports (erased by the bundler, never reach the browser)
  for (const mm of src.matchAll(/\b(?:import|export)\b([^;]*?)\bfrom\s+["']([^"']+)["']/g)) {
    if (/^\s*type\b/.test(mm[1])) continue; // `import type { ... } from`
    const spec = mm[2];
    if (spec.startsWith("node:")) offenders.push(`${f.replace(repo, "")} → ${spec}`);
    else {
      const target = resolveSpec(f, spec);
      if (target) stack.push(target);
    }
  }
  // side-effect imports: `import "spec"`
  for (const mm of src.matchAll(/\bimport\s+["']([^"']+)["']/g)) {
    const spec = mm[1];
    if (spec.startsWith("node:")) offenders.push(`${f.replace(repo, "")} → ${spec}`);
    else {
      const target = resolveSpec(f, spec);
      if (target) stack.push(target);
    }
  }
}

if (offenders.length) {
  console.error("FAIL: node: builtins reachable from the browser-safe index:\n  " + offenders.join("\n  "));
  process.exit(1);
}
console.log(`OK: emit-commands "." entry is browser-safe (scanned ${seen.size} files, 0 node: imports)`);
