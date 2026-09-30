import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  build: {
    // 一个 Web 工程，两个入口：
    //   index.html    → 启动器（src-tauri）
    //   frontend.html → 独立前端（frontend/src-tauri）
    // 两边产物都在 dist/ 下，各自用 build.frontendDist 指到它。
    rollupOptions: {
      input: {
        main: "index.html",
        frontend: "frontend.html",
      },
    },
  },
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
    proxy: {
      "/steam-api": {
        target: "https://api.steampowered.com",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/steam-api/, ""),
      },
    },
  },
});
