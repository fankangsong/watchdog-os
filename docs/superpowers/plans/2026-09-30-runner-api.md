# Runner API 实现计划（远程触发 running_page 构建）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 watchdog-os 后端新增 `/api/runner/*` 接口远程触发 `running_page/build.sh`，并在桌面新增 Runner App（触发按钮 + 状态 + 日志）。

**Architecture:** 复用现有零依赖 server.js 模式：config.json `runner` 配置节（env 覆盖）→ 内存单槽并发锁 + `spawn(shell, [script])` → 日志落盘 `data/runner.log`（超阈值轮转 .old）→ 3 个 REST 接口（start/status/stop，统一 `checkAuth`，401 优先于 503）。前端新增 `RunnerApp`（模式照抄 DockerApp），轮询驱动。

**Tech Stack:** Node.js（零依赖后端）、React 19 + TypeScript + classicy（前端）、Node 原生 `fetch`/`spawn` 冒烟测试。

**Spec:** `docs/superpowers/specs/2026-09-30-runner-api-design.md`

## Global Constraints

- 后端零依赖：只用 Node 内置模块，不新增任何 npm 依赖。
- 脚本路径只来自服务端配置（`cfg.runner.scriptPath`），任何接口不接受客户端传脚本路径。
- 鉴权与 terminal/fs API 同级：统一 `checkAuth`，401 优先于 503。
- 部署目标 Linux（tkp 服务器），但代码与测试须在 Windows（Git Bash）可跑。
- 提交信息风格：`feat(runner): 中文描述`（对齐 git log 现状）。
- 行号锚点基于当前 `server.js`（1290 行）；`replace_in_file` 用上下文片段定位，不依赖纯行号。

---

### Task 1: 后端 Runner API + 冒烟测试（TDD）

**Files:**
- Create: `test-runner-api.js`
- Modify: `server.js`（配置节、env 覆盖、Runner 状态段、shutdown 清理、路由）

**Interfaces:**
- Consumes: `send()`, `checkAuth()`, `spawn`, `cfg`（均已在 server.js 中存在）
- Produces（后续 Task 2 前端依赖的 HTTP 契约）:
  - `POST ./api/runner/start` → 200 `{ ok, jobId, startedAt, script }`；409 `{ error:'Job already running', job }`；400 `{ error:'Script not found' }`；503 `{ error:'Runner disabled' }`；401
  - `GET ./api/runner/status?lines=300` → 200 `{ enabled, script, running, job: {id,startedAt,script,exitCode:null,finishedAt:null} | null, last: {id,startedAt,finishedAt,exitCode,failed,durationMs} | null, log: string }`
  - `POST ./api/runner/stop` → 200 `{ ok, job }`；409 `{ error:'No job running' }`

- [ ] **Step 1: 写测试文件 `test-runner-api.js`（先失败）**

完整内容如下（零依赖，模式对齐 `test-fs-api.js`）：

```js
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
  return spawn(process.execPath, ['server.js'], {
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
    ok('status lines=1', typeof tail.log === 'string' && !tail.log.includes('hello build') && tail.log.includes('exit code'), `log=${JSON.stringify(tail.log).slice(0, 60)}`);

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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node test-runner-api.js`
Expected: FAIL —— 所有 start/status 用例失败（404 not found，路由尚不存在）；`0 passed, N failed`

- [ ] **Step 3: server.js 加 runner 配置节（默认值 + env 覆盖）**

在 `if (!Array.isArray(cfg.terminal.ttydArgs)) cfg.terminal.ttydArgs = ['bash'];`（约 74 行）之后插入：

```js
/* Runner 配置：远程触发脚本任务（如 running_page 的 build.sh）。
   scriptPath 为必配项且只允许服务端配置（config.json / RUNNER_SCRIPT），客户端不可传路径 */
cfg.runner = Object.assign(
  {
    enabled: false,               // 是否启用 Runner API
    scriptPath: '',               // 要执行的脚本绝对路径（必配）
    shell: 'bash',                // 执行 shell（Linux 服务器默认 bash）
    maxLogBytes: 5 * 1024 * 1024, // 日志轮转阈值，超过则 rename 为 .old
  },
  cfg.runner
);
```

在 `if (process.env.TTYD_WSL != null) { ... }` 块（约 83-85 行）之后插入：

