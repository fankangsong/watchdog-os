#!/usr/bin/env node
/* Chat Sessions API 冒烟测试：零依赖。
 * 起 mock hermes（/api/sessions* + /v1/chat/completions SSE + 鉴权观测端点 /_last），
 * spawn server.js 子进程，验证：
 *   鉴权 401 / apiServerKey 透传 / apiServerKey 缺省回退 apiKey /
 *   messages 路径与 query 透传 / DELETE 204 规整 200 / 上游 401→502（防误登出）/
 *   非法 id→400 / 多级路径→404 / mock 停机→503 / completions 会话头双向透传 */
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');

const W_PORT = 3217; // watchdog server
const M_PORT = 3216; // mock hermes
const W_BASE = `http://127.0.0.1:${W_PORT}`;

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- mock hermes ---------- */
const mockState = {
  mode: 'ok', // 'ok' | 'authfail'（/api/sessions* 返回 401）
  lastAuth: '', // 最近一次请求的 Authorization 头
  lastPath: '', // 最近一次 /api/sessions* 请求的上游路径（含 query）
  lastMethod: '',
  lastChatSid: '', // 最近一次 completions 收到的 x-hermes-session-id
};
const mock = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/_last') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(mockState));
    return;
  }
  mockState.lastAuth = req.headers.authorization || '';
  if (url.pathname.startsWith('/api/sessions')) {
    if (mockState.mode === 'authfail') {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'bad key' }));
      return;
    }
    mockState.lastPath = req.url;
    mockState.lastMethod = req.method;
    if (req.method === 'DELETE') {
      res.writeHead(204);
      res.end();
      return;
    }
    if (url.pathname.endsWith('/messages')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          messages: [
            { role: 'user', content: 'Hi' },
            { role: 'assistant', content: 'Hello!', reasoning_content: 'think...' },
            { role: 'tool', content: 'ignored' }, // 非 user/assistant 角色应被前端适配器跳过
          ],
        })
      );
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        sessions: [
          { id: 's-1', title: 'Hello', updated_at: '2026-10-14T00:00:00Z', message_count: 2 },
        ],
      })
    );
    return;
  }
  if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
    mockState.lastChatSid = req.headers['x-hermes-session-id'] || '';
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'X-Hermes-Session-Id': 'srv-sid-123',
    });
    res.write('data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n');
    res.write('data: [DONE]\n\n');
    res.end();
    return;
  }
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
});

function startServer(extraEnv) {
  return spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    cwd: __dirname,
    env: {
      ...process.env,
      PORT: String(W_PORT),
      PASSWORD: 'test123',
      BASE_PATH: '/',
      TERMINAL_ENABLED: 'false',
      ...extraEnv,
    },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
}

