#!/usr/bin/env node
/*
 * 登录审计日志 API 冒烟测试：零依赖。
 * spawn server/index.js 子进程（LOGIN_LOG_DIR 指向临时目录），验证
 * 埋点（登录成功/失败/坏 body/登出/401）、脱敏、401 去重、统计聚合、
 * CSV 导出与保留期清理，最后重启一次确认日志可读后自清理。
 */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 3220;
const BASE = `http://127.0.0.1:${PORT}`;
const TMP = path.join(os.tmpdir(), 'wd-audit-test-' + Date.now());
const LOG_DIR = path.join(TMP, 'login-log');
const ROOT = path.join(__dirname, '..');
const PASSWORD = process.env.PASSWORD || 'test123';
const JWT_SECRET = process.env.JWT_SECRET || 'test-only-jwt-secret-0123456789abcdef0123456789';
/* 去重窗口压到 1s：测试里快速连发 401 后等 1.3s 即可看到合并结果 */
const DEDUPE_SEC = 1;
const BRUTE_THRESHOLD = 5;

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

function startServer() {
  return spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      PASSWORD,
      JWT_SECRET,
      BASE_PATH: '/',
      LOGIN_LOG_ENABLED: 'true',
      LOGIN_LOG_DIR: LOG_DIR,
      LOGIN_LOG_RETENTION_DAYS: '3',
      LOGIN_LOG_401_DEDUPE_SEC: String(DEDUPE_SEC),
      LOGIN_LOG_BRUTE_THRESHOLD: String(BRUTE_THRESHOLD),
      LOGIN_LOG_BRUTE_WINDOW_MIN: '10',
    },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
}

async function waitHealth() {
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return true;
    } catch {
      /* 未就绪继续等 */
    }
    await sleep(200);
  }
  return false;
}

/** 读当日全部日志行（JSONL → 对象数组，坏行忽略） */
function readLogLines() {
  if (!fs.existsSync(LOG_DIR)) return [];
  const out = [];
  for (const name of fs.readdirSync(LOG_DIR)) {
    if (!/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)) continue;
    for (const line of fs.readFileSync(path.join(LOG_DIR, name), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        /* 半行（正在写入）忽略 */
      }
    }
  }
  return out;
}

