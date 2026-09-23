/**
 * Vite build config for the Vue View (AGENT-OWNED).
 *
 * `npm run build` (run by the pipeline from the project root as
 * `npm --prefix ui run build`) compiles index.html + src/ into `../public`,
 * the directory Rails serves statically. `npm run dev` runs Vite's dev server
 * for tight View iteration, proxying the data plane (/api and the update
 * watcher) to the running app on the manifest's port — start it with
 * `agent-app <dir> serve` (or `dev`) first.
 */
import { readFileSync } from "node:fs";
import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

const manifest = JSON.parse(readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));
const backend = `http://127.0.0.1:${manifest.port ?? 8096}`;

export default defineConfig({
  plugins: [vue()],
  build: {
    outDir: "../public",
    emptyOutDir: true,
  },
  server: {
    proxy: {
      "/api": backend,
      "/_a2app": backend,
    },
  },
});
