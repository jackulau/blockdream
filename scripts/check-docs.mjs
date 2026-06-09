// Docs gate: keeps the writeups honest and catches doc staleness so it can't silently return.
//  1. every REQUIRED doc exists with its key sections and isn't an empty stub
//  2. scope: only git-TRACKED .md files (git ls-files '*.md') — untracked scratch notes can't fail the gate
//  3. no markdown file links to a missing relative .md target
//  4. no pre-rebrand identifiers (mineworld_wm / MINEWORLD_LOG / @mineworld) outside an explicit
//     allowlist (docs/results.md keeps the historical rebrand-verification table)
//  5. no instructions to serve stale checkpoints:
//     - `runs/skills/latest.pt` (pre-skills_real path) on any serve/verify-style line
//     - advice to serve `runs/m4` (real-VPT walking-only — dead skill embeddings)
//  6. every `python -m blockdream_wm.<module>` snippet maps to a real module under ml/src/
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fail = (m) => {
  console.error("FAIL:", m);
  process.exit(1);
};

// required docs → section headers each must contain
const REQUIRED = {
  "docs/architecture.md": ["## Workstreams", "## Packages", "## Data flow"],
  "docs/3d-and-animation.md": ["## Image → 3D", "## Greedy meshing", "## Animation"],
  "docs/video-import.md": ["## glTF", "## Video"],
  "docs/world-models-guide.md": ["## Models", "## Train", "## Serve", "## Movement types", "## Browser diffusion"],
  "docs/driving-world-model.md": ["## Datasets found", "## Architecture", "## Run it"],
  "docs/live-control.md": ["## Architecture", "## Operator setup"],
  "docs/movement-types.md": ["## How conditioning works", "## Honest status"],
  "docs/load-into-minecraft.md": ["## Java Edition", "## Bedrock Edition"],
  "docs/results.md": ["## System", "## Measured results", "## Reproduce"],
};

for (const [rel, sections] of Object.entries(REQUIRED)) {
  const p = join(ROOT, rel);
  if (!existsSync(p)) fail(`missing required doc: ${rel}`);
  const text = readFileSync(p, "utf8");
  for (const s of sections) if (!text.includes(s)) fail(`${rel} is missing section "${s}"`);
  if (text.length < 600) fail(`${rel} is too short to be a real writeup (${text.length} chars)`);
}

// only git-tracked markdown — scratch/untracked .md files must never fail (or be able to game) the gate
const tracked = execFileSync("git", ["ls-files", "*.md"], { cwd: ROOT, encoding: "utf8" })
  .split("\n")
  .filter(Boolean)
  .filter((rel) => existsSync(join(ROOT, rel))); // tolerate tracked-but-locally-deleted files

// pre-rebrand identifiers (project is Blockdream now); docs/results.md is allowlisted because its
// rebrand-verification table intentionally quotes the old identifiers
const PRE_REBRAND = /mineworld_wm|MINEWORLD_LOG|@mineworld/;
const ALLOW_PRE_REBRAND = new Set(["docs/results.md"]);

// Stale-serve heuristic (deliberately simple, line-based):
//  - `runs/skills/latest.pt` is the pre-skills_real checkpoint path; flag it on any line that
//    looks like a serve/verify instruction (mentions serve/verify or a --real/--checkpoint flag).
//    The underscore in runs/skills_real/... means correct paths never match.
//  - serving `runs/m4` is dead advice (walking-only model, dead skill embeddings). Flag a line iff
//    it contains both "serve" and "runs/m4" UNLESS it is clearly a warning ("not served",
//    "**not**", "don't/never serve"). Also flag the exact flags `--real runs/m4` /
//    `--real ml/runs/m4` regardless. Training (`--out runs/m4`) and resume/progress notes
//    (`ml/runs/m4/latest.pt` without "serve") are untouched.
const SERVE_VERIFY_LINE = /serve|verify|--real|--checkpoint/i;
const M4_WARNING = /not\s+served|\*\*not\*\*|don'?t\s+serve|never\s+serve/i;
const M4_REAL_FLAG = /--real\s+(ml\/)?runs\/m4\b/;

const MODULE_RE = /python3?\s+-m\s+(blockdream_wm(?:\.[A-Za-z0-9_]+)*)/g;

let linkCount = 0;
let moduleCount = 0;
for (const rel of tracked) {
  const f = join(ROOT, rel);
  const text = readFileSync(f, "utf8");

  // relative .md links must resolve
  for (const m of text.matchAll(/\]\((\.[^)]+\.md)(#[^)]*)?\)/g)) {
    const target = resolve(dirname(f), m[1]);
    linkCount++;
    if (!existsSync(target)) fail(`${rel} links to missing ${m[1]}`);
  }

  // python -m blockdream_wm.<module> snippets must map to real modules (file or package)
  for (const m of text.matchAll(MODULE_RE)) {
    const modPath = m[1].split(".").join("/");
    moduleCount++;
    if (!existsSync(join(ROOT, "ml/src", `${modPath}.py`)) && !existsSync(join(ROOT, "ml/src", modPath, "__init__.py")))
      fail(`${rel} references \`python -m ${m[1]}\` but ml/src/${modPath}.py (or package) does not exist`);
  }

  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const where = `${rel}:${i + 1}`;
    if (!ALLOW_PRE_REBRAND.has(rel) && PRE_REBRAND.test(line))
      fail(`${where} uses a pre-rebrand identifier (mineworld_wm/MINEWORLD_LOG/@mineworld): ${line.trim()}`);
    if (line.includes("runs/skills/latest.pt") && SERVE_VERIFY_LINE.test(line))
      fail(`${where} instructs serving/verifying stale checkpoint runs/skills/latest.pt (use runs/skills_real/latest.pt): ${line.trim()}`);
    if (M4_REAL_FLAG.test(line) || (line.includes("runs/m4") && /serve/i.test(line) && !M4_WARNING.test(line)))
      fail(`${where} advises serving runs/m4 (dead skill embeddings — serve runs/skills_real instead): ${line.trim()}`);
  }
}

console.log(
  `OK: ${Object.keys(REQUIRED).length} required docs present with sections; ` +
    `${tracked.length} tracked .md scanned; ${linkCount} relative .md links resolve; ` +
    `${moduleCount} blockdream_wm module refs valid; no pre-rebrand identifiers or stale serve paths`,
);
