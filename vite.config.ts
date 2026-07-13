import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  root: resolve(__dirname, "src/renderer"),
  base: "./",
  server: {
    // 本地 UI 预览遵循生产 CSP，不启用需要 WebSocket 的 HMR。
    hmr: false,
  },
  build: {
    outDir: resolve(__dirname, "dist/renderer"),
    emptyOutDir: true,
  },
});
