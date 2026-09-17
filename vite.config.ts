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
  },
  server: {
    port: 5173,
    // 开发时直接代理后端 API（后端默认 3000）
    proxy: {
      '/api': { target: 'http://127.0.0.1:3000', changeOrigin: true },
    },
  },
});
