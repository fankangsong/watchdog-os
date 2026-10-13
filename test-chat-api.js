#!/usr/bin/env node
/* Hermes 聊天代理 API 冒烟测试：零依赖。先起本地「模拟 hermes」OpenAI 兼容上游（node:http），
 * 再 spawn server.js 子进程（HERMES_* 环境变量注入），依次验证：
 * 未鉴权 401 / status 信息接口（不含 apiKey）/ 非流式透传 + model 注入 / 流式 SSE 透传 /
 * 上游错误透传 / 未启用 503 / 上游不可达 503 / 上游超时 504。 */
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');

const PORT = 3215;
const MOCK_PORT = 3216;
const BASE = `http://127.0.0.1:${PORT}`;
const MOCK_BASE = `http://127.0.0.1:${MOCK_PORT}`;
const API_KEY = 'test-key-123';
const UNREACHABLE = 'http://127.0.0.1:59997'; // 无监听端口 → 连接拒绝

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
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return true;
    } catch { /* 未就绪继续等 */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

function startServer(extraEnv) {
  // server.js 用脚本自身目录的绝对路径启动，cwd 固定为项目根；显式 BASE_PATH=/ 保证路由可预测
  return spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    cwd: __dirname,
    env: { ...process.env, PORT: String(PORT), PASSWORD: 'test123', BASE_PATH: '/', ...extraEnv },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
}

async function login() {
  const r = await fetch(`${BASE}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'test123' }),
  });
  const { token } = await r.json();
  return { authorization: `Bearer ${token}` };
}

/* ---------------- 模拟 hermes：OpenAI 兼容上游，记录请求供断言 ---------------- */
const mockRequests = []; // { auth, body }
const mock = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    mockRequests.push({ auth: req.headers.authorization || '', body });
    if (req.headers.authorization !== `Bearer ${API_KEY}`) {
      res.writeHead(401, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: 'invalid api key' }));
    }
    let j = {};
    try { j = JSON.parse(body || '{}'); } catch { /* 非 JSON 走默认分支 */ }
    if (j.fail) {
      res.writeHead(500, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'mock upstream boom' } }));
    }
    if (j.slow) {
      // 故意拖延 2s：配合 HERMES_TIMEOUT_MS=300 触发服务端 504
      return setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, late: true }));
      }, 2000);
    }
    if (j.stream) {
      // SSE：data 行 + [DONE] 结束标记
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"content":"hello"}}]}\n\n');
      res.write('data: {"choices":[{"delta":{"content":" world"}}]}\n\n');
      return res.end('data: [DONE]\n\n');
    }
    if (j.streamTools) {
      // SSE：真实 hermes 协议——工具进度经 event: 字段行声明（data JSON 内无 type 字段），
      // 另含 OpenAI 标准 tool_calls 分片与 data.type 风格未知事件，验证纯管道无损透传
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('event: hermes.tool.progress\ndata: {"tool":"terminal","emoji":"\\ud83d\\udcbb","label":"date","toolCallId":"call_1","status":"running"}\n\n');
      res.write('event: hermes.tool.progress\ndata: {"tool":"terminal","toolCallId":"call_1","status":"completed"}\n\n');
      res.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"web_search","arguments":"{\\"q\\":"}}]}}]}\n\n');
      res.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"cats\\"}"}}]}}]}\n\n');
      res.write('data: {"type":"hermes.unknown.v2","foo":"bar"}\n\n');
      res.write('data: {"choices":[{"delta":{"content":"done"}}]}\n\n');
      return res.end('data: [DONE]\n\n');
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'chatcmpl-mock-1',
      object: 'chat.completion',
      model: j.model || 'mock-model',
      choices: [{ index: 0, message: { role: 'assistant', content: 'hi from mock hermes' }, finish_reason: 'stop' }],
    }));
  });
});

async function postCompletions(H, payload) {
  return fetch(`${BASE}/api/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...H },
    body: JSON.stringify(payload),
  });
}

