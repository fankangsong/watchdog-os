#!/usr/bin/env node
/* Printer 恢复 / 队列任务控制 API 冒烟测试（零依赖）。
 * 所有用例都在触达 CUPS 管理命令之前被拒绝（入参校验 / 打印机不存在 / 未启用），
 * 绝不向真实打印机执行 cupsenable/cupsaccept/lp/cancel；命令拼装用纯函数 buildJobCommand 断言。
 * 真实恢复/暂停/取消/删除需 CUPS + 实体打印机，在生产机人工确认。 */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 3218;
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = path.join(__dirname, '..');
const PASSWORD = process.env.PASSWORD || 'test123';
/* JWT 签名密钥为必配项（≥32 字节），自起服务时必须注入 */
const JWT_SECRET = process.env.JWT_SECRET || 'test-only-jwt-secret-0123456789abcdef0123456789';
let passed = 0, failed = 0;
const ok = (n, c, x = '') => { c ? passed++ : failed++; console.log(`${c ? 'PASS' : 'FAIL'} ${n}${x ? ' — ' + x : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const resumeUrl = `${BASE}/api/printer/resume`;
const jobUrl = `${BASE}/api/printer/job`;
const testPageUrl = `${BASE}/api/printer/test-page`;
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

async function waitHealth() {
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) return true; } catch {}
    await sleep(200);
  }
  return false;
}
async function waitPortFree() {
  for (let i = 0; i < 100; i++) {
    try { await fetch(`${BASE}/api/health`); } catch { return; }
    await sleep(100);
  }
}
function startServer(extra) {
  return spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), PASSWORD, JWT_SECRET, BASE_PATH: '/', PRINTER_INTERVAL: '600000', TERMINAL_ENABLED: '0', ...extra },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
}
async function login() {
  const r = await fetch(`${BASE}/api/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }),
  });
  return { Cookie: (r.headers.get('set-cookie') || '').split(';')[0] };
}
function post(url, H, body, raw) {
  return fetch(url, {
    method: 'POST',
    headers: { ...H, ...(raw ? {} : { 'content-type': 'application/json' }) },
    body: raw || JSON.stringify(body),
  });
}

/* A. 进程内：命令拼装 + 入参校验（都在触达 CUPS 之前返回，不执行任何管理命令） */
const { resumePrinter, controlPrinterJob, buildJobCommand } = require('../server/api/printer');
async function unitTests() {
  ok('unit hold cmd', eq(buildJobCommand('hold', '42'), { cmd: 'lp', args: ['-i', '42', '-H', 'hold'] }));
  ok('unit resume cmd', eq(buildJobCommand('resume', '42'), { cmd: 'lp', args: ['-i', '42', '-H', 'resume'] }));
  ok('unit cancel cmd', eq(buildJobCommand('cancel', '42'), { cmd: 'cancel', args: ['42'] }));
  ok('unit delete cmd', eq(buildJobCommand('delete', '42'), { cmd: 'cancel', args: ['-x', '42'] }));
  ok('unit unknown action cmd', buildJobCommand('nuke', '42') === null);

  ok('unit resume bad name', (await resumePrinter('../etc/passwd')).error === 'Bad printer name');
  ok('unit resume empty name', (await resumePrinter('')).error === 'Bad printer name');
  ok('unit job bad name', (await controlPrinterJob({ printer: '../etc', jobId: '42', action: 'hold' })).error === 'Bad printer name');
  ok('unit job bad id', (await controlPrinterJob({ printer: 'FAKE', jobId: '4;rm', action: 'hold' })).error === 'Bad job id');
  ok('unit job empty id', (await controlPrinterJob({ printer: 'FAKE', jobId: '', action: 'hold' })).error === 'Bad job id');
  ok('unit job bad action', (await controlPrinterJob({ printer: 'FAKE', jobId: '42', action: 'nuke' })).error === 'Bad job action');

  // 合法但打印机不存在：在 checkPrinter（只读 lpstat）处被拒，绝不执行 lp/cancel
  const r = await controlPrinterJob({ printer: 'NO_SUCH_PRINTER_XYZ', jobId: '42', action: 'hold' });
  ok('unit job missing printer', r.error === 'Printer not found' || r.error === 'CUPS unavailable', `error=${r.error}`);
  const rp = await resumePrinter('NO_SUCH_PRINTER_XYZ');
  ok('unit resume missing printer', rp.error === 'Printer not found' || rp.error === 'CUPS unavailable', `error=${rp.error}`);
}

/* C. 成功路径：用临时目录里的假 CUPS 命令顶替 PATH，验证真正执行的命令与参数。
 *    execFile 按注入的 env.PATH 解析可执行文件；全程不触碰真实打印机。 */
