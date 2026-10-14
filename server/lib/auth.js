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
    // 固定用 HS256 重算，不读取 header.alg：`alg:none` 与 RS256→HS256 混淆攻击均不成立
    const expect = crypto
      .createHmac('sha256', JWT_SECRET)
      .update(header + '.' + body)
      .digest('base64url');
    if (sig.length !== expect.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) {
      return null;
    }
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    // exp 必须是有限数字：非数字（含字符串 'abc'）比较会得到 NaN 而被判为「未过期」，须显式拦掉
    if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp)) return null;
    if (payload.exp <= Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

/**
 * 从 Cookie 取 JWT 校验。
 * 安全约定：只认 HttpOnly Cookie，不再接受 x-auth-token / Authorization: Bearer ——
 * 令牌不应脱离浏览器使用（可被脚本/curl 直接复用），也是将来引入 CORS 时的隐患。
 * 解析异常视为未通过（parseCookies 已保证不抛异常）。
 */
function checkAuth(req) {
  return !!verifyJwt(parseCookies(req)[COOKIE_NAME] || '');
}

module.exports = { b64url, signJwt, verifyJwt, checkAuth };