(async () => {
  await new Promise((r) => mock.listen(MOCK_PORT, '127.0.0.1', r));

  /* ---- 实例 1：已启用，上游指向模拟 hermes ---- */
  let child = startServer({
    HERMES_ENABLED: '1',
    HERMES_BASE_URL: MOCK_BASE,
    HERMES_API_KEY: API_KEY,
    HERMES_MODEL: 'mock-injected-model',
  });
  try {
    ok('server health', await waitHealth());
    const H = await login();

    const unauth1 = await fetch(`${BASE}/api/chat/status`);
    ok('unauth status 401', unauth1.status === 401, `status=${unauth1.status}`);
    const unauth2 = await postCompletions({}, { messages: [] });
    ok('unauth completions 401', unauth2.status === 401, `status=${unauth2.status}`);

    const st = await (await fetch(`${BASE}/api/chat/status`, { headers: H })).json();
    ok('status enabled+baseUrl', st.enabled === true && st.baseUrl === MOCK_BASE, JSON.stringify(st));
    ok('status no apiKey leak', !JSON.stringify(st).includes(API_KEY), '');

    /* ---- 非流式透传 + model 注入 ---- */
    const r1 = await postCompletions(H, { messages: [{ role: 'user', content: 'ping' }] });
    ok('non-stream 200', r1.status === 200, `status=${r1.status}`);
    const j1 = await r1.json();
    ok('non-stream body passthrough', j1.object === 'chat.completion' && j1.choices[0].message.content === 'hi from mock hermes', `model=${j1.model}`);
    const rec1 = mockRequests[mockRequests.length - 1];
    ok('upstream auth header', rec1.auth === `Bearer ${API_KEY}`, rec1.auth);
    ok('model injected', JSON.parse(rec1.body).model === 'mock-injected-model', `model=${JSON.parse(rec1.body).model}`);

    /* ---- 客户端自带 model 以客户端为准 ---- */
    await postCompletions(H, { model: 'client-model', messages: [] });
    const rec2 = mockRequests[mockRequests.length - 1];
    ok('client model wins', JSON.parse(rec2.body).model === 'client-model', `model=${JSON.parse(rec2.body).model}`);

    /* ---- 流式 SSE 透传 ---- */
    const r2 = await postCompletions(H, { stream: true, messages: [] });
    const ct = r2.headers.get('content-type') || '';
    const text = await r2.text();
    ok('stream content-type', r2.status === 200 && ct.includes('text/event-stream'), ct);
    ok('stream chunks + DONE', text.includes('"content":"hello"') && text.includes('"content":" world"') && text.includes('data: [DONE]'), `len=${text.length}`);

    /* ---- 流式 SSE：工具事件 / tool_calls 分片 / 未知事件无损透传 ---- */
    const r2t = await postCompletions(H, { streamTools: true, messages: [] });
    const textT = await r2t.text();
    ok('stream tools passthrough', r2t.status === 200 && textT.includes('event: hermes.tool.progress'), `status=${r2t.status}`);
    ok('stream toolCallId passthrough', textT.includes('"toolCallId":"call_1"') && textT.includes('"status":"completed"'), '');
    ok('stream tool_calls chunks passthrough',
      textT.includes('"name":"web_search"') && textT.includes('{\\"q\\":') && textT.includes('\\"cats\\"}'),
      '');
    ok('stream unknown event passthrough', textT.includes('hermes.unknown.v2'), '');
    ok('stream tools DONE', textT.includes('data: [DONE]') && textT.includes('"content":"done"'), '');

    /* ---- 上游 500 透传 ---- */
    const r3 = await postCompletions(H, { fail: true, messages: [] });
    const j3 = await r3.text();
    ok('upstream 500 passthrough', r3.status === 500 && j3.includes('mock upstream boom'), `status=${r3.status}`);
  } finally {
    child.kill('SIGTERM');
  }

  /* ---- 实例 2：未启用 → 503（status 仍 200）；显式禁用，隔离本机 config.json 的 hermes.enabled=true ---- */
  child = startServer({ HERMES_ENABLED: '0' });
  try {
    ok('server2 health', await waitHealth());
    const H2 = await login();
    const st2 = await (await fetch(`${BASE}/api/chat/status`, { headers: H2 })).json();
    ok('disabled status enabled=false', st2.enabled === false, `enabled=${st2.enabled}`);
    const r4 = await postCompletions(H2, { messages: [] });
    const j4 = await r4.json().catch(() => ({}));
    ok('disabled 503', r4.status === 503 && j4.error === 'Hermes chat disabled', `status=${r4.status}`);
  } finally {
    child.kill('SIGTERM');
  }

  /* ---- 实例 3：上游不可达（连接拒绝）→ 503 ---- */
  child = startServer({ HERMES_ENABLED: '1', HERMES_BASE_URL: UNREACHABLE, HERMES_API_KEY: API_KEY });
  try {
    ok('server3 health', await waitHealth());
    const H3 = await login();
    const r5 = await postCompletions(H3, { messages: [] });
    const j5 = await r5.json().catch(() => ({}));
    ok('unreachable 503', r5.status === 503 && j5.error === 'Hermes unavailable', `status=${r5.status}`);
  } finally {
    child.kill('SIGTERM');
  }

  /* ---- 实例 4：上游超时 → 504 ---- */
  child = startServer({
    HERMES_ENABLED: '1',
    HERMES_BASE_URL: MOCK_BASE,
    HERMES_API_KEY: API_KEY,
    HERMES_TIMEOUT_MS: '300',
  });
  try {
    ok('server4 health', await waitHealth());
    const H4 = await login();
    const r6 = await postCompletions(H4, { slow: true, messages: [] });
    const j6 = await r6.json().catch(() => ({}));
    ok('upstream timeout 504', r6.status === 504 && j6.error === 'Hermes timeout', `status=${r6.status}`);
  } finally {
    child.kill('SIGTERM');
  }

  // 清理：关闭模拟上游（含 keep-alive 残留连接）并退出
  try { mock.closeAllConnections?.(); } catch { /* 忽略 */ }
  await new Promise((r) => mock.close(r));

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('测试执行失败:', e);
  try { mock.closeAllConnections?.(); mock.close(); } catch { /* 忽略 */ }
  process.exit(1);
});
