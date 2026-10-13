/**
 * JWT 鉴权（HS256，零依赖）：签名、校验与统一鉴权入口。
 * 从 server.js 原样搬移（原 199-243 行），函数体不变。
 */
'use strict';

const crypto = require('crypto');
const { COOKIE_NAME, JWT_SECRET } = require('../config');
const { parseCookies } = require('./http');

function b64url(s) {
  return Buffer.from(s).toString('base64url');
}

function signJwt(payload) {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify(payload));
  const sig = crypto
    .createHmac('sha256', JWT_SECRET)
    .update(header + '.' + body)
    .digest('base64url');
  return `${header}.${body}.${sig}`;
}

/** 校验 JWT：签名正确且未过期 → 返回 payload，否则 null */
function verifyJwt(token) {
  try {
    const parts = String(token).split('.');
    if (parts.length !== 3) return null;
    const [header, body, sig] = parts;
    const expect = crypto
      .createHmac('sha256', JWT_SECRET)
      .update(header + '.' + body)
      .digest('base64url');
    if (sig.length !== expect.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) {
      return null;
    }
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

/** 从 cookie / Bearer / x-auth-token 取 JWT 校验 */
function checkAuth(req) {
  const token =
    parseCookies(req)[COOKIE_NAME] ||
    req.headers['x-auth-token'] ||
    (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '') ||
    '';
  return !!verifyJwt(token);
}

module.exports = { b64url, signJwt, verifyJwt, checkAuth };
