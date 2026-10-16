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

module.exports = { MIME, serveFile, serveIndex };