async function postLogin(password, rawBody) {
  return fetch(`${BASE}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: rawBody != null ? rawBody : JSON.stringify({ password }),
  });
}

(async () => {
  // 保留期清理的前置条件：目录里先放一个「过期」日文件（今天之前很久），启动时应被删除
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const staleFile = path.join(LOG_DIR, '2000-01-01.jsonl');
  fs.writeFileSync(staleFile, '{"t":1,"type":"login","ok":true}\n');

  let child = startServer();
  let exited = null;
  child.on('exit', (code) => {
    if (exited === null) exited = code;
  });
  try {
    ok('server health', await waitHealth());
    // 自起服务的护栏：端口上可能是别的实例（例如上次残留的 server），此时 health 也会 200。
    // 审计接口存在时应回 401（未鉴权）——回 404 说明连错的不是本次 spawn 的进程。
    const probe = await fetch(`${BASE}/api/audit/login-log`);
    if (exited !== null || probe.status === 404) {
      throw new Error(
        `端口 ${PORT} 上的服务不是本次启动的实例（child exit=${exited}, audit probe=${probe.status}）` +
          `，请先释放端口：Get-NetTCPConnection -LocalPort ${PORT} | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }`
      );
    }

    /* ---- 1. 登录失败：401 + 落盘（原因、耗时、无凭据） ---- */
    const bad = await postLogin('wrong-password');
    ok('wrong password 401', bad.status === 401, `status=${bad.status}`);
    await sleep(300);
    let logs = readLogLines();
    const badRec = logs.find((e) => e.type === 'login' && e.ok === false && e.reason === 'bad-password');
    ok(
      'failed login logged',
      !!badRec && badRec.status === 401 && badRec.durationMs >= 600 && !!badRec.ip,
      badRec && `ip=${badRec.ip} durationMs=${badRec.durationMs}`
    );

    /* ---- 2. 坏 body：400 + reason=bad-body ---- */
    const broken = await postLogin('', '{not-json');
    ok('bad body 400', broken.status === 400, `status=${broken.status}`);
    await sleep(200);
    ok('bad body logged', readLogLines().some((e) => e.type === 'login' && e.reason === 'bad-body'));

    /* ---- 3. 登录成功：落盘 ok=true 并拿到 Cookie ---- */
    const good = await postLogin(PASSWORD);
    const cookie = (good.headers.get('set-cookie') || '').split(';')[0];
    const H = { Cookie: cookie };
    ok('login 200 + cookie', good.status === 200 && !!cookie, `status=${good.status}`);
    await sleep(200);
    ok(
      'successful login logged',
      readLogLines().some((e) => e.type === 'login' && e.ok === true && e.status === 200)
    );

    /* ---- 4. 脱敏：日志文件里不得出现密码 / Cookie 名 / 令牌 ---- */
    const allText = fs
      .readdirSync(LOG_DIR)
      .filter((n) => n.endsWith('.jsonl'))
      .map((n) => fs.readFileSync(path.join(LOG_DIR, n), 'utf8'))
      .join('');
    ok(
      'no credentials in log',
      !allText.includes(PASSWORD) && !allText.includes('sp_token') && !allText.toLowerCase().includes('authorization'),
      `bytes=${allText.length}`
    );

    /* ---- 5. 未授权访问 ×3：同 IP + 同路径合并为一条 count=3 ---- */
    for (let i = 0; i < 3; i++) await fetch(`${BASE}/api/metrics`);
    await sleep(DEDUPE_SEC * 1000 + 400);
    const unauthRecs = readLogLines().filter((e) => e.type === 'unauthorized' && e.path === '/api/metrics');
    const unauthTotal = unauthRecs.reduce((n, e) => n + (e.count || 1), 0);
    ok(
      '401 deduped into one record',
      unauthRecs.length === 1 && unauthTotal === 3,
      `records=${unauthRecs.length} count=${unauthTotal}`
    );

    /* ---- 6. 审计接口鉴权：未登录 401 ---- */
    const noAuth = await fetch(`${BASE}/api/audit/login-log`);
    ok('audit api requires auth', noAuth.status === 401, `status=${noAuth.status}`);

    /* ---- 7. 统计聚合 ---- */
    const payload = await (await fetch(`${BASE}/api/audit/login-log?days=7&limit=50`, { headers: H })).json();
    ok(
      'payload shape',
      payload.enabled === true &&
        Array.isArray(payload.entries) &&
        Array.isArray(payload.stats.byDay) &&
        payload.stats.byHour.length === 24 &&
        !!payload.meta.retentionDays,
      `entries=${payload.entries?.length} totals=${payload.stats?.total}`
    );
    ok(
      'stats counts',
      payload.stats.success >= 1 && payload.stats.failures >= 2 && payload.stats.unauthorized >= 3,
      `success=${payload.stats.success} failures=${payload.stats.failures} unauthorized=${payload.stats.unauthorized}`
    );
    ok(
      'failure rate / sources',
      payload.stats.failureRate > 0 && payload.stats.sources >= 1 && payload.stats.topSources.length >= 1,
      `rate=${payload.stats.failureRate}% sources=${payload.stats.sources}`
    );
    ok(
      'entries newest first',
      payload.entries.length >= 2 && payload.entries[0].t >= payload.entries[1].t
    );
    ok(
      'recentFailures + newSources',
      payload.stats.recentFailures.length >= 1 && payload.stats.anomalies.newSources.length >= 1,
      `recent=${payload.stats.recentFailures.length} new=${payload.stats.anomalies.newSources.length}`
    );

    /* ---- 8. 筛选：type / ok / ip ---- */
    const onlyFail = await (
      await fetch(`${BASE}/api/audit/login-log?days=7&type=login&ok=failure`, { headers: H })
    ).json();
    ok(
      'filter type=login ok=failure',
      onlyFail.entries.length >= 1 && onlyFail.entries.every((e) => e.type === 'login' && !e.ok),
      `n=${onlyFail.entries.length}`
    );
    const onlyUnauth = await (
      await fetch(`${BASE}/api/audit/login-log?days=7&type=unauthorized`, { headers: H })
    ).json();
    ok(
      'filter type=unauthorized',
      onlyUnauth.entries.length >= 1 && onlyUnauth.entries.every((e) => e.type === 'unauthorized')
    );
    const noMatch = await (
      await fetch(`${BASE}/api/audit/login-log?days=7&ip=203.0.113.250`, { headers: H })
    ).json();
    ok('filter by unknown ip empty', noMatch.entries.length === 0 && noMatch.stats.total === 0);
    const ipHit = await (
      await fetch(`${BASE}/api/audit/login-log?days=7&ip=127.0.0.1`, { headers: H })
    ).json();
    ok('filter by ip hit', ipHit.entries.length >= 1);

    /* ---- 9. CSV：BOM + 表头 + 不受 limit 限制 + 无凭据 ---- */
    const csvRes = await fetch(`${BASE}/api/audit/login-log.csv?days=7&limit=1`, { headers: H });
    const csvBuf = Buffer.from(await csvRes.arrayBuffer());
    // BOM 必须在字节层校验：Response.text() 会把它吞掉
    const csv = csvBuf.toString('utf8');
    const csvLines = csv.trim().split('\r\n');
    ok(
      'csv headers / bom',
      csvRes.status === 200 &&
        (csvRes.headers.get('content-type') || '').includes('text/csv') &&
        (csvRes.headers.get('content-disposition') || '').startsWith('attachment') &&
        csvBuf[0] === 0xef &&
        csvBuf[1] === 0xbb &&
        csvBuf[2] === 0xbf &&
        csvLines[0].includes('Event') &&
        csvLines[0].includes('Source IP'),
      `status=${csvRes.status} lines=${csvLines.length} bom=${csvBuf.slice(0, 3).toString('hex')}`
    );
    ok(
      'csv ignores limit + no secrets',
      csvLines.length - 1 >= payload.entries.length && !csv.includes(PASSWORD) && !csv.includes('sp_token'),
      `rows=${csvLines.length - 1} entries(limit 50)=${payload.entries.length}`
    );

    /* ---- 10. 疑似暴力破解：连续失败达到阈值 ---- */
    for (let i = 0; i < BRUTE_THRESHOLD; i++) await postLogin(`wrong-${i}`);
    await sleep(400);
    const brute = await (await fetch(`${BASE}/api/audit/login-log?days=7&type=login`, { headers: H })).json();
    const hit = (brute.stats.anomalies.bruteForce || []).find((b) => b.count >= BRUTE_THRESHOLD);
    ok(
      'brute force detected',
      !!hit && !!hit.ip && hit.lastSeen >= hit.firstSeen,
      hit ? `ip=${hit.ip} count=${hit.count}` : 'no anomaly'
    );

    /* ---- 11. 登出落盘 ---- */
    await fetch(`${BASE}/api/logout`, { method: 'POST', headers: H });
    await sleep(300);
    ok('logout logged', readLogLines().some((e) => e.type === 'logout' && e.ok === true));

    /* ---- 11b. 登出幂等：无会话也 200 且必须清 Cookie（否则失效 Cookie 会一直粘在浏览器上） ---- */
    const anonLogout = await fetch(`${BASE}/api/logout`, { method: 'POST' });
    const anonClear = anonLogout.headers.get('set-cookie') || '';
    ok(
      'logout without session 200 + clears cookie',
      anonLogout.status === 200 && /sp_token=;/.test(anonClear) && /Max-Age=0/.test(anonClear),
      `status=${anonLogout.status} cookie=${anonClear}`
    );
    await sleep(200);
    ok(
      'anonymous logout not audited',
      !readLogLines().some((e) => e.type === 'logout' && e.ok !== true)
    );

    /* ---- 12. 保留期清理：启动时删掉过期日文件 ---- */
    ok('stale file cleaned', !fs.existsSync(staleFile), staleFile);

    /* ---- 13. 重启后日志仍可读（跨进程持久化） ---- */
    child.kill('SIGTERM');
    await sleep(800);
    child = startServer();
    ok('server restarted', await waitHealth());
    const relogin = await postLogin(PASSWORD);
    const cookie2 = (relogin.headers.get('set-cookie') || '').split(';')[0];
    const after = await (
      await fetch(`${BASE}/api/audit/login-log?days=7`, { headers: { Cookie: cookie2 } })
    ).json();
    ok('log survives restart', after.stats && after.stats.total >= 1, `total=${after.stats?.total}`);
  } finally {
    try {
      child.kill('SIGTERM');
    } catch {
      /* 已退出 */
    }
    await sleep(300);
    fs.rmSync(TMP, { recursive: true, force: true });
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('测试执行失败:', e);
  process.exit(1);
});
