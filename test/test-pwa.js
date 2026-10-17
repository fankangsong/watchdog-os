#!/usr/bin/env node
/* PWA 冒烟测试：零依赖。spawn server/index.js 子进程（BASE_PATH=/tkp 验证子路径部署），
 * 逐项验证 manifest / Service Worker / 图标 / 缓存头 / HTML 注入 / 越权防护后自清理。
 *
 * 依赖构建产物 dist/（manifest、sw.js、icons 由 vite 的 pwa 插件生成）：
 * 未先执行 npm run build 时整体 SKIP（与无 bash 环境跳过 Runner 测试同一约定）。
 */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');

const PORT = 3215;
const BASE = `http://127.0.0.1:${PORT}`;
const PREFIX = '/tkp'; // 与 BASE_PATH 一致：验证 basePath 子路径下的 PWA 路径
const ROOT = path.join(__dirname, '..');
const PASSWORD = process.env.PASSWORD || 'test123';
/* JWT 签名密钥为必配项（≥32 字节），自起服务时必须注入，否则服务端 fail-fast 退出 */
const JWT_SECRET = process.env.JWT_SECRET || 'test-only-jwt-secret-0123456789abcdef0123456789';

let passed = 0;
let failed = 0;
function ok(name, cond, extra = '') {
  if (cond) {
    passed++;
    console.log(`PASS ${name}${extra ? ' — ' + extra : ''}`);
  } else {
    failed++;
    console.log(`FAIL ${name}${extra ? ' — ' + extra : ''}`);
  }
}

