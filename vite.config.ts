import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

// tsconfig 的 types 仅含 vite/client（未安装 @types/node），按需声明最小 process 形状
declare const process: { cwd(): string; env: Record<string, string | undefined> };

// base: './' 让构建产物使用相对路径引用资源，
// 使 SPA 能在任意 basePath 子路径（如 /tkp/）下直接可用。
export default defineConfig(({ mode }) => {
  // 代理目标跟随 .env 的 PORT（默认 3000）：后端实际端口与代理不一致时，
  // Vite 会对所有 /api 返回 500——曾表现为「接口全 500」而后端其实健康（只是端口不同）。
  const env = loadEnv(mode, process.cwd(), '');
  const backendPort = Number(env.PORT) || 3000;
  const backend = `http://127.0.0.1:${backendPort}`;
  return {
    base: './',
    // 不启用 Vite 的 publicDir：静态资源统一由根 index.html 引用并打包进 assets/
    // （旧版零依赖前端 public/ 已移除，这里保持关闭以防误建目录导致产物混入无关文件）
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
      // 开发时直接代理后端 API（端口来自 .env 的 PORT，默认 3000）
      // 注意：终端代理含 WebSocket 升级，需 ws: true 且置于更宽泛的 /api 之前
      proxy: {
        '/api/terminal': { target: backend, changeOrigin: true, ws: true },
        '/api': { target: backend, changeOrigin: true },
      },
    },
  };
});
