/**
 * Hermes 聊天代理模块（ImcolinApp 数据源）：OpenAI 兼容 API 转发（/api/chat/*）。
 * 从 server.js 原样搬移（原 1126-1216 行），函数体不变。
 */
'use strict';

const http = require('http');
const https = require('https');
const { cfg } = require('../config');
const { send } = require('../lib/http');

/** 会话 ID 白名单：仅字母数字开头的 id/uuid 形态，拒绝路径注入 */
const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** Sessions API 转发超时（列表/历史/删除均为快操作，不沿用 chat 的 300s） */
const SESSIONS_TIMEOUT_MS = 15000;

/**
 * Sessions API 上游 Bearer：优先专用 apiServerKey（API_SERVER_KEY），为空回退 chat apiKey
 */
function hermesAuthKey() {
  return cfg.hermes.apiServerKey || cfg.hermes.apiKey;
}

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
  const authKey = hermesAuthKey();
  if (authKey) headers.Authorization = `Bearer ${authKey}`;
  // 客户端带来的会话关联头：白名单校验后透传上游（让 hermes 把本轮记入同一 transcript）
  const sidIn = req.headers['x-hermes-session-id'];
  if (typeof sidIn === 'string' && SESSION_ID_RE.test(sidIn)) {
    headers['X-Hermes-Session-Id'] = sidIn;
  }

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
      // 2xx：流式/非流式统一逐块 pipe（SSE 透传），透传上游 Content-Type 与会话 ID
      const respHeaders = {
        'Content-Type': upRes.headers['content-type'] || 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      };
      const sidOut = upRes.headers['x-hermes-session-id'];
      if (sidOut) respHeaders['X-Hermes-Session-Id'] = String(sidOut);
      res.writeHead(status, respHeaders);
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

/**
 * 转发 hermes Sessions API（/api/sessions*）：会话列表 / 元数据 / 历史消息 / 删除。
 *  - kind 由 router 完成路径白名单解析后传入：'list' | 'meta' | 'messages' | 'delete'
 *  - id 会话 ID（router 已 decode + 白名单校验；list 时为 null）
 *  - search 原样转发的查询串（limit/offset/inline_images 等）
 *  - 上游 401/403 映射 502：前端 request() 把 watchdog 自身 401 当登出信号，
 *    而 Sessions API 的 401 表示服务端 apiServerKey/apiKey 配错，与用户登录态无关，绝不能透传
 *  - 上游 204/空 body → 规整 200 {ok:true}；2xx JSON 收集-重序列化透传；4xx/5xx 原样透传
 *  - 超时 → 504；连接类错误 → 503
 */
function proxyHermesSessions(req, res, kind, id, search) {
  const h = cfg.hermes;
  const method = kind === 'delete' ? 'DELETE' : 'GET';
  let upstreamUrl;
  try {
    let path = '/api/sessions';
    if (id) path += `/${encodeURIComponent(id)}`;
    if (kind === 'messages') path += '/messages';
    upstreamUrl = new URL(path + (search || ''), h.baseUrl);
  } catch {
    return send(res, 503, { error: 'Hermes unavailable', detail: 'hermes.baseUrl 配置非法' });
  }
  const isHttps = upstreamUrl.protocol === 'https:';
  const lib = isHttps ? https : http;
  const headers = {};
  const authKey = hermesAuthKey();
  if (authKey) headers.Authorization = `Bearer ${authKey}`; // 仅构造上游头，不回写任何响应

  const upReq = lib.request(
    {
      protocol: upstreamUrl.protocol,
      hostname: upstreamUrl.hostname,
      port: upstreamUrl.port || (isHttps ? 443 : 80),
      path: upstreamUrl.pathname + upstreamUrl.search,
      method,
      headers,
      timeout: SESSIONS_TIMEOUT_MS,
    },
    (upRes) => {
      const status = upRes.statusCode || 502;
      const chunks = [];
      upRes.on('data', (c) => chunks.push(c));
      upRes.on('end', () => {
        const body = Buffer.concat(chunks);
        // 上游鉴权失败 → 502（绝不透传 401，防误登出）
        if (status === 401 || status === 403) {
          return send(res, 502, {
            error: 'Hermes auth failed',
            detail: '请检查服务端 hermes.apiServerKey / apiKey 配置',
          });
        }
        if (status >= 400) {
          return send(res, status, body, {
            'Content-Type': upRes.headers['content-type'] || 'application/json; charset=utf-8',
          });
        }
        // DELETE 常见 204 / 空 body → 规整为 200 + JSON，前端无需特判
        if (status === 204 || body.length === 0) return send(res, 200, { ok: true });
        // 2xx：JSON 重序列化透传（非法 JSON 原文透传，由前端适配器容错）
        let out = body.toString('utf8');
        try {
          out = JSON.stringify(JSON.parse(out));
        } catch {
          /* 保留原文 */
        }
        send(res, status, out, {
          'Content-Type': upRes.headers['content-type'] || 'application/json; charset=utf-8',
        });
      });
      upRes.on('error', () => res.destroy());
    }
  );
  // 上游超时 → 504
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
  upReq.end();
}

module.exports = { proxyHermesChat, proxyHermesSessions };
