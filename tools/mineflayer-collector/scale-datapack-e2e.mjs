// scale-datapack-e2e.mjs - END-TO-END proof that a LARGE 3D voxel datapack actually
// loads and executes on a stock vanilla server (not just that the bytes look right).
//
// datapack-e2e.mjs proves the small 2D-wall path; this proves the 3D BUILD path at
// scale - the greedyBoxes /fill merge + the voxel emitter under hundreds-to-thousands
// of fills. Renders a large voxel3d datapack via the REAL CLI, installs the .zip into a
// throwaway 1.21.1 world, boots, /reload, runs :setup (forceload + frames/0 paint the
// whole build), then asserts over RCON that sampled solid voxels match the emitter's
// fills exactly. Catches scale-only failures (function/command limits, load time) the
// unit benches can't see.
//
//   BD_SCALE_GRID=64 node tools/mineflayer-collector/scale-datapack-e2e.mjs
// Exit 0 = vanilla executed the large 3D datapack correctly. Nonzero = diagnostics kept.

import { Rcon } from "rcon-client";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, copyFileSync, existsSync, rmSync, readFileSync, writeFileSync, readdirSync, createWriteStream } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const MC_VERSION = "1.21.1";
const RCON_PASS = "blockdream-scale-e2e";
const NS = "blockdream_3d";
const GRID = Number(process.env.BD_SCALE_GRID || 64); // 64px → ~1.6k fills; bump to stress further
const log = (m) => console.log(`[scale-datapack-e2e] ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((res, rej) => {
    const srv = createServer();
    srv.once("error", rej);
    srv.listen(0, "127.0.0.1", () => { const p = srv.address().port; srv.close(() => res(p)); });
  });
}
function setProp(text, key, val) {
  const re = new RegExp(`^${key.replace(/\./g, "\\.")}=.*$`, "m");
  return re.test(text) ? text.replace(re, `${key}=${val}`) : `${text.replace(/\n?$/, "\n")}${key}=${val}\n`;
}

const t0 = Date.now();
const work = mkdtempSync(join(tmpdir(), "bd-scale-work-"));
const dir = mkdtempSync(join(tmpdir(), "bd-scale-server-"));
let server, rconClient;
const cleanup = async () => {
  try { await rconClient?.end(); } catch {}
  try { server?.kill("SIGKILL"); } catch {}
};

try {
  // ---- 1. real input frame (testsrc2: SMPTE-like bars → a real subject, not flat colour)
  const ffmpeg = process.env.BLOCKDREAM_FFMPEG || "ffmpeg";
  const png = join(work, "in.png");
  execFileSync(ffmpeg, ["-v", "error", "-f", "lavfi", "-i", `testsrc2=s=${GRID}x${GRID}`, "-frames:v", "1", "-y", png]);

  // ---- 2. render a LARGE 3D voxel datapack through the REAL CLI (the exact user command)
  const outDir = join(work, "out");
  log(`rendering: blockdream render in.png --target voxel3d --grid ${GRID}x${GRID} --origin 0,64,0`);
  const cli = execFileSync("npx", ["tsx", "packages/cli/src/index.ts", "render", png,
    "--target", "voxel3d", "--grid", `${GRID}x${GRID}`, "--origin", "0,64,0", "--out", outDir],
    { cwd: ROOT, encoding: "utf8" });
  const zip = join(outDir, `${NS}.zip`);
  if (!existsSync(zip)) throw new Error(`CLI did not emit ${NS}.zip: ${cli.slice(-300)}`);

  // ---- 3. parse the emitter's own fills → expected solid voxels (sample some). Large builds
  //         (256px+) CHUNK the frame: frames/0.mcfunction dispatches frames/0/part*.mcfunction, so
  //         gather fills from frames/0 AND any part chunks (covers both direct + chunked layouts).
  const fnDir = join(outDir, "data", NS, "function");
  let body = readFileSync(join(fnDir, "frames", "0.mcfunction"), "utf8");
  const partDir = join(fnDir, "frames", "0");
  const chunked = existsSync(partDir);
  if (chunked) {
    for (const f of readdirSync(partDir).filter((n) => n.endsWith(".mcfunction")).sort()) {
      body += "\n" + readFileSync(join(partDir, f), "utf8");
    }
  }
  const fills = [...body.matchAll(/^fill (-?\d+) (-?\d+) (-?\d+) -?\d+ -?\d+ -?\d+ (minecraft:\S+?)(?: replace)?$/gm)];
  if (fills.length < 50) throw new Error(`expected a large build (>=50 fills), got ${fills.length} - not a scale test`);
  log(`large 3D build: ${fills.length} fills emitted (greedyBoxes-merged${chunked ? ", chunked into part functions" : ""}), sampling solid corners`);
  // sample ~24 first-corners spread across the fill list (each is a known-solid voxel)
  const stride = Math.max(1, Math.floor(fills.length / 24));
  const samples = [];
  for (let i = 0; i < fills.length && samples.length < 24; i += stride) {
    const [, x, y, z, block] = fills[i];
    samples.push({ x, y, z, block });
  }

  // ---- 4. throwaway server with the large datapack installed pre-boot
  for (const cache of ["/tmp/bd-server-d2", "/tmp/bd-server-scale", join(ROOT, ".vanilla-server")]) {
    if (existsSync(join(cache, "server.jar")) && existsSync(join(cache, "server.jar.sha1"))) {
      copyFileSync(join(cache, "server.jar"), join(dir, "server.jar"));
      copyFileSync(join(cache, "server.jar.sha1"), join(dir, "server.jar.sha1"));
      log(`seeded cached server.jar from ${cache}`);
      break;
    }
  }
  log(`bootstrapping vanilla ${MC_VERSION} (datapack pre-installed)`);
  execFileSync("bash", [join(ROOT, "scripts/vanilla-server.sh"), "--dir", dir, "--rcon-pass", RCON_PASS,
    "--datapack", zip, "--no-start"], { stdio: "inherit" });

  const javaHome = execFileSync("/usr/libexec/java_home", ["-v", "21"]).toString().trim();
  const propsPath = join(dir, "server.properties");
  let RCON_PORT;
  for (let attempt = 1; ; attempt++) {
    const SERVER_PORT = await freePort();
    RCON_PORT = await freePort();
    writeFileSync(propsPath, setProp(setProp(readFileSync(propsPath, "utf8"), "server-port", SERVER_PORT), "rcon.port", RCON_PORT));
    log(`starting server (java 21, ports: server ${SERVER_PORT}, rcon ${RCON_PORT}) - waiting for RCON (<=180 s)`);
    server = spawn(join(javaHome, "bin", "java"), ["-Xmx2G", "-jar", "server.jar", "nogui"],
      { cwd: dir, env: { ...process.env, JAVA_HOME: javaHome }, stdio: ["ignore", "pipe", "pipe"] });
    const bootLog = createWriteStream(join(dir, "boot-stdout.log"));
    server.stdout.pipe(bootLog); server.stderr.pipe(bootLog);
    let bootBuf = "";
    try {
      await new Promise((res, rej) => {
        const timer = setTimeout(() => rej(new Error(`server not ready after 180 s - see ${dir}/boot-stdout.log`)), 180_000);
        const onData = (d) => {
          bootBuf += d.toString();
          if (/RCON running on/.test(bootBuf)) { server.stdout.off("data", onData); clearTimeout(timer); log("server ready (RCON listening)"); res(); }
        };
        server.stdout.on("data", onData);
        server.once("exit", (code) => { clearTimeout(timer); rej(new Error(`server exited early (code ${code}) - see ${dir}/boot-stdout.log`)); });
      });
      break;
    } catch (bootErr) {
      if (attempt < 3 && /Address already in use/.test(bootBuf)) { log(`port collision (attempt ${attempt}) - retrying`); continue; }
      throw bootErr;
    }
  }

  // a very large build (e.g. 256px = ~15k fills) runs its whole :setup in one server tick, which can
  // take tens of seconds - well past rcon-client's ~5 s default ("Timeout for packet id 2"). Give RCON
  // a generous timeout so the heavy one-shot setup can finish before we read voxels back.
  rconClient = await Rcon.connect({ host: "127.0.0.1", port: RCON_PORT, password: RCON_PASS, timeout: 120_000 });
  const rcon = (cmd) => rconClient.send(cmd);

  // ---- 5. pack enabled at boot AND survives /reload (the documented user flow)
  if (!(await rcon("datapack list enabled")).includes(`${NS}.zip`)) throw new Error("datapack not enabled at boot");
  await rcon("reload");
  await sleep(1500);
  if (!(await rcon("datapack list enabled")).includes(`${NS}.zip`)) throw new Error("datapack lost after /reload");
  log("pack enabled at boot and survives /reload");

  // ---- 6. :setup forceloads the build's footprint and dispatches frames/0 → paints the
  //         whole large build. Then assert sampled solid voxels are EXACTLY as emitted.
  const setupOut = await rcon(`function ${NS}:setup`);
  if (/error|failed|unknown/i.test(setupOut)) throw new Error(`:setup failed: ${setupOut}`);
  log(`:setup ran (${setupOut.trim() || "ok"}) - large build painted`);
  let pass = 0;
  const fails = [];
  for (const s of samples) {
    const r = await rcon(`execute if block ${s.x} ${s.y} ${s.z} ${s.block}`);
    if (/passed/i.test(r)) pass++;
    else fails.push(`(${s.x},${s.y},${s.z}) want ${s.block} → ${r.trim() || "(empty)"}`);
  }
  log(`sampled solid voxels: ${pass}/${samples.length} exact-match`);
  for (const f of fails.slice(0, 6)) log(`  ✗ ${f}`);
  if (pass !== samples.length) throw new Error(`${fails.length} voxel(s) wrong - vanilla did not execute the large 3D datapack as emitted`);

  await cleanup();
  rmSync(dir, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
  log(`PASS in ${((Date.now() - t0) / 1000).toFixed(1)} s - vanilla loaded + executed a ${GRID}px 3D build (${fills.length} fills) at scale`);
  process.exit(0);
} catch (e) {
  console.error(`[scale-datapack-e2e] FAIL: ${e.message}`);
  console.error(`[scale-datapack-e2e] dirs KEPT for debugging: server=${dir} work=${work}`);
  await cleanup();
  process.exit(1);
}
