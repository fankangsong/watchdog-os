<<<<<<< HEAD
import { defineConfig, loadEnv } from 'vite';
=======
import { defineConfig, type Plugin } from 'vite';
>>>>>>> ba7f650449c3536386296ede92133ccb6ee9b38a
import react from '@vitejs/plugin-react';
/* 项目不引入 @types/node（保持零依赖）：vite.config.ts 会被 tsc --noEmit 检查，
 * 而 node: 内建模块无类型声明会报 TS2307。这里对两行 import 用 @ts-expect-error
 * 抑制（导入绑定退化为 any，对构建插件足够）；__dirname 单独补一条声明。
 * 运行时这些 API 由 Node 真实提供，无任何 polyfill 依赖。 */
// @ts-expect-error 无 @types/node，node:fs 无类型声明（见上方说明）
import { cpSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
// @ts-expect-error 同上
import { join, relative, resolve, sep } from 'node:path';

declare const __dirname: string;

/* ---- PWA（manifest / Service Worker / 图标）：构建末期落进 dist/ ----
 * 为什么不用 vite-plugin-pwa：项目前后端都保持零依赖风格，且安装/离线所需的
 * 文件很少（一个 manifest、一个 sw、四张 PNG），手写插件更直观可控。
 *
 * manifest 与 sw.js 必须放在 basePath 根（如 /tkp/manifest.webmanifest）：
 * sw.js 的 scope 取其所在目录，放错位置（如 assets/ 下）scope 就只覆盖子目录。
 * 因此不走 Vite 的 assets 管线（会被加内容 hash），而是在 closeBundle 原样拷贝，
 * 并用相对 URL（'./'）书写，使同一份产物适配任意 basePath。 */
const PWA_DIR = resolve(__dirname, 'pwa');

/** 递归收集 dist/ 下文件，返回以 dist/ 为根的 './' 相对 URL（供 SW 预缓存） */
function collectDistFiles(dist: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const fp = join(dir, name);
      if (statSync(fp).isDirectory()) walk(fp);
      else out.push('./' + relative(dist, fp).split(sep).join('/'));
    }
  };
  walk(dist);
  return out;
}

function pwaPlugin(): Plugin {
  return {
    name: 'watchdog-os-pwa',
    apply: 'build',
    closeBundle() {
      const dist = resolve(__dirname, 'dist');
      if (!existsSync(PWA_DIR)) return;
      // 1) manifest / 图标 / sw.js 模板原样拷贝到 dist 根（固定路径，无内容 hash）
      cpSync(PWA_DIR, dist, { recursive: true });
      // 2) 由模板生成 dist/sw.js：注入预缓存清单与构建号。
      //    .map 不预缓存（开发排障用，运行时不会请求）；sw.js 自身与 index.html 单独处理
      const precache = collectDistFiles(dist).filter(
        (u) => !u.endsWith('.map') && u !== './sw.js' && u !== './index.html'
      );
      // ⚠️ 必须 replaceAll：文件头注释里也出现占位符字样，单次 replace 会误替换注释、
      // 把代码里的占位符原样漏进产物（SW 一注册就 ReferenceError）
      const sw = readFileSync(join(PWA_DIR, 'sw.js'), 'utf8')
        .replaceAll('__BUILD_ID__', String(Date.now()))
        .replaceAll('__PRECACHE__', JSON.stringify(precache, null, 2));
      writeFileSync(join(dist, 'sw.js'), sw);
      // 3) 给 dist/index.html 注入 PWA 标签：放在源码 <!--pwa--> 占位处（缺失则兜底 </head> 前）。
      //    在最终产物上做字符串替换而非走 transformIndexHtml，避免 Vite 把这些相对 URL
      //    当资产解析、改写进带 hash 的 assets/（那会破坏 manifest/sw 的固定路径）
      const tags = [
        '<link rel="manifest" href="./manifest.webmanifest" />',
        '<meta name="theme-color" content="#7D9EEC" />',
        '<link rel="apple-touch-icon" href="./icons/apple-touch-icon.png" />',
        '<meta name="apple-mobile-web-app-capable" content="yes" />',
        '<meta name="apple-mobile-web-app-title" content="WatchDog OS" />',
        '<meta name="mobile-web-app-capable" content="yes" />',
      ].join('\n    ');
      const idxPath = join(dist, 'index.html');
      let html = readFileSync(idxPath, 'utf8');
      html = html.includes('<!--pwa-->')
        ? html.replace('<!--pwa-->', tags)
        : html.replace('</head>', '    ' + tags + '\n  </head>');
      writeFileSync(idxPath, html);
    },
  };
}

// tsconfig 的 types 仅含 vite/client（未安装 @types/node），按需声明最小 process 形状
declare const process: { cwd(): string; env: Record<string, string | undefined> };

// base: './' 让构建产物使用相对路径引用资源，
// 使 SPA 能在任意 basePath 子路径（如 /tkp/）下直接可用。
<<<<<<< HEAD
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
=======
export default defineConfig({
  base: './',
  // 不启用 Vite 的 publicDir：静态资源统一由根 index.html 引用并打包进 assets/
  // （旧版零依赖前端 public/ 已移除，这里保持关闭以防误建目录导致产物混入无关文件）
  publicDir: false,
  plugins: [react(), pwaPlugin()],
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
>>>>>>> ba7f650449c3536386296ede92133ccb6ee9b38a
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