async function waitHealth() {
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`${W_BASE}/api/health`);
      if (r.ok) return true;
    } catch { /* 未就绪继续等 */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

async function stopServer(child) {
  child.kill('SIGTERM');
  for (let i = 0; i < 100; i++) {
    try {
      await fetch(`${W_BASE}/api/health`);
    } catch {
      return;
    }
    await sleep(100);
  }
}

async function login() {
  const r = await fetch(`${W_BASE}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'test123' }),
  });
  const { token } = await r.json();
  return { authorization: `Bearer ${token}` };
}

async function lastMock() {
  const r = await fetch(`http://127.0.0.1:${M_PORT}/_last`);
  return r.json();
}

(async () => {
  await new Promise((r) => mock.listen(M_PORT, '127.0.0.1', r));

  /* 实例 A：apiServerKey 已配置 */
  let server = startServer({
    HERMES_ENABLED: '1',
    HERMES_BASE_URL: `http://127.0.0.1:${M_PORT}`,
    HERMES_API_KEY: 'fallback-key',
    HERMES_API_SERVER_KEY: 'server-key',
  });
  ok('server up', await waitHealth());
  const auth = await login();

  // 1. 无鉴权 → 401（watchdog 自身 JWT）
  let r = await fetch(`${W_BASE}/api/chat/sessions`);
  ok('no auth -> 401', r.status === 401, `status=${r.status}`);

  // 2. 会话列表：上游收到 Bearer server-key
  r = await fetch(`${W_BASE}/api/chat/sessions?limit=50`, { headers: auth });
  let body = await r.json();
  ok('list -> 200', r.status === 200, `status=${r.status}`);
  ok('list body passthrough', Array.isArray(body.sessions) && body.sessions[0].id === 's-1');
  ok('upstream auth = server-key', (await lastMock()).lastAuth === 'Bearer server-key');

  // 3. messages：路径与 query 透传
  r = await fetch(`${W_BASE}/api/chat/sessions/s-1/messages?inline_images=false`, { headers: auth });
  body = await r.json();
  ok('messages -> 200', r.status === 200 && Array.isArray(body.messages), `status=${r.status}`);
  const m = await lastMock();
  ok('messages path passthrough', m.lastPath === '/api/sessions/s-1/messages?inline_images=false', m.lastPath);

  // 4. DELETE：上游 204 → 规整 200 {ok:true}
  r = await fetch(`${W_BASE}/api/chat/sessions/s-1`, { method: 'DELETE', headers: auth });
  body = await r.json();
  ok('delete -> 200 {ok:true}', r.status === 200 && body.ok === true, `status=${r.status}`);
  ok('delete method passthrough', (await lastMock()).lastMethod === 'DELETE');

  // 5. 非法 id → 400（decode 后白名单拒绝）
  r = await fetch(`${W_BASE}/api/chat/sessions/abc%2Fdef`, { headers: auth });
  ok('id with slash -> 400', r.status === 400, `status=${r.status}`);
  // 注：'/..' 会被 Node URL 规范化掉，用编码形态构造穿越
  r = await fetch(`${W_BASE}/api/chat/sessions/..%2Fetc`, { headers: auth });
  ok('encoded traversal id -> 400', r.status === 400, `status=${r.status}`);

  // 6. 多级路径 → 404
  r = await fetch(`${W_BASE}/api/chat/sessions/x/y/z`, { headers: auth });
  ok('deep path -> 404', r.status === 404, `status=${r.status}`);

  // 7. completions 会话头双向透传
  r = await fetch(`${W_BASE}/api/chat/completions`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json', 'X-Hermes-Session-Id': 'my-sid' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }], stream: true }),
  });
  ok('completions -> 200', r.status === 200, `status=${r.status}`);
  ok('response sid passthrough', r.headers.get('x-hermes-session-id') === 'srv-sid-123');
  await r.text(); // 消费 body
  ok('request sid passthrough', (await lastMock()).lastChatSid === 'my-sid');

  // 8. 上游 401 → 502（绝不透传 401，防误登出）
  mockState.mode = 'authfail';
  r = await fetch(`${W_BASE}/api/chat/sessions`, { headers: auth });
  ok('upstream 401 -> 502', r.status === 502, `status=${r.status}`);
  mockState.mode = 'ok';

  await stopServer(server);

  /* 实例 B：apiServerKey 未配置 → 回退 apiKey */
  server = startServer({
    HERMES_ENABLED: '1',
    HERMES_BASE_URL: `http://127.0.0.1:${M_PORT}`,
    HERMES_API_KEY: 'fallback-key',
  });
  ok('server B up', await waitHealth());
  const auth2 = await login();
  r = await fetch(`${W_BASE}/api/chat/sessions`, { headers: auth2 });
  ok('fallback list -> 200', r.status === 200, `status=${r.status}`);
  ok('upstream auth = fallback apiKey', (await lastMock()).lastAuth === 'Bearer fallback-key');

  // 9. mock 停机 → 503
  await new Promise((r) => mock.close(r));
  r = await fetch(`${W_BASE}/api/chat/sessions`, { headers: auth2 });
  ok('mock down -> 503', r.status === 503, `status=${r.status}`);

  await stopServer(server);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
