#!/usr/bin/env node
/* 用量 Dashboard 代理冒烟测试（/api/usage/*）：零依赖。spawn server/index.js 子进程 +
   自起 mock 上游（DeepSeek /user/balance、ZAI quota/limit、恒 401 上游），验证：
   401（未登录）/ 503（未启用）/ 503（本地与 SSH 均无 key）/ 200 转发透传 /
   上游 401→502 / key 留空时经 USAGE_SSH_CMD 读取 hermes 配置并作为上游 Bearer。 */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const PORT = 3218;
const MOCK_GOOD = 3219;
const MOCK_401 = 3220;
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = path.join(__dirname, '..');
const PASSWORD = process.env.PASSWORD || 'test123';
const JWT_SECRET = process.env.JWT_SECRET || 'test-only-jwt-secret-0123456789abcdef0123456789';
/* mock 的 hermes .env：模拟 Mac 上 ~/.hermes/.env 的键名形状 */
const MOCK_SSH_ENV = path.join(os.tmpdir(), 'srv-usage-hermes-env-' + Date.now());

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

/** mock 上游：/user/balance 与 quota/limit 返回 200 并 echo Authorization（断言实际使用的 key）；401 模式恒 401 */
function startMock(port, mode) {
  const srv = http.createServer((req, res) => {
    const auth = req.headers.authorization || '';
    if (mode === '401') {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
    if (req.url === '/api/config/providers') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ providers: {} }));
      return;
    }
    if (req.url === '/user/balance') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          is_available: true,
          auth,
          balance_infos: [{ currency: 'CNY', total_balance: '110.00', granted_balance: '10.00', topped_up_balance: '100.00' }],
        })
      );
      return;
    }
    if (req.url === '/api/monitor/usage/quota/limit') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          code: 200,
          msg: '操作成功',
          success: true,
          auth,
          data: { level: 'pro', limits: [{ type: 'TIME_LIMIT', percentage: 7 }, { type: 'TOKENS_LIMIT', percentage: 44 }, { type: 'TOKENS_LIMIT', percentage: 53 }] },
        })
      );
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });
  return new Promise((resolve) => srv.listen(port, '127.0.0.1', () => resolve(srv)));
}

async function startServer(env) {
  const child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), PASSWORD, JWT_SECRET, BASE_PATH: '/', ...env },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return child;
    } catch { /* 未就绪继续等 */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('server failed to start');
}

async function login() {
  const r = await fetch(`${BASE}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD }),
  });
  return (r.headers.get('set-cookie') || '').split(';')[0];
}

(async () => {
  const mocks = await Promise.all([startMock(MOCK_GOOD, 'good'), startMock(MOCK_401, '401')]);
  const GOOD = `http://127.0.0.1:${MOCK_GOOD}`;

  /* 阶段 1：USAGE_ENABLED=false → 503（未登录 401 优先） */
  let child = await startServer({ USAGE_ENABLED: 'false' });
  try {
    const unauth = await fetch(`${BASE}/api/usage/deepseek`);
    ok('unauth 401', unauth.status === 401, `status=${unauth.status}`);
    const cookie = await login();
    const H = { Cookie: cookie };
    const r1 = await fetch(`${BASE}/api/usage/deepseek`, { headers: H });
    ok('disabled 503', r1.status === 503, `status=${r1.status}`);
    const r2 = await fetch(`${BASE}/api/usage/zai`, { headers: H });
    ok('disabled zai 503', r2.status === 503, `status=${r2.status}`);
  } finally {
    child.kill();
    await new Promise((r) => setTimeout(r, 300));
  }

  /* 阶段 2：启用但本地无 key、SSH 读取失败 → 503 not configured */
  child = await startServer({ USAGE_ENABLED: 'true', USAGE_SSH_CMD: 'false' });
  try {
    const cookie = await login();
    const r = await fetch(`${BASE}/api/usage/deepseek`, { headers: { Cookie: cookie } });
    const body = await r.json();
    ok('no key 503', r.status === 503 && /not configured/.test(body.error || ''), `status=${r.status} body=${JSON.stringify(body)}`);
  } finally {
    child.kill();
    await new Promise((r) => setTimeout(r, 300));
  }

  /* 阶段 3：本地 key 优先（SSH 不参与）→ deepseek 200（auth echo = 本地 key）、zai 上游 401 → 502 */
  child = await startServer({
    USAGE_ENABLED: 'true',
    DEEPSEEK_API_KEY: 'ds-test-key',
    DEEPSEEK_BASE_URL: GOOD,
    ZAI_API_KEY: 'zai-test-key',
    ZAI_BASE_URL: `http://127.0.0.1:${MOCK_401}`,
    USAGE_SSH_CMD: 'false',
  });
  try {
    const cookie = await login();
    const H = { Cookie: cookie };
    const rds = await fetch(`${BASE}/api/usage/deepseek`, { headers: H });
    const ds = await rds.json();
    ok(
      'deepseek 200 passthrough',
      rds.status === 200 && ds.is_available === true && Array.isArray(ds.balance_infos) && ds.balance_infos[0].total_balance === '110.00',
      `status=${rds.status}`
    );
    ok('deepseek local key used', ds.auth === 'Bearer ds-test-key', `auth=${ds.auth}`);
    // auth echo 是 mock 自带的测试字段，其余 body 不得出现 key 明文
    ok('deepseek key not leaked', !JSON.stringify({ ...ds, auth: undefined }).includes('ds-test-key'));
    const rzai = await fetch(`${BASE}/api/usage/zai`, { headers: H });
    ok('zai upstream 401 -> 502', rzai.status === 502, `status=${rzai.status}`);
    const r404 = await fetch(`${BASE}/api/usage/deepseek`, { method: 'POST', headers: H });
    ok('POST 404', r404.status === 404, `status=${r404.status}`);
  } finally {
    child.kill();
    await new Promise((r) => setTimeout(r, 300));
  }

  /* 阶段 4：本地 key 留空 → USAGE_SSH_CMD 读取 mock 的 hermes .env，key 与 DEEPSEEK_BASE_URL 均生效 */
  fs.writeFileSync(
    MOCK_SSH_ENV,
    ['TERMINAL_TIMEOUT=60', 'DEEPSEEK_API_KEY=ds-ssh-key', `DEEPSEEK_BASE_URL=${GOOD}`, 'GLM_API_KEY=zai-ssh-key', '', ''].join('\n')
  );
  child = await startServer({
    USAGE_ENABLED: 'true',
    ZAI_BASE_URL: GOOD,
    USAGE_SSH_CMD: `cat ${MOCK_SSH_ENV}`,
  });
  try {
    const cookie = await login();
    const H = { Cookie: cookie };
    const rds = await fetch(`${BASE}/api/usage/deepseek`, { headers: H });
    const ds = await rds.json();
    ok('ssh key deepseek 200', rds.status === 200 && ds.auth === 'Bearer ds-ssh-key', `status=${rds.status} auth=${ds.auth}`);
    const rzai = await fetch(`${BASE}/api/usage/zai`, { headers: H });
    const zai = await rzai.json();
    ok('ssh key zai 200', rzai.status === 200 && zai.auth === 'Bearer zai-ssh-key', `status=${rzai.status} auth=${zai.auth}`);
  } finally {
    child.kill();
    await new Promise((r) => setTimeout(r, 300));
    try { fs.unlinkSync(MOCK_SSH_ENV); } catch { /* 清理失败不影响结论 */ }
  }

  mocks.forEach((m) => m.close());
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