```js
if (process.env.RUNNER_ENABLED != null) {
  cfg.runner.enabled = ['1', 'true', 'yes', 'on'].includes(String(process.env.RUNNER_ENABLED).toLowerCase());
}
if (process.env.RUNNER_SCRIPT) cfg.runner.scriptPath = process.env.RUNNER_SCRIPT;
if (process.env.RUNNER_SHELL) cfg.runner.shell = process.env.RUNNER_SHELL;
```

- [ ] **Step 4: server.js 加 Runner 状态管理段**

在 `killWslTtyd()` 函数结束（约 691 行 `}`）与 `/** 退出前清理 ttyd 子进程与重试定时器（systemd stop / Ctrl-C） */` 注释（约 693 行）之间插入整段：

```js
/* ---------------- Runner（脚本任务：远程触发 + 日志回读）---------------- */
const RUNNER_LOG_DIR = path.join(__dirname, 'data');
const RUNNER_LOG_FILE = path.join(RUNNER_LOG_DIR, 'runner.log');
const RUNNER_LOG_OLD = RUNNER_LOG_FILE + '.old';
let runnerProc = null;  // 当前脚本子进程；null 表示空闲
let runnerJob = null;   // 当前 job 元信息 { id, startedAt, script }
let runnerLast = null;  // 最近一次结束的 job 摘要 { id, startedAt, finishedAt, exitCode, failed, durationMs }

/** 生成 job id：YYYYMMDD-HHmmss-xxxx（本地时间 + 4 位随机 hex） */
function runnerNewJobId() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const rnd = crypto.randomBytes(2).toString('hex');
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${rnd}`
  );
}

/**
 * 启动脚本任务。返回 { job } 或 { error, ... }；错误码由路由映射：
 * 'Runner disabled'→503（路由已先行拦截，此处为防御）、'Script not found'→400、'Job already running'→409
 */
