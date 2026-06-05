import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  appType: "mpa",
  build: {
    rollupOptions: {
      input: {
        index: resolve(__dirname, "index.html"),
        blockart: resolve(__dirname, "blockart.html"),
        worldmodel: resolve(__dirname, "world-model.html"),
      },
    },
  },
});
