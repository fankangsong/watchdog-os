#!/usr/bin/env node
/*
 * 权威时间接口冒烟测试：零依赖。
 * spawn server/index.js 子进程，关闭 NTP 保证确定性，验证 GET /api/time
 * 为公开接口、字段齐全、时间戳随真实时间前进、时区可被 Intl 解析。
 */
'use strict';
const { spawn } = require('child_process');
const path = require('path');

const PORT = 3227;
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = path.join(__dirname, '..');
const PASSWORD = process.env.PASSWORD || 'test123';
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
  cwd: ROOT,
  env: {
    ...process.env,
    PORT: String(PORT),
    PASSWORD,
    JWT_SECRET,
    BASE_PATH: '/',
    NTP_ENABLED: 'false',
    TIME_ZONE: 'Asia/Shanghai',
  },
  stdio: ['ignore', 'ignore', 'inherit'],
});

async function waitHealth() {
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return true;
    } catch { /* 未就绪继续等 */ }
    await sleep(200);
  }
  return false;
}

(async () => {
  try {
    ok('服务就绪', await waitHealth());

    // 公开接口：不带 Cookie 也应返回 200
    const res = await fetch(`${BASE}/api/time`);
    ok('GET /api/time 无需登录返回 200', res.status === 200, `status=${res.status}`);
    const d = await res.json();

    const fields = ['nowMs', 'timeZone', 'source', 'offsetMs', 'delayMs', 'stratum', 'syncedAt'];
    ok('响应字段齐全', fields.every((k) => k in d), fields.filter((k) => !(k in d)).join(',') || 'all');

    ok('nowMs 为有限数字', Number.isFinite(d.nowMs), String(d.nowMs));
    const drift = Math.abs(d.nowMs - Date.now());
    ok('nowMs 与本机时间接近（<5s）', drift < 5000, `drift=${drift}ms`);

    let tzOk = true;
    try { new Intl.DateTimeFormat('en-US', { timeZone: d.timeZone }); } catch { tzOk = false; }
    ok('timeZone 可被 Intl 解析', tzOk, d.timeZone);
    ok('timeZone 为配置的 Asia/Shanghai', d.timeZone === 'Asia/Shanghai', d.timeZone);

    ok('关闭 NTP 时 source=system', d.source === 'system', d.source);
    ok('关闭 NTP 时 offsetMs=0', d.offsetMs === 0, String(d.offsetMs));
    ok('关闭 NTP 时 syncedAt=null', d.syncedAt === null, String(d.syncedAt));

    // 时间戳应随真实时间前进
    await sleep(1100);
    const res2 = await fetch(`${BASE}/api/time`);
    const d2 = await res2.json();
    const advanced = d2.nowMs - d.nowMs;
    ok('时间戳随真实时间前进（约 1.1s）', advanced >= 900 && advanced <= 2500, `advanced=${advanced}ms`);
  } catch (e) {
    failed++;
    console.error('测试异常:', e);
  } finally {
    child.kill('SIGTERM');
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  }
})();
