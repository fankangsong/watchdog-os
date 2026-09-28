import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// base: './' 让构建产物使用相对路径引用资源，
// 使 SPA 能在任意 basePath 子路径（如 /tkp/）下直接可用。
export default defineConfig({
  base: './',
  // 项目根目录的 public/ 是旧版零依赖前端（server 回退用），
  // 不能作为 Vite 静态资源目录被拷入 dist，否则会与构建产物冲突
  publicDir: false,
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // ⚠️ 必须用 terser：esbuild 压缩会把 @xterm/xterm 中 requestMode 里的
    // `let r;` 声明删掉，留下 `q = {}` 未声明赋值，ES 模块严格模式下抛
    // "assignment to undeclared variable"，导致终端解析管线中断（vim 等
    // 发送 DECRQM `CSI ? 12 $ p` 后画面卡死、看似键盘无响应）。
    minify: 'terser',
  },
  server: {
    port: 5173,
    // 开发时直接代理后端 API（后端默认 3000）
    // 注意：终端代理含 WebSocket 升级，需 ws: true 且置于更宽泛的 /api 之前
    proxy: {
      '/api/terminal': { target: 'http://127.0.0.1:3000', changeOrigin: true, ws: true },
      '/api': { target: 'http://127.0.0.1:3000', changeOrigin: true },
    },
  },
});
