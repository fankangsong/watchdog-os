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

module.exports = { MIME, serveFile };
