/**
 * PWA 支持：生产构建注册 Service Worker（离线资源 + Chrome 独立窗口安装）。
 *
 * sw.js 由构建期拷贝到 basePath 根（如 /tkp/sw.js），其 scope 即覆盖整个面板路径。
 * 用 document.baseURI 推导注册地址：面板可能经 /tkp/、/tkp/index.html、/tkp/login
 * 等入口打开，baseURI 都能解析到同源的 /tkp/sw.js（服务端会把无斜杠的 /tkp
 * 302 到 /tkp/）。相对 './sw.js' 直接写死在模块里则依赖页面 URL 形态，不稳妥。
 *
 * 开发模式（vite dev）不注册：dev server 无 dist/sw.js，且 SW 缓存会干扰 HMR。
 */
export function registerPwa(): void {
  if (!import.meta.env.PROD) return;
  if (!('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    const swUrl = new URL('sw.js', document.baseURI);
    navigator.serviceWorker.register(swUrl.href).catch((err) => {
      // 注册失败（如 http 非安全上下文、sw.js 404）不影响面板正常使用，仅失去离线能力
      console.warn('[pwa] Service Worker 注册失败：', err);
    });
  });
}
