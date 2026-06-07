// Docs gate: every required doc exists with its key sections, and no markdown file links to a
// missing relative .md target. Keeps the writeups honest (no dangling links, no empty stubs).
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
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
};

for (const [rel, sections] of Object.entries(REQUIRED)) {
  const p = join(ROOT, rel);
  if (!existsSync(p)) fail(`missing required doc: ${rel}`);
  const text = readFileSync(p, "utf8");
  for (const s of sections) if (!text.includes(s)) fail(`${rel} is missing section "${s}"`);
  if (text.length < 600) fail(`${rel} is too short to be a real writeup (${text.length} chars)`);
}

// collect all markdown files (repo docs + root README/PLAN), skip node_modules/.git
function mdFiles(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".git" || name.startsWith(".")) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) mdFiles(p, acc);
    else if (name.endsWith(".md")) acc.push(p);
  }
  return acc;
}

let linkCount = 0;
for (const f of mdFiles(ROOT)) {
  const text = readFileSync(f, "utf8");
  for (const m of text.matchAll(/\]\((\.[^)]+\.md)(#[^)]*)?\)/g)) {
    const target = resolve(dirname(f), m[1]);
    linkCount++;
    if (!existsSync(target)) fail(`${f.replace(ROOT + "/", "")} links to missing ${m[1]}`);
  }
}

console.log(`OK: ${Object.keys(REQUIRED).length} required docs present with sections; ${linkCount} relative .md links resolve`);
