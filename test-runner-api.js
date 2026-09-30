#!/usr/bin/env node
/* Runner API 冒烟测试：零依赖。spawn server.js 子进程（env 注入 runner 配置），
 * 通过重写同一临时脚本内容依次验证 成功构建 / 失败构建 / stop 中断，
 * 再起独立实例验证 400（脚本不存在）与 503（未启用）。系统无 bash 时跳过。 */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 3215;
const BASE = `http://127.0.0.1:${PORT}`;
const TMP = path.join(os.tmpdir(), 'srv-runner-test-' + Date.now());

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

/** bash 可用性探测（Windows 无 Git Bash 时跳过整个测试） */
function bashAvailable() {
  return new Promise((resolve) => {
    const p = spawn('bash', ['-c', 'true'], { stdio: 'ignore', windowsHide: true });
    p.on('error', () => resolve(false));
    p.on('exit', (code) => resolve(code === 0));
  });
}

function startServer(extraEnv) {
  // server.js 用脚本自身目录的绝对路径启动，cwd 固定为项目根，不依赖调用方所在目录
  return spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    cwd: __dirname,
    env: { ...process.env, PORT: String(PORT), PASSWORD: 'test123', ...extraEnv },
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

async function getStatus(H) {
  return (await fetch(`${BASE}/api/runner/status`, { headers: H })).json();
}

/** 轮询直到 running=false，返回最终 status；超时返回 null */
async function waitDone(H, timeoutMs = 15000) {
  for (let i = 0; i < timeoutMs / 300; i++) {
    const s = await getStatus(H);
    if (!s.running) return s;
    await sleep(300);
  }
  return null;
}

(async () => {
  if (!(await bashAvailable())) {
    console.log('SKIP runner-api: 系统无 bash');
    return;
  }
  fs.mkdirSync(TMP, { recursive: true });
  // 同一脚本路径，三个阶段重写内容（脚本路径只来自服务端配置，客户端不可传）
  const scriptPath = path.join(TMP, 'build.sh');
  fs.writeFileSync(scriptPath, '#!/bin/bash\necho hello build\necho "second line"\n', 'utf8');

  let child = startServer({ RUNNER_ENABLED: '1', RUNNER_SCRIPT: scriptPath, RUNNER_SHELL: 'bash' });
  try {
    ok('server health', await waitHealth());
    const H = await login();

    /* ---- 阶段 A：成功构建 ---- */
    const unauth = await fetch(`${BASE}/api/runner/status`);
    ok('unauth 401', unauth.status === 401, `status=${unauth.status}`);

    const s1 = await (await fetch(`${BASE}/api/runner/start`, { method: 'POST', headers: H })).json();
    ok('start ok', s1.ok === true && !!s1.jobId && typeof s1.startedAt === 'number' && s1.script === scriptPath, JSON.stringify(s1));

    const dup = await fetch(`${BASE}/api/runner/start`, { method: 'POST', headers: H });
    ok('dup start 409', dup.status === 409, `status=${dup.status}`);

    const running = await getStatus(H);
    ok('status running', running.running === true && running.job && running.job.id === s1.jobId && running.job.exitCode === null, `running=${running.running}`);

    const done = await waitDone(H);
    ok('job done', !!done, done ? '' : 'timeout');
    ok('exit code 0', !!done && !!done.last && done.last.exitCode === 0 && done.last.failed === false && done.last.id === s1.jobId,
      done && done.last ? `exit=${done.last.exitCode} dur=${done.last.durationMs}ms` : '');
    ok('log tail content', !!done && typeof done.log === 'string' && done.log.includes('hello build'), done ? `logLen=${done.log.length}` : '');
    ok('idle status', !!done && done.running === false && done.job === null && done.enabled === true && done.script === scriptPath, '');

    // lines 截断：只取最后 1 行（[exit code 0]），不含更早的输出行
    const tail = (await (await fetch(`${BASE}/api/runner/status?lines=1`, { headers: H })).json());
    ok('status lines=1', typeof tail.log === 'string' && !tail.log.includes('hello build') && tail.log.includes('exit code'), `log=${String(JSON.stringify(tail.log ?? null)).slice(0, 60)}`);

    /* ---- 阶段 B：失败构建（重写同一脚本为 exit 3）---- */
    await sleep(200); // 等 exit 回调完全落盘
    fs.writeFileSync(scriptPath, '#!/bin/bash\necho "boom" >&2\nsleep 0.3\nexit 3\n', 'utf8');
    const s2 = await (await fetch(`${BASE}/api/runner/start`, { method: 'POST', headers: H })).json();
    ok('start fail-case ok', s2.ok === true, '');
    const done2 = await waitDone(H);
    ok('fail exit 3', !!done2 && !!done2.last && done2.last.exitCode === 3 && done2.last.failed === true, done2 && done2.last ? `exit=${done2.last.exitCode}` : '');
    ok('fail log stderr', !!done2 && done2.log.includes('boom'), '');

    /* ---- 阶段 C：stop 中断（重写为长任务）---- */
    await sleep(200);
    fs.writeFileSync(scriptPath, '#!/bin/bash\necho "long start"\nsleep 30\n', 'utf8');
    const s3 = await (await fetch(`${BASE}/api/runner/start`, { method: 'POST', headers: H })).json();
    ok('start long ok', s3.ok === true, '');
    await sleep(500); // 确保子进程已起来
    const stop = await fetch(`${BASE}/api/runner/stop`, { method: 'POST', headers: H });
    ok('stop 200', stop.status === 200, `status=${stop.status}`);
    const stopDup = await fetch(`${BASE}/api/runner/stop`, { method: 'POST', headers: H });
    ok('stop idle 409', stopDup.status === 409, `status=${stopDup.status}`);
    const done3 = await waitDone(H);
    // Windows 强杀的退出码可能是 1/null，不断言具体值，只断言已结束且留有摘要
    ok('stop terminated', !!done3 && done3.running === false && done3.last !== null, done3 && done3.last ? `exit=${done3.last.exitCode}` : '');
  } finally {
    child.kill('SIGTERM');
  }

  /* ---- 实例 2：脚本不存在 → 400 ---- */
  const missing = path.join(TMP, 'no-such.sh');
  child = startServer({ RUNNER_ENABLED: '1', RUNNER_SCRIPT: missing });
  try {
    ok('server2 health', await waitHealth());
    const H2 = await login();
    const r2 = await fetch(`${BASE}/api/runner/start`, { method: 'POST', headers: H2 });
    ok('script missing 400', r2.status === 400, `status=${r2.status}`);
  } finally {
    child.kill('SIGTERM');
  }

  /* ---- 实例 3：未启用 → 503 ---- */
  child = startServer({});
  try {
    ok('server3 health', await waitHealth());
    const H3 = await login();
    const r3 = await fetch(`${BASE}/api/runner/start`, { method: 'POST', headers: H3 });
    ok('disabled 503', r3.status === 503, `status=${r3.status}`);
    const s3 = await (await fetch(`${BASE}/api/runner/status`, { headers: H3 })).json();
    ok('disabled status enabled=false', s3.enabled === false, `enabled=${s3.enabled}`);
  } finally {
    child.kill('SIGTERM');
  }

  // 清理临时目录与测试产生的项目日志（不动 data/favorites.json）
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 忽略 */ }
  for (const f of ['data/runner.log', 'data/runner.log.old']) {
    try { fs.rmSync(path.join(__dirname, f), { force: true }); } catch { /* 忽略 */ }
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('测试执行失败:', e);
  process.exit(1);
});