function startRunnerJob() {
  const r = cfg.runner;
  if (runnerProc) return { error: 'Job already running', job: runnerJob };
  if (!r.enabled || !r.scriptPath) return { error: 'Runner disabled' };
  const scriptAbs = path.resolve(r.scriptPath);
  let st = null;
  try {
    st = fs.statSync(scriptAbs);
  } catch { /* 不存在 → 下方 400 */ }
  if (!st || !st.isFile()) return { error: 'Script not found' };

  try { fs.mkdirSync(RUNNER_LOG_DIR, { recursive: true }); } catch { /* 已存在忽略 */ }
  // 日志轮转：上次日志超阈值则归档为 .old（构建日志量大，防止单文件无限增长）
  try {
    if (fs.existsSync(RUNNER_LOG_FILE) && fs.statSync(RUNNER_LOG_FILE).size > r.maxLogBytes) {
      fs.renameSync(RUNNER_LOG_FILE, RUNNER_LOG_OLD);
    }
  } catch { /* 轮转失败不阻塞构建 */ }

  const job = { id: runnerNewJobId(), startedAt: Date.now(), script: scriptAbs };
  try {
    fs.appendFileSync(RUNNER_LOG_FILE, `\n===== [${new Date(job.startedAt).toISOString()}] job ${job.id}\n===== $ ${r.shell} ${scriptAbs}\n`, 'utf8');
  } catch { /* 日志失败不阻塞构建 */ }

  let proc;
  try {
    proc = spawn(r.shell, [scriptAbs], {
      cwd: path.dirname(scriptAbs),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
  } catch (e) {
    try { fs.appendFileSync(RUNNER_LOG_FILE, `[spawn error] ${e.message}\n`, 'utf8'); } catch { /* 忽略 */ }
    return { error: 'Spawn failed', detail: e.message };
  }
  runnerProc = proc;
  runnerJob = job;
  const append = (c) => {
    try { fs.appendFileSync(RUNNER_LOG_FILE, c, 'utf8'); } catch { /* 磁盘异常丢日志不崩服务 */ }
  };
  proc.stdout.on('data', append);
  proc.stderr.on('data', append);
  proc.on('error', (e) => append(`[spawn error] ${e.message}\n`));
  proc.on('exit', (code, signal) => {
    append(`[exit code ${code === null ? `null(${signal})` : code}]\n`);
    if (runnerProc !== proc) return;
    const finishedAt = Date.now();
    runnerLast = {
      id: job.id,
      startedAt: job.startedAt,
      finishedAt,
      exitCode: code,
      failed: code !== 0,
      durationMs: finishedAt - job.startedAt,
    };
    runnerProc = null;
    runnerJob = null;
  });
  console.log(`[sysprobe] runner 已启动: job=${job.id} script=${scriptAbs}`);
  return { job };
}

/** 停止当前任务（SIGTERM）；有任务返回 true */
function stopRunnerJob() {
  if (runnerProc) {
    runnerProc.kill('SIGTERM');
    return true;
  }
  return false;
}

/** 读日志尾部 lines 行（文件受 maxLogBytes 轮转约束，整体读入取尾即可） */
function runnerReadLog(lines) {
  try {
    const arr = fs.readFileSync(RUNNER_LOG_FILE, 'utf8').split('\n');
    return arr.slice(Math.max(0, arr.length - lines)).join('\n');
  } catch {
    return '';
  }
}

/** 组装 status 响应体（lines 已由路由裁剪） */
function runnerStatusPayload(lines) {
  return {
    enabled: !!(cfg.runner.enabled && cfg.runner.scriptPath),
    script: cfg.runner.scriptPath || '',
    running: !!runnerProc,
    job: runnerJob ? { ...runnerJob, exitCode: null, finishedAt: null } : null,
    last: runnerLast,
    log: runnerReadLog(lines),
  };
}

```

- [ ] **Step 5: server.js 的 shutdown 与 exit 回调中清理 runner 子进程**

`shutdown()` 内 `if (ttydProc) { ... }` 块（约 701-705 行）之后、`process.exit(0);` 之前插入：

```js
  if (runnerProc) {
    try { runnerProc.kill('SIGTERM'); } catch { /* 已退出忽略 */ }
    runnerProc = null;
  }
```

`process.on('exit', () => { if (ttydProc) { ... } });` 回调内 `if (ttydProc) { ... }` 块之后同样插入：

```js
  if (runnerProc) {
    try { runnerProc.kill('SIGTERM'); } catch { /* 已退出忽略 */ }
  }
```

- [ ] **Step 6: server.js 路由加 /api/runner/*

在 `/* ---- 文件管理 API ... */ if (p.startsWith('/api/fs/')) { ... }` 块（约 1228-1233 行）之后、`/* ---- 静态页面 ---- */` 之前插入：

```js
  /* ---- Runner API（脚本任务触发，统一 JWT 鉴权）---- */
  if (p.startsWith('/api/runner/')) {
    if (!checkAuth(req)) {
      return send(res, 401, { error: 'Unauthorized' }, { 'WWW-Authenticate': 'Bearer' });
    }
    if (!cfg.runner.enabled || !cfg.runner.scriptPath) {
      return send(res, 503, { error: 'Runner disabled' });
    }
    if (p === '/api/runner/status' && method === 'GET') {
      const q = url.searchParams;
      let lines = parseInt(q.get('lines') || '300', 10);
      if (!Number.isFinite(lines) || lines < 1) lines = 300;
      lines = Math.min(lines, 2000);
      return send(res, 200, runnerStatusPayload(lines));
    }
    if (p === '/api/runner/start' && method === 'POST') {
      const r = startRunnerJob();
      if (r.error === 'Job already running') return send(res, 409, { error: r.error, job: r.job });
      if (r.error === 'Script not found') return send(res, 400, { error: r.error });
      if (r.error) return send(res, 500, { error: r.error, detail: r.detail || '' });
      return send(res, 200, { ok: true, jobId: r.job.id, startedAt: r.job.startedAt, script: r.job.script });
    }
    if (p === '/api/runner/stop' && method === 'POST') {
      if (!stopRunnerJob()) return send(res, 409, { error: 'No job running' });
      return send(res, 200, { ok: true, job: runnerJob });
    }
    return send(res, 404, { error: 'not found' });
  }

```

- [ ] **Step 7: 运行测试确认全部通过**

Run: `node test-runner-api.js`
Expected: 全部 PASS（约 19 项），`0 failed`，exit code 0。Windows 本机需已装 Git Bash（PATH 里有 bash）。

- [ ] **Step 8: 回归既有测试**

Run: `node test-fs-api.js; node test-smoke.js`
Expected: 全部 PASS（确认 runner 改动未破坏现有功能）

- [ ] **Step 9: Commit**

```bash
git add server.js test-runner-api.js
git commit -m "feat(runner): 新增脚本任务触发 API 与冒烟测试"
```

---

### Task 2: 前端 API 封装 + RunnerApp + 桌面注册

**Files:**
- Modify: `src/api.ts`（文件末尾追加）
- Create: `src/apps/RunnerApp.tsx`
- Modify: `src/Desktop.tsx`（import + 挂载）

**Interfaces:**
- Consumes: Task 1 的 HTTP 契约（见上）；`request<T>`、`usePolling`、classicy 组件（均为现有代码）
- Produces: `fetchRunnerStatus()` / `startRunnerBuild()` / `stopRunnerBuild()`；`RunnerApp` 组件（props: `{ onLogout?: () => void }`）

- [ ] **Step 1: `src/api.ts` 末尾追加 Runner API 封装**

```ts
/* ---------- Runner（脚本任务触发，如 running_page build.sh）---------- */

/** /api/runner/status 返回的 job：运行中 exitCode/finishedAt 为 null */
export interface RunnerJob {
  id: string;
  startedAt: number;
  script?: string;
  exitCode?: number | null;
  finishedAt?: number | null;
}

/** 最近一次结束的任务摘要 */
export interface RunnerLast {
  id: string;
  startedAt: number;
  finishedAt: number;
  exitCode: number | null;
  failed: boolean;
  durationMs: number;
}

export interface RunnerStatus {
  enabled: boolean;
  script: string;
  running: boolean;
  job: RunnerJob | null;
  last: RunnerLast | null;
  log: string;
}

export const fetchRunnerStatus = () =>
  request<RunnerStatus>('./api/runner/status?lines=400');

export const startRunnerBuild = () =>
  request<{ ok: true; jobId: string; startedAt: number }>('./api/runner/start', { method: 'POST' });

export const stopRunnerBuild = () =>
  request<{ ok: true; job: RunnerJob | null }>('./api/runner/stop', { method: 'POST' });
```

- [ ] **Step 2: 新建 `src/apps/RunnerApp.tsx`**

```tsx
import { useEffect, useRef, useState } from 'react';
import {
  ClassicyApp,
  ClassicyButton,
  ClassicyButtonToolbar,
  ClassicyButtonToolbarGroup,
  ClassicyControlGroup,
  ClassicyIcons,
  ClassicyWindow,
} from 'classicy';
import { fetchRunnerStatus, startRunnerBuild, stopRunnerBuild, Unauthorized } from '../api';
import { usePolling } from '../hooks/usePolling';

const APP_ID = 'srv-runner.app';
const APP_NAME = 'Runner';

function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleString();
}

/** Runner 未启用（后端 503）时的占位提示 */
function DisabledNotice({ error }: { error: Error | null }) {
  const disabled = error && error.message.includes('503');
  if (!disabled) return null;
  return (
    <div style={{ color: '#a00', padding: '8px 12px', fontSize: 12 }}>
      Runner 未启用：需在服务端 config.json 配置 runner.enabled 与 runner.scriptPath
    </div>
  );
}

/** 应用：远程脚本任务（running_page build.sh）触发与日志查看 */
export function RunnerApp({ onLogout }: { onLogout?: () => void }) {
  // 轮询间隔：运行中 2s、空闲 10s（interval 变化会重启 usePolling 定时器）
  const [intervalMs, setIntervalMs] = useState(10000);
  const poll = usePolling(fetchRunnerStatus, intervalMs);
  const running = poll.data?.running === true;

  const [busy, setBusy] = useState(false); // start/stop 请求进行中
  const [actionError, setActionError] = useState('');
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setIntervalMs(running ? 2000 : 10000);
  }, [running]);

  useEffect(() => {
    if (poll.error instanceof Unauthorized) onLogout?.();
  }, [poll.error, onLogout]);

  // 有新日志时滚动到底部（日志查看以尾部为准）
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [poll.data?.log]);

  const appMenu = [
    {
      id: 'sys',
      title: 'System',
      menuChildren: [{ id: 'logout', title: 'Sign Out', onClickFunc: () => onLogout?.() }],
    },
  ];

  const onStart = async () => {
    setBusy(true);
    setActionError('');
    try {
      await startRunnerBuild();
      poll.reload();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const onStop = async () => {
    setBusy(true);
    setActionError('');
    try {
      await stopRunnerBuild();
      poll.reload();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const last = poll.data?.last ?? null;

  return (
    <ClassicyApp id={APP_ID} name={APP_NAME} icon={ClassicyIcons.system.network.terminal} defaultWindow="runner-main">
      <ClassicyWindow
        id="runner-main"
        title={APP_NAME}
        icon={ClassicyIcons.system.network.terminal}
        appId={APP_ID}
        scrollable
        resizable
        zoomable
        collapsable
        closable
        initialSize={[860, 560]}
        initialPosition={['center', 'center']}
        minimumSize={[620, 380]}
        appMenu={appMenu}
      >
        <DisabledNotice error={poll.error} />
        <ClassicyControlGroup label="Task">
          <div style={{ padding: '8px 12px', fontSize: 12, display: 'grid', gap: 6 }}>
            <div>
              状态：
              {running ? (
                <b style={{ color: '#0a0' }}>● Running{poll.data?.job ? `（${poll.data.job.id}）` : ''}</b>
              ) : (
                <span>○ Idle</span>
              )}
            </div>
            <div style={{ color: '#666', wordBreak: 'break-all' }}>脚本：{poll.data?.script || '—'}</div>
            {last && (
              <div>
                上次结果：
                {last.failed ? (
                  <b style={{ color: '#a00' }}>Failed (exit {last.exitCode})</b>
                ) : (
                  <b style={{ color: '#0a0' }}>Success (exit {last.exitCode})</b>
                )}
                {' · '}
                耗时 {fmtDuration(last.durationMs)} · {fmtTime(last.finishedAt)}
              </div>
            )}
            {actionError && <div style={{ color: '#a00' }}>操作失败：{actionError}</div>}
          </div>
        </ClassicyControlGroup>
        <ClassicyControlGroup label="Actions">
          <div style={{ padding: '8px 12px' }}>
            <ClassicyButtonToolbar size="small">
              <ClassicyButtonToolbarGroup>
                <ClassicyButton buttonSize="small" disabled={running || busy} onClickFunc={onStart}>
                  ▶ Build
                </ClassicyButton>
                <ClassicyButton buttonSize="small" disabled={!running || busy} onClickFunc={onStop}>
                  ■ Stop
                </ClassicyButton>
              </ClassicyButtonToolbarGroup>
            </ClassicyButtonToolbar>
          </div>
        </ClassicyControlGroup>
        <ClassicyControlGroup label="Log (tail)">
          <div
            ref={logRef}
            style={{
              margin: '8px 12px 12px',
              height: 240,
              overflow: 'auto',
              background: '#000',
              color: '#ddd',
              fontFamily: 'Consolas, Menlo, monospace',
              fontSize: 11,
              lineHeight: 1.5,
              padding: 8,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-all',
            }}
          >
            {poll.data?.log || (poll.error ? '（无法读取日志）' : '（暂无日志）')}
          </div>
        </ClassicyControlGroup>
      </ClassicyWindow>
    </ClassicyApp>
  );
}
```

- [ ] **Step 3: `src/Desktop.tsx` 注册 RunnerApp**

import 区（`import { EditorApp } from './apps/EditorApp';` 之后）追加：

```tsx
import { RunnerApp } from './apps/RunnerApp';
```

`<ClassicyDesktop>` 内 `<EditorApp onLogout={onLogout} />` 之后追加：

```tsx
        <RunnerApp onLogout={onLogout} />
```

同时把 65 行注释更新为：`// 桌面：系统监控 / Docker / imcolin.fan / 终端 / 文件管理器 / 文本编辑器 / Runner`

- [ ] **Step 4: 构建验证**

Run: `npm run build`
Expected: tsc 类型检查 + vite 构建成功，无 TS 错误

- [ ] **Step 5: 本地手验（可选但推荐）**

Run: `$env:PASSWORD='test123'; $env:RUNNER_ENABLED='1'; $env:RUNNER_SCRIPT='d:\fankangsong\running_page\build.sh'; node server.js`
Expected: 浏览器登录 → 桌面出现 Runner 图标 → 打开窗口看到 Idle 与脚本路径（Windows 上不点 Build，避免触发真实发布；验证留待 Linux 服务器）

- [ ] **Step 6: Commit**

```bash
git add src/api.ts src/apps/RunnerApp.tsx src/Desktop.tsx
git commit -m "feat(runner): 新增桌面 Runner 应用（触发构建与日志查看）"
```

---

### Task 3: 文档更新 + 全量回归

**Files:**
- Modify: `AGENTS.md`（4 处）
- Test: 全量回归命令

**Interfaces:**
- Consumes: Task 1/2 的交付物
- Produces: 文档与实际行为一致；全量回归通过

- [ ] **Step 1: AGENTS.md 常用命令块（21 行 `node test-fs-api.js` 之后）加一行**

```markdown
node test-runner-api.js               # Runner API 冒烟测试（自起自停 server 子进程，无 bash 时跳过）
```

- [ ] **Step 2: AGENTS.md 后端配置表（`diskMounts` 行之后）加 runner 环境变量说明**

在表格后"其余可配置项"行追加 runner 说明，改为：

```markdown
其余可配置项：`collectInterval`（2000ms）、`dockerInterval`（5000ms）、`processInterval`（10000ms）、`processTopN`（50）。

Runner（脚本任务构建）：config.json 的 `runner` 节 / 环境变量 `RUNNER_ENABLED` / `RUNNER_SCRIPT` / `RUNNER_SHELL`（默认 `bash`）控制，`scriptPath` 为必配的脚本绝对路径且只接受服务端配置；日志写 `data/runner.log`（超过 `maxLogBytes` 归档为 `.old`）。
```

- [ ] **Step 3: AGENTS.md 目录结构中 apps 行（约 77 行代码块内）追加 RunnerApp**

将 `apps/` 行改为：

```
  apps/              # 桌面应用窗口：MonitorApp（监控）、DockerApp（容器）、ImcolinApp、TerminalApp（终端）、FileManagerApp（文件管理器）、EditorApp（文本编辑器）、RunnerApp（脚本任务构建）
```

- [ ] **Step 4: AGENTS.md 终端小节（约 100 行）之后、文件管理器小节之前，新增 Runner 小节**

```markdown
### Runner（脚本任务构建，RunnerApp + `/api/runner/*`）

- 后端 `server.js` 以 `spawn(shell, [scriptPath])`（cwd 为脚本所在目录）执行服务端配置的脚本（生产为 running_page 的 `build.sh`），stdout/stderr 合并落盘 `data/runner.log`，构建开始写分隔头、结束写 `[exit code N]`；同时只允许一个任务（内存单槽锁，重复触发 409），`SIGINT/SIGTERM/exit` 时对运行中任务 SIGTERM
- API（统一 `checkAuth`，401 优先于 503 `Runner disabled`）：`POST /api/runner/start`（立即返回，长任务不阻塞）、`GET /api/runner/status?lines=N`（running/job/last 摘要 + 日志尾部，lines 上限 2000）、`POST /api/runner/stop`（SIGTERM 中断）
- 安全约定：脚本路径只来自服务端 `config.json`（`runner.scriptPath`）或 `RUNNER_SCRIPT` 环境变量，客户端不可传路径；能触发 = 能登录（与终端/文件管理同级鉴权）
- 前端 `RunnerApp`：状态区（Idle/Running/上次结果）+ Build/Stop 按钮 + 等宽日志区；轮询间隔运行中 2s、空闲 10s，新日志自动滚底
- ⚠️ `build.sh` 含 `git push` 与 COS 上传等真实发布动作，Windows 本机验证 UI 时不要点击 Build
```

- [ ] **Step 5: AGENTS.md 验证清单（约 133 行 `node test-fs-api.js` 行之后）加一行**

```markdown
- Runner API：`node test-runner-api.js` 全部 PASS（无 bash 环境显示 SKIP 属正常）。
```

- [ ] **Step 6: 全量回归**

Run: `node test-runner-api.js; node test-fs-api.js; node test-smoke.js; node test-basepath.js; npm run build`
Expected: 四个测试脚本全部 PASS（0 failed），构建成功

- [ ] **Step 7: Commit**

```bash
git add AGENTS.md
git commit -m "docs: 补充 Runner 配置与测试说明"
```

---

## Self-Review 记录

1. **Spec 覆盖**：配置节/环境变量 → Task 1 Step 3；三接口与错误码 → Task 1 Step 6 + 测试 Step 1；日志落盘/轮转/job id/并发锁/shutdown 清理 → Task 1 Step 4-5；安全约定 → 配置注释 + 路由（无客户端路径入参）+ 测试（脚本重写在服务端临时文件上做）；api.ts 封装 → Task 2 Step 1；RunnerApp 与注册 → Task 2 Step 2-3；测试 → Task 1 Step 1-2；文档 → Task 3。无缺口。
2. **占位符**：无 TBD/TODO；所有代码步骤均给出完整代码。
3. **类型一致性**：`runnerStatusPayload(lines)` 定义与路由调用一致；status 响应字段（`enabled/script/running/job/last/log`）与 `RunnerStatus` 接口一一对应；start 响应 `{ ok, jobId, startedAt, script }` 与测试断言、前端 `startRunnerBuild` 泛型一致。
