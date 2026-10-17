#!/usr/bin/env node
/* Printer 测试页 API 冒烟测试：零依赖。spawn server/index.js 子进程，
 * 验证 鉴权 401 / 名称非法 400 / body 非法 400 / 打印机不存在 404（有 CUPS 时）
 * 或 CUPS 缺失 503（无 CUPS 时）/ 未启用 503 / 方法错误 404。
 * 真实出纸验证需 CUPS + 实体打印机，在 tkp 生产机以 curl 验证，不在本测试范围。 */
'use strict';
const { spawn } = require('child_process');
const path = require('path');

const PORT = 3216;
const BASE = `http://127.0.0.1:${PORT}`;
/* 项目根：入口脚本与子进程 cwd 都必须指向它（config.js 的 diskMounts 缺省值取自 process.cwd()） */
const ROOT = path.join(__dirname, '..');
const PASSWORD = process.env.PASSWORD || 'test123';
/* JWT 签名密钥为必配项（≥32 字节），自起服务时必须注入，否则服务端 fail-fast 退出 */
const JWT_SECRET = process.env.JWT_SECRET || 'test-only-jwt-secret-0123456789abcdef0123456789';

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 等待端口释放：child.kill 是异步的，立刻重启下一个实例会 EADDRINUSE */
async function waitPortFree(timeoutMs = 10000) {
  for (let i = 0; i < timeoutMs / 100; i++) {
    try {
      await fetch(`${BASE}/api/health`);
    } catch {
      return true; // 连接被拒 → 监听已关闭
    }
    await sleep(100);
  }
  return false;
}

function startServer(extraEnv) {
  // 入口脚本用项目根的绝对路径启动，cwd 固定为项目根，不依赖调用方所在目录
  return spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), PASSWORD, JWT_SECRET, BASE_PATH: '/', ...extraEnv },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
}

async function login() {
  const r = await fetch(`${BASE}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD }),
  });
  // 只认 HttpOnly Cookie：取 Set-Cookie 的 name=value 段作为后续请求头
  return { Cookie: (r.headers.get('set-cookie') || '').split(';')[0] };
}

/** POST /api/printer/test-page 的薄封装 */
function post(H, body, raw) {
  return fetch(`${BASE}/api/printer/test-page`, {
    method: 'POST',
    headers: { ...H, ...(raw ? {} : { 'content-type': 'application/json' }) },
    body: raw || JSON.stringify(body),
  });
}

(async () => {
  /* ---- 实例 1：PRINTER_ENABLED=1 ---- */
  let child = startServer({ PRINTER_ENABLED: '1' });
  try {
    ok('server health', await waitHealth());
    const H = await login();

    /* 鉴权：无 Cookie → 401 */
    const unauth = await post({}, { printer: 'L130' });
    ok('unauth 401', unauth.status === 401, `status=${unauth.status}`);

    /* 打印机名非法（含路径分隔符）→ 400，且不该触达 lpstat（先校验再执行） */
    const bad = await post(H, { printer: '../etc/passwd' });
    ok('bad name 400', bad.status === 400, `status=${bad.status}`);

    /* body 非法 JSON → 400 */
    const badBody = await post(H, null, 'not-json{');
    ok('bad body 400', badBody.status === 400, `status=${badBody.status}`);

    /* 不存在的打印机：有 CUPS → 404 Printer not found；无 CUPS（lpstat 缺失）→ 503 CUPS unavailable */
    const missing = await post(H, { printer: 'no-such-printer-xyz' });
    const missingBody = await missing.json().catch(() => ({}));
    ok(
      'missing printer 404/503',
      (missing.status === 404 && missingBody.error === 'Printer not found') ||
        (missing.status === 503 && missingBody.error === 'CUPS unavailable'),
      `status=${missing.status} error=${missingBody.error}`
    );

    /* 错误方法（GET）→ 404 */
    const wrongMethod = await fetch(`${BASE}/api/printer/test-page`, { headers: H });
    ok('wrong method 404', wrongMethod.status === 404, `status=${wrongMethod.status}`);

    /* GET /api/printer 状态接口不受影响（enabled=1 时 200） */
    const status = await fetch(`${BASE}/api/printer`, { headers: H });
    ok('GET /api/printer 200', status.status === 200, `status=${status.status}`);
  } finally {
    child.kill('SIGTERM');
    await waitPortFree();
  }

  /* ---- 实例 2：PRINTER_ENABLED=0（显式置 0，防止本机 .env 的值泄漏）---- */
  child = startServer({ PRINTER_ENABLED: '0' });
  try {
    ok('server2 health', await waitHealth());
    const H2 = await login();
    const r2 = await post(H2, { printer: 'L130' });
    ok('disabled 503', r2.status === 503, `status=${r2.status}`);
    const s2 = await (await fetch(`${BASE}/api/printer`, { headers: H2 })).json();
    ok('disabled status 503', s2.error === 'Printer disabled', `error=${s2.error}`);
  } finally {
    child.kill('SIGTERM');
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('测试执行失败:', e);
  process.exit(1);
});
