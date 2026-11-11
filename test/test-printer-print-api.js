#!/usr/bin/env node
/* Files「Print…」后端测试（零依赖）。所有用例都在触达 lp 之前被拒绝，
 * 绝不向真实打印机出纸；lp 选项拼装用纯函数 buildPrintArgs 断言。
 * 真实出纸需 CUPS + 实体打印机，在生产机人工确认。 */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 3217;
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = path.join(__dirname, '..');
const PASSWORD = process.env.PASSWORD || 'test123';
const JWT_SECRET = process.env.JWT_SECRET || 'test-only-jwt-secret-0123456789abcdef0123456789';
let passed = 0, failed = 0;
const ok = (n, c, x = '') => { c ? passed++ : failed++; console.log(`${c ? 'PASS' : 'FAIL'} ${n}${x ? ' — ' + x : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-print-api-'));
const FILES = path.join(TMP, 'root');
fs.mkdirSync(FILES);
fs.writeFileSync(path.join(FILES, 'doc.txt'), 'hello print\n', 'utf8');
fs.writeFileSync(path.join(FILES, 'blob.bin'), Buffer.from([0, 1, 2, 0, 255]));
const abs = path.join(FILES, 'doc.txt');
const goodBody = (over = {}) => ({ path: abs, printer: 'FAKE', paperSize: 'A4', colorMode: 'mono', pageRange: '1-3, 5', ...over });

const printUrl = `${BASE}/api/printer/print`;
const testPageUrl = `${BASE}/api/printer/test-page`;
function startServer(extra) {
  return spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), PASSWORD, JWT_SECRET, BASE_PATH: '/', FS_ROOTS: FILES, PRINTER_INTERVAL: '600000', TERMINAL_ENABLED: '0', ...extra },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
}
async function login() {
  const r = await fetch(`${BASE}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) });
  return { Cookie: (r.headers.get('set-cookie') || '').split(';')[0] };
}
function postPrint(H, body, raw) {
  return fetch(printUrl, { method: 'POST', headers: { ...H, ...(raw ? {} : { 'content-type': 'application/json' }) }, body: raw || JSON.stringify(body) });
}

/* A. 进程内：入参/路径/文件类型校验 + lp 选项拼装（不触达 lp） */
process.env.FS_ROOTS = FILES;
const { printFile, buildPrintArgs } = require('../server/api/printer');
const unitCases = [
  ['bad printer', { printer: '../etc/passwd' }, 'Bad printer name'],
  ['bad paper', { paperSize: 'A4_CUSTOM' }, 'Bad paper size'],
  ['bad color', { colorMode: 'RGB' }, 'Bad color mode'],
  ['bad range', { pageRange: '1-two' }, 'Bad page range'],
  ['outside roots', { path: '/etc/passwd' }, 'Path is outside the allowed roots'],
  ['missing file', { path: path.join(FILES, 'nope.txt') }, 'File not found'],
  ['binary file', { path: path.join(FILES, 'blob.bin') }, 'Unsupported file type'],
];
async function unitTests() {
  for (const [n, over, err] of unitCases) {
    const r = await printFile(goodBody(over));
    ok(`unit ${n}`, r.error === err, `error=${r.error}`);
  }
  const a = buildPrintArgs('FAKE', 'doc.txt', 'A4', 'mono', '1-3,5', abs);
  ok('unit lp printer/title', a.includes('FAKE') && a.includes('doc.txt'), a.join('|'));
  ok('unit lp media=A4', a.includes('media=A4'));
  ok('unit lp monochrome', a.includes('print-color-mode=monochrome') && a.includes('ColorModel=Gray'));
  ok('unit lp page-ranges', a.includes('page-ranges=1-3,5'));
  ok('unit lp path last', a[a.length - 1] === abs);
  const c = buildPrintArgs('FAKE', 'doc.txt', 'Letter', 'color', '', abs);
  ok('unit color options', c.includes('media=Letter') && c.includes('print-color-mode=color') && c.includes('ColorModel=RGB'));
  ok('unit blank range', !c.some((x) => x.startsWith('page-ranges=')));
}

/* B. HTTP：路由/鉴权/状态码（都在 lp 之前返回，不出纸） */
async function httpTests() {
  let child = startServer({ PRINTER_ENABLED: '1' });
  try {
    ok('server health', await waitHealth());
    const H = await login();
    ok('unauth 401', (await postPrint({}, goodBody())).status === 401);
    ok('bad body 400', (await postPrint(H, null, 'not-json{')).status === 400);
    const cases = [
      ['bad paper', { paperSize: 'A4_CUSTOM' }, 400],
      ['outside roots', { path: '/etc/passwd' }, 403],
      ['missing file', { path: path.join(FILES, 'nope.txt') }, 404],
      ['binary file', { path: path.join(FILES, 'blob.bin') }, 400],
      ['printer missing', { printer: 'no-such-printer' }, 404],
    ];
    for (const [n, over, status] of cases) {
      const r = await postPrint(H, goodBody(over));
      ok(`http ${n}`, r.status === status, `status=${r.status}`);
    }
    ok('wrong method 404', (await fetch(printUrl, { headers: H })).status === 404);
    ok('GET /api/printer 200', (await fetch(`${BASE}/api/printer`, { headers: H })).status === 200);
    const tp = await fetch(testPageUrl, { method: 'POST', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify({ printer: 'no-such-printer' }) });
    ok('test-page missing 404', tp.status === 404, `status=${tp.status}`);
  } finally {
    child.kill('SIGTERM');
    await waitPortFree();
  }
  child = startServer({ PRINTER_ENABLED: '0' });
  try {
    ok('server2 health', await waitHealth());
    const H2 = await login();
    ok('disabled 503', (await postPrint(H2, goodBody())).status === 503);
  } finally {
    child.kill('SIGTERM');
    await waitPortFree();
  }
}

(async () => {
  await unitTests();
  await httpTests();
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('测试执行失败:', e);
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(1);
});