async function waitHealth() {
  // 首采样可能较慢（printer/docker/df 初始采集），窗口放宽到 30s
  // ⚠️ 必须带 BASE_PATH 前缀：否则 /api/health 不匹配 /tkp/api/ 会被 404
  for (let i = 0; i < 150; i++) {
    try {
      const r = await fetch(`${BASE}${PREFIX}/api/health`);
      if (r.ok) return true;
    } catch { /* 未就绪继续等 */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

/** 读取 PNG 的宽高（IHDR：偏移 16 起 4 字节大端宽 + 4 字节高） */
function pngSize(buf) {
  if (buf.length < 24 || buf[0] !== 0x89 || buf[1] !== 0x50) return null;
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

/** 不发规范化路径的原始请求（fetch 会把 ../ 规范化掉，用 node http 直发） */
function rawGet(hostPort, rawPath) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: rawPath, method: 'GET' }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

(async () => {
  /* dist 产物缺失（未构建）时整体 SKIP */
  const need = ['manifest.webmanifest', 'sw.js', 'icons/icon-192.png', 'icons/icon-maskable-512.png'];
  const missing = need.filter((f) => !fs.existsSync(path.join(ROOT, 'dist', f)));
  if (missing.length > 0) {
    console.log(`SKIP PWA（缺少构建产物：${missing.join(', ')}；请先 npm run build）`);
    process.exit(0);
  }

  const child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      PASSWORD,
      JWT_SECRET,
      BASE_PATH: PREFIX,
      // 显式关闭终端：.env 里 TERMINAL_ENABLED=true 会让测试服务去抢生产 ttyd 的
      // 7681 端口，刷一串 [ttyd] 错误日志（与 PWA 无关，且干扰判断）
      TERMINAL_ENABLED: 'false',
    },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  try {
    ok('server health', await waitHealth());

    /* ---- manifest ---- */
    const mani = await fetch(`${BASE}${PREFIX}/manifest.webmanifest`);
    const maniType = mani.headers.get('content-type') || '';
    ok('manifest 200', mani.status === 200, `status=${mani.status}`);
    ok('manifest MIME', maniType.includes('application/manifest+json'), maniType);
    ok('manifest no-cache', (mani.headers.get('cache-control') || '').includes('no-cache'), mani.headers.get('cache-control') || '');
    let maniJson = null;
    try {
      maniJson = await mani.json();
    } catch { /* 非 JSON */ }
    ok('manifest JSON 可解析', !!maniJson);
    if (maniJson) {
      ok('manifest 基础字段', maniJson.name === 'WatchDog OS' && maniJson.short_name === 'WatchDog');
      ok('manifest display=standalone（Chrome 独立窗口）', maniJson.display === 'standalone', maniJson.display);
      // 相对 start_url/scope：适配任意 basePath（此处解析为 /tkp/）
      const scopeUrl = new URL(maniJson.scope, `${BASE}${PREFIX}/manifest.webmanifest`);
      const startUrl = new URL(maniJson.start_url, `${BASE}${PREFIX}/manifest.webmanifest`);
      ok('manifest scope 覆盖 basePath', scopeUrl.pathname === PREFIX + '/', scopeUrl.pathname);
      ok('manifest start_url 指向面板', startUrl.pathname === PREFIX + '/', startUrl.pathname);
      const sizes = (maniJson.icons || []).map((i) => `${i.sizes}/${i.purpose || 'any'}`);
      ok(
        'manifest 图标含 192/512/maskable',
        ['192x192/any', '512x512/any', '512x512/maskable'].every((s) => sizes.includes(s)),
        sizes.join(' ')
      );
    }

    /* ---- Service Worker ---- */
    const sw = await fetch(`${BASE}${PREFIX}/sw.js`);
    const swType = sw.headers.get('content-type') || '';
    ok('sw.js 200', sw.status === 200, `status=${sw.status}`);
    ok('sw.js MIME', swType.includes('javascript'), swType);
    ok('sw.js no-cache（保证更新可下发）', (sw.headers.get('cache-control') || '').includes('no-cache'), sw.headers.get('cache-control') || '');
    const swText = await sw.text();
    ok('sw.js 占位符已替换', !swText.includes('__PRECACHE__') && !swText.includes('__BUILD_ID__'));
    ok('sw.js 缓存命名含 watchdog-os- 前缀', swText.includes("CACHE_PREFIX = 'watchdog-os-'"));
    ok('sw.js 预缓存外壳与产物', swText.includes("'./'") && swText.includes('./assets/'), '');
    ok('sw.js 预缓存 manifest 与图标', swText.includes('./manifest.webmanifest') && swText.includes('./icons/icon-192.png'));
    ok('sw.js 导航回退逻辑', swText.includes("req.mode === 'navigate'") && swText.includes('Response.error()'));
    ok('sw.js 不缓存 /api/', swText.includes("'/api/'"));

    /* ---- 图标 ---- */
    for (const [name, size] of [['icon-192.png', 192], ['icon-512.png', 512], ['icon-maskable-512.png', 512], ['apple-touch-icon.png', 180]]) {
      const r = await fetch(`${BASE}${PREFIX}/icons/${name}`);
      const buf = Buffer.from(await r.arrayBuffer());
      const dim = pngSize(buf);
      ok(
        `icons/${name} 200 + PNG ${size}x${size}`,
        r.status === 200 && (r.headers.get('content-type') || '').includes('image/png') && dim && dim.w === size && dim.h === size,
        r.status === 200 ? `${dim && dim.w}x${dim && dim.h}` : `status=${r.status}`
      );
      ok(`icons/${name} immutable 长缓存`, (r.headers.get('cache-control') || '').includes('immutable'), r.headers.get('cache-control') || '');
    }

    /* ---- index.html 注入了 manifest 链接 ---- */
    const page = await fetch(`${BASE}${PREFIX}/`);
    const html = await page.text();
    ok('index.html 注入 manifest 链接', html.includes('rel="manifest"') && html.includes('./manifest.webmanifest'));
    ok('index.html 注入 theme-color', html.includes('name="theme-color"'));
    ok('index.html 注入 apple-touch-icon', html.includes('rel="apple-touch-icon"'));

    /* ---- 安全与 404 语义 ---- */
    ok('PWA 文件无需登录（无 Cookie 可达）', mani.status === 200 && sw.status === 200);
    const traversal = await rawGet(PORT, `${PREFIX}/icons/../../server/index.js`);
    ok('目录穿越被拒（非源码）', traversal.status === 404 && !traversal.body.toString().includes("require('crypto')"), `status=${traversal.status}`);
    const badIcon = await fetch(`${BASE}${PREFIX}/icons/evil.txt`);
    ok('icons/ 仅放行 .png', badIcon.status === 404, `status=${badIcon.status}`);
    const unknown = await fetch(`${BASE}${PREFIX}/random.js`);
    ok('其余路径仍 404（SPA 语义不变）', unknown.status === 404, `status=${unknown.status}`);
    const noSlash = await fetch(`${BASE}${PREFIX}`, { redirect: 'manual' });
    ok('无斜杠 BASE 302 到 BASE/', noSlash.status === 302 && (noSlash.headers.get('location') || '') === PREFIX + '/', `status=${noSlash.status}`);
  } finally {
    child.kill();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((e) => {
  console.error('test crashed:', e);
  process.exit(1);
});
