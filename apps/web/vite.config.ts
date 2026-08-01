import { resolve } from "node:path";
import { rmSync } from "node:fs";
import { defineConfig, type Plugin } from "vite";

// public/onnx/ holds the exported diffusion weights (~7.3 MB, gitignored, generated locally by
// ml/scripts/goal020_diffusion.sh). Their only consumer (src/rollout.ts) is not imported by any
// page yet - world-model.html says so - so shipping them made every deploy carry 7.3 MB of dead
// payload. Vite cannot exclude paths from the publicDir copy, so drop the copied dir from the
// build output after the copy. The weights stay on disk for the future engine-wiring goal;
// delete this plugin when rollout.ts gets wired.
function dropUnwiredOnnxPayload(): Plugin {
  let outDir = "dist";
  return {
    name: "blockdream:drop-unwired-onnx-payload",
    apply: "build",
    configResolved(config) {
      outDir = config.build.outDir;
    },
    // closeBundle runs after Vite's prepareOutDir publicDir copy and the bundle write
    closeBundle() {
      rmSync(resolve(__dirname, outDir, "onnx"), { recursive: true, force: true });
    },
  };
}

export default defineConfig({
  appType: "mpa",
  plugins: [dropUnwiredOnnxPayload()],
  build: {
    // three.js is ~650 kB minified on its own (split into its own chunk below); that's expected,
    // so lift the advisory 500 kB warning to a realistic ceiling rather than leave a noisy build.
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      input: {
        index: resolve(__dirname, "index.html"),
        blockart: resolve(__dirname, "blockart.html"),
        worldmodel: resolve(__dirname, "world-model.html"),
        driving: resolve(__dirname, "driving.html"),
      },
      // split the big three.js dependency into its own cacheable chunk (silences the 500 kB
      // chunk warning and lets the 3D vendor code cache across the MPA's pages)
      output: {
        manualChunks: { three: ["three"] },
      },
    },
  },
});
