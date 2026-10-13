/**
 * Hermes 聊天代理模块（ImcolinApp 数据源）：OpenAI 兼容 API 转发（/api/chat/*）。
 * 从 server.js 原样搬移（原 1126-1216 行），函数体不变。
 */
'use strict';

const http = require('http');
const https = require('https');
const { cfg } = require('../config');
const { send } = require('../lib/http');

/**
 * 转发聊天补全请求到 hermes 上游（POST {baseUrl}/v1/chat/completions）。
 *  - 请求体原样透传（客户端可带 stream:true）；未传 model 时注入 config 的 model
 *  - 非流式：整体收集上游响应后回传（透传状态码与 Content-Type）
 *  - 流式：SSE 逐块 pipe 透传
 *  - 客户端提前断开 → destroy 上游请求，避免 agent 继续空跑
 *  - 超时 → 504；连接类错误（ECONNREFUSED 等）→ 503；上游 4xx/5xx → 原样透传
 *  - apiKey 仅用于构造上游 Authorization 头，不写入任何响应
 */
function proxyHermesChat(req, res, bodyBuf) {
  const h = cfg.hermes;
  let upstreamUrl;
  try {
    upstreamUrl = new URL('/v1/chat/completions', h.baseUrl);
  } catch {
    return send(res, 503, { error: 'Hermes unavailable', detail: 'hermes.baseUrl 配置非法' });
  }
  const isHttps = upstreamUrl.protocol === 'https:';
  const lib = isHttps ? https : http;

  // model 处理：客户端未传时注入 config.model，传了则以客户端为准
  let payload = bodyBuf;
  try {
    const j = JSON.parse(bodyBuf.toString('utf8') || '{}');
    if (j && typeof j === 'object' && !j.model) {
      j.model = h.model;
      payload = Buffer.from(JSON.stringify(j), 'utf8');
    }
  } catch { /* 非 JSON 请求体原样透传，由上游报错并透传 */ }

  const headers = {
    'Content-Type': 'application/json',
    'Content-Length': payload.length,
  };
  if (h.apiKey) headers.Authorization = `Bearer ${h.apiKey}`;

  const upReq = lib.request(
    {
      protocol: upstreamUrl.protocol,
      hostname: upstreamUrl.hostname,
      port: upstreamUrl.port || (isHttps ? 443 : 80),
      path: upstreamUrl.pathname + upstreamUrl.search,
      method: 'POST',
      headers,
      timeout: h.timeoutMs,
    },
    (upRes) => {
      const status = upRes.statusCode || 502;
      // 上游 4xx/5xx：整体收集后原样透传状态码与 body
      if (status >= 400) {
        const chunks = [];
        upRes.on('data', (c) => chunks.push(c));
        upRes.on('end', () => {
          send(res, status, Buffer.concat(chunks), {
            'Content-Type': upRes.headers['content-type'] || 'application/json; charset=utf-8',
          });
        });
        upRes.on('error', () => res.destroy());
        return;
      }
      // 2xx：流式/非流式统一逐块 pipe（SSE 透传），透传上游 Content-Type
      res.writeHead(status, {
        'Content-Type': upRes.headers['content-type'] || 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      upRes.on('error', () => res.destroy());
      upRes.pipe(res);
    }
  );
  // 客户端提前断开 → 中断上游，避免 hermes 继续空跑
  res.on('close', () => {
    if (!res.writableEnded) upReq.destroy();
  });
  // 上游超时 → 504（流式已开始输出时只能直接断开）
  upReq.on('timeout', () => {
    upReq.destroy();
    if (!res.headersSent) send(res, 504, { error: 'Hermes timeout' });
    else res.destroy();
  });
  // 连接类错误（ECONNREFUSED / EHOSTUNREACH / ETIMEDOUT 等）→ 503
  upReq.on('error', (e) => {
    if (res.headersSent || res.writableEnded) {
      res.destroy();
      return;
    }
    send(res, 503, { error: 'Hermes unavailable', detail: e.message });
  });
  upReq.end(payload);
}

module.exports = { proxyHermesChat };
