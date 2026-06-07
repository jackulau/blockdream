import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  appType: "mpa",
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
