/*
 * watchdog-os Service Worker —— 离线资源与 Chrome 独立窗口（PWA）支持。
 *
 * ⚠️ 本文件是模板：构建时由 vite.config.ts 的 pwa 插件把「预缓存清单」与
 * 「缓存版本号」两个占位符替换为实际值后拷贝到 dist/sw.js。
 * 请勿手改 dist/sw.js，重新构建即重新生成；也不要引入第三方库（保持零依赖）。
 *
 * 路径语义：sw.js 位于 basePath 根（如 /tkp/sw.js），其 scope 即覆盖整个面板
 * 路径；文件内的 './' 等相对 URL 均相对 sw.js 自身解析，因此同一份产物在
 * '/' 与 '/tkp/' 等任意子路径下都无需改动。
 *
 * 缓存策略：
 * - install：预缓存应用外壳（'./' + 全部构建产物 + manifest + 图标），
 *   按构建号分缓存目录；skipWaiting 让新版本尽快接管
 * - activate：清理旧构建号的缓存，clients.claim 接管已打开页面
 * - navigate（导航）：网络优先，失败回退缓存外壳（离线可打开面板），
 *   成功则顺手更新外壳缓存
 * - 同源静态资源（js/css/图片/manifest）：stale-while-revalidate，
 *   先返回缓存保证秒开，后台拉取更新
 * - /api/：仅走网络（鉴权数据不缓存；离线时由界面自然报错）
 * - 跨域请求：不干预
 */
'use strict';

const BUILD_ID = '__BUILD_ID__';
const CACHE_PREFIX = 'watchdog-os-';
const CACHE_NAME = CACHE_PREFIX + BUILD_ID;
const SHELL_URL = './';

/* 构建产物清单（vite 插件注入；以 dist/ 为根的 './' 相对 URL 数组） */
const PRECACHE = [SHELL_URL].concat(__PRECACHE__);

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      const results = await Promise.allSettled(PRECACHE.map((url) => cache.add(url)));
      const failed = results.filter((r) => r.status === 'rejected').length;
      if (failed > 0) {
        console.warn('[sw] 预缓存失败 ' + failed + '/' + PRECACHE.length + ' 个资源');
      }
      await self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((k) => k.startsWith(CACHE_PREFIX) && k !== CACHE_NAME)
          .map((k) => caches.delete(k))
      );
      await self.clients.claim();
    })()
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  // 只接管同源 GET：其余（POST / WS 升级前的握手 / 跨域）一律放行
  if (req.method !== 'GET') return;
  let url;
  try {
    url = new URL(req.url);
  } catch {
    return;
  }
  if (url.origin !== self.location.origin) return;
  if (url.pathname.indexOf('/api/') !== -1) return;

  /* 导航请求：网络优先，离线回退到缓存外壳 */
  if (req.mode === 'navigate') {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE_NAME);
        try {
          const fresh = await fetch(req);
          if (fresh.ok) cache.put(SHELL_URL, fresh.clone());
          return fresh;
        } catch {
          const cached = await cache.match(SHELL_URL);
          return cached || Response.error();
        }
      })()
    );
    return;
  }

  /* 同源静态资源：缓存优先 + 后台更新 */
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      const hit = await cache.match(req);
      const revalidate = fetch(req)
        .then((res) => {
          if (res.ok) cache.put(req, res.clone());
          return res;
        })
        .catch(() => hit);
      return hit || revalidate;
    })()
  );
});
