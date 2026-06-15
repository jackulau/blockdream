// Verify the viewer DISPLAY is decoupled from GENERATION:
//  - the shared Viewer runs a requestAnimationFrame render loop (smooth canvas)
//  - the next frame is requested on frame ARRIVAL (pump), not from the render loop
//  - neither per-model viewer lock-steps display to generation anymore
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const fail = (m) => {
  console.error("FAIL:", m);
  process.exit(1);
};

const viewer = read("../src/viewer.ts");
const wm = read("../src/world-model.ts");
const drv = read("../src/drive.ts");

if (!viewer.includes("requestAnimationFrame")) fail("viewer.ts has no requestAnimationFrame render loop");
if (!/startRenderLoop\s*\(/.test(viewer)) fail("viewer.ts has no startRenderLoop");
if (!/onMessage[\s\S]*?this\.pump\(\)/.test(viewer)) fail("the generation pump is not triggered by frame arrival");

// the render loop body must NOT send actions (that would re-couple display to generation)
const loopStart = viewer.indexOf("private startRenderLoop");
const loopEnd = viewer.indexOf("private tick");
const loopBody = viewer.slice(loopStart, loopEnd > loopStart ? loopEnd : undefined);
if (/\.send\(/.test(loopBody)) fail("render loop sends on the socket - display still coupled to generation");

for (const [name, src] of [
  ["world-model.ts", wm],
  ["drive.ts", drv],
]) {
  if (!/from "\.\/viewer"/.test(src)) fail(`${name} does not use the shared Viewer`);
  if (/requestAnimationFrame\(sendAction\)/.test(src)) fail(`${name} still lock-steps display to generation`);
}

console.log("OK: display decoupled from generation (rAF render loop + frame-driven pump); both viewers use Viewer");
