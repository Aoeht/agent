import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";

/**
 * @protocol 指向后端仓库的协议文件：唯一允许跨 web/ 边界 import 的东西，
 * 且前端只用 import type（类型在编译期擦除，不打包任何后端代码）。
 * 开发时代理把 API 转发到 UI 服务器（bun run src/server/main.ts，默认 127.0.0.1:8787）。
 */
const backend = process.env.VITE_BACKEND?.trim() || "http://127.0.0.1:8787";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@protocol": fileURLToPath(new URL("../src/server/protocol.ts", import.meta.url)),
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/sessions": backend,
      "/approvals": backend,
      "/inputs": backend,
      "/status": backend,
      "/models": backend,
      "/settings": backend,
    },
  },
});
