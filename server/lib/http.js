/**
 * HTTP 基础工具：响应发送、重定向、Cookie 解析、常数时间比较、body 读取、命令执行。
 * 从 server.js 原样搬移（原 166-265 行），函数体不变。
 */
'use strict';

const crypto = require('crypto');
const { execFile } = require('child_process');

function send(res, status, body, headers) {
  const h = Object.assign({ 'Cache-Control': 'no-store' }, headers || {});
  if (typeof body === 'object' && !(body instanceof Buffer)) {
    h['Content-Type'] = 'application/json; charset=utf-8';
    body = JSON.stringify(body);
  }
  res.writeHead(status, h);
  res.end(body);
}

function redirect(res, location) {
  res.writeHead(302, { Location: location, 'Cache-Control': 'no-store' });
  res.end();
}

/** 解析 Cookie 为对象：单pair 的百分号解码失败时保留原始值，本函数保证不抛异常 */
function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie;
  if (!raw) return out;
  for (const pair of raw.split(';')) {
    const i = pair.indexOf('=');
    if (i <= 0) continue;
    const name = pair.slice(0, i).trim();
    const value = pair.slice(i + 1).trim();
    try {
      out[name] = decodeURIComponent(value);
    } catch {
      // 畸形编码（如 sp_token=%）：原样保留，交给上层校验器判定失败 → 401 而非 500
      out[name] = value;
    }
  }
  return out;
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function readBody(req, limit = 4096) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) return reject(new Error('body too large'));
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function runCmd(cmd, args, timeout = 8000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, windowsHide: true }, (err, stdout) => {
      resolve(err ? null : stdout);
    });
  });
}

module.exports = { send, redirect, parseCookies, safeEqual, readBody, runCmd };