async function withMockCups(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-printer-mock-'));
  const log = path.join(dir, 'commands.log');
  const script = (name, body) => fs.writeFileSync(path.join(dir, name), body, { mode: 0o755 });
  // checkPrinter 依赖 lpstat 输出包含 "printer FAKE"
  script('lpstat', '#!/bin/sh\necho "printer FAKE is idle.  enabled since Thu Jan  1 00:00:00 2026"\n');
  const recorder = [
    '#!/bin/sh',
    `printf '%s|%s\\n' "$(basename "$0")" "$*" >> "${log}"`,
    'exit 0',
    '',
  ].join('\n');
  for (const c of ['cupsenable', 'cupsaccept', 'lp', 'cancel']) script(c, recorder);

  const original = process.env.PATH;
  process.env.PATH = `${dir}:${original || ''}`;
  const readLog = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '');
  const clearLog = () => { try { fs.unlinkSync(log); } catch {} };
  try {
    return await fn({ readLog, clearLog });
  } finally {
    process.env.PATH = original;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function mockSuccessTests() {
  await withMockCups(async ({ readLog, clearLog }) => {
    clearLog();
    const r = await resumePrinter('FAKE');
    ok('mock resume ok', r.ok === true && r.printer === 'FAKE', JSON.stringify(r));
    const l1 = readLog();
    ok('mock resume cupsenable', l1.includes('cupsenable|FAKE'), l1.replace(/\n/g, ';'));
    ok('mock resume cupsaccept', l1.includes('cupsaccept|FAKE'), l1.replace(/\n/g, ';'));

    for (const [action, expected] of [
      ['hold', 'lp|-i 42 -H hold'],
      ['resume', 'lp|-i 42 -H resume'],
      ['cancel', 'cancel|42'],
      ['delete', 'cancel|-x 42'],
    ]) {
      clearLog();
      const j = await controlPrinterJob({ printer: 'FAKE', jobId: '42', action });
      ok(`mock job ${action} ok`, j.ok === true && j.action === action, JSON.stringify(j));
      ok(`mock job ${action} cmd`, readLog().trim() === expected, readLog().trim());
    }
  });
}

/* B. HTTP：路由 / 鉴权 / 状态码（都在管理命令之前返回，不出纸、不改 CUPS 状态） */
async function httpTests() {
  let child = startServer({ PRINTER_ENABLED: '1' });
  try {
    ok('server health', await waitHealth());
    const H = await login();

    ok('unauth resume 401', (await post(resumeUrl, {}, { printer: 'FAKE' })).status === 401);
    ok('unauth job 401', (await post(jobUrl, {}, { printer: 'FAKE', jobId: '1', action: 'hold' })).status === 401);

    ok('resume bad body 400', (await post(resumeUrl, H, null, 'not-json{')).status === 400);
    ok('job bad body 400', (await post(jobUrl, H, null, 'not-json{')).status === 400);
    ok('resume bad name 400', (await post(resumeUrl, H, { printer: '../etc' })).status === 400);
    ok('job bad name 400', (await post(jobUrl, H, { printer: '../etc', jobId: '1', action: 'hold' })).status === 400);
    ok('job bad id 400', (await post(jobUrl, H, { printer: 'FAKE', jobId: '1;rm -rf', action: 'hold' })).status === 400);
    ok('job bad action 400', (await post(jobUrl, H, { printer: 'FAKE', jobId: '1', action: 'nuke' })).status === 400);

    // 不存在的打印机：有 CUPS → 404 Printer not found；无 CUPS（lpstat 缺失）→ 503 CUPS unavailable
    const mr = await post(resumeUrl, H, { printer: 'NO_SUCH_PRINTER_XYZ' });
    const mrBody = await mr.json().catch(() => ({}));
    ok(
      'resume missing printer 404/503',
      (mr.status === 404 && mrBody.error === 'Printer not found') ||
        (mr.status === 503 && mrBody.error === 'CUPS unavailable'),
      `status=${mr.status} error=${mrBody.error}`
    );
    const mj = await post(jobUrl, H, { printer: 'NO_SUCH_PRINTER_XYZ', jobId: '1', action: 'hold' });
    const mjBody = await mj.json().catch(() => ({}));
    ok(
      'job missing printer 404/503',
      (mj.status === 404 && mjBody.error === 'Printer not found') ||
        (mj.status === 503 && mjBody.error === 'CUPS unavailable'),
      `status=${mj.status} error=${mjBody.error}`
    );

    ok('resume wrong method 404', (await fetch(resumeUrl, { headers: H })).status === 404);
    ok('job wrong method 404', (await fetch(jobUrl, { headers: H })).status === 404);
    ok('GET /api/printer 200', (await fetch(`${BASE}/api/printer`, { headers: H })).status === 200);
    // 既有写接口未被破坏（仍在校验层被拒）
    ok('test-page still guarded 400', (await post(testPageUrl, H, { printer: '../etc' })).status === 400);
  } finally {
    child.kill('SIGTERM');
    await waitPortFree();
  }

  child = startServer({ PRINTER_ENABLED: '0' });
  try {
    ok('server2 health', await waitHealth());
    const H2 = await login();
    ok('disabled resume 503', (await post(resumeUrl, H2, { printer: 'FAKE' })).status === 503);
    ok('disabled job 503', (await post(jobUrl, H2, { printer: 'FAKE', jobId: '1', action: 'hold' })).status === 503);
    ok('disabled status 503', (await fetch(`${BASE}/api/printer`, { headers: H2 })).status === 503);
  } finally {
    child.kill('SIGTERM');
    await waitPortFree();
  }
}

(async () => {
  await unitTests();
  await mockSuccessTests();
  await httpTests();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('测试执行失败:', e);
  process.exit(1);
});
