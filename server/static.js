/**
 * 静态资源服务：MIME 表与文件读取回包。
 * 从 server.js 原样搬移（原 636-659 行），函数体不变。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { PUBLIC_DIR } = require('./config');
const { send } = require('./lib/http');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
};

function serveFile(res, filename) {
  const fp = path.join(PUBLIC_DIR, filename);
  if (!fp.startsWith(PUBLIC_DIR)) return send(res, 403, { error: 'forbidden' });
  fs.readFile(fp, (err, data) => {
    if (err) return send(res, 404, { error: 'not found' });
    send(res, 200, data, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' });
  });
}

/**
 * SPA 入口：所有页面路径统一返回 dist/index.html，登录 / 仪表盘由前端鉴权态决定。
 * dist/ 缺失（未构建）时返回 503 与可执行的修复提示，而不是 404 白屏 ——
 * 后者会被误判成 basePath 配错或路由被 Nginx 拦掉。
 */
function serveIndex(res) {
  const fp = path.join(PUBLIC_DIR, 'index.html');
  fs.readFile(fp, (err, data) => {
    if (err) {
      const html =
        '<!doctype html><html><head><meta charset="utf-8"><title>WatchDog OS</title></head>' +
        '<body style="font:14px/1.6 Geneva,Verdana,sans-serif;margin:3em auto;max-width:38em;color:#222">' +
        '<h1 style="font-size:1.2em">前端尚未构建</h1>' +
        '<p>未找到构建产物 <code>' +
        PUBLIC_DIR +
        '/index.html</code>，服务端只提供 SPA 产物，不再回退旧版页面。</p>' +
        '<p>请在项目根目录执行：</p><pre style="background:#f2f2f2;padding:.8em;border:1px solid #ccc">npm install\nnpm run build</pre>' +
        '</body></html>';
      return send(res, 503, html, { 'Content-Type': MIME['.html'] });
    }
    send(res, 200, data, { 'Content-Type': MIME['.html'] });
  });
}

/**
 * PWA 静态文件（manifest / Service Worker / 图标）：与 /assets/ 一样零鉴权公开
 * （SW 注册与 manifest 拉取不经过登录态，否则离线与安装都无从谈起），但路径固定
 * （无内容 hash），缓存策略按类型区分：
 * - manifest / sw.js：no-cache。浏览器会缓存 manifest（影响已安装应用的图标与
 *   start_url），SW 脚本也可能被 HTTP 缓存挡住更新——二者必须每次重新验证，
 *   否则会出现「构建更新了但客户端拿旧文件」的幽灵现象；
 * - 图标：内容不变（换图标必改构建），长缓存 immutable。
 * 路径白名单：仅 /manifest.webmanifest、/sw.js、/icons/<单段文件名>（防目录穿越）。
 */
const PWA_FILES = new Set(['manifest.webmanifest', 'sw.js']);
const PWA_ICON_RE = /^icons\/[A-Za-z0-9._-]+\.png$/;

function servePwaFile(res, relPath) {
  if (!PWA_FILES.has(relPath) && !PWA_ICON_RE.test(relPath)) {
    return send(res, 404, { error: 'not found' });
  }
  const fp = path.join(PUBLIC_DIR, relPath);
  if (!fp.startsWith(PUBLIC_DIR + path.sep)) return send(res, 403, { error: 'forbidden' });
  const immutable = relPath.startsWith('icons/');
  fs.readFile(fp, (err, data) => {
    if (err) return send(res, 404, { error: 'not found' });
    send(res, 200, data, {
      'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream',
      'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
  });
}

module.exports = { MIME, serveFile, serveIndex, servePwaFile };
