// 零依赖 CDP 驱动脚本：验证 hostFsAdapter（方案A）——
//   1. 登录桌面，确认内置 Finder（Macintosh HD）图标存在；
//   2. 确认 classicy FS 已被宿主机真实目录整树替换（localStorage 种子检查）；
//   3. 双击 Finder 图标，确认窗口里出现 FS_ROOTS 真实根目录（Windows 默认 D / C）；
//   4. 确认 EditorApp 已注册为 text_file 处理器（store 检查）；
//   5. 截图留档 .probe/fs-adapter.png。
// 用法: node tools/cdp-fs-adapter-probe.mjs
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const BASE = 'http://localhost:5173/';
const CDP_PORT = 9223; // 避开 chat 探针的 9222
const SHOT_DIR = 'D:/code/watchdog-os/.probe';

function readEnv(key) {
  const txt = readFileSync('D:/code/watchdog-os/.env', 'utf8');
  const m = txt.match(new RegExp(`^${key}=(.*)$`, 'm'));
  return m ? m[1].trim() : '';
}

const PASSWORD = readEnv('PASSWORD');
if (!PASSWORD) {
  console.error('NO PASSWORD in .env');
  process.exit(1);
}

const chrome = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', [
  '--headless=new',
  `--remote-debugging-port=${CDP_PORT}`,
  `--user-data-dir=D:/code/watchdog-os/.probe/chrome-profile-fs-${Date.now()}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-extensions',
  '--window-size=1280,800',
  BASE,
], { stdio: 'ignore' });

async function findPageTarget() {
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
      const list = await res.json();
      const page = list.find((t) => t.type === 'page' && t.url.startsWith('http://localhost:5173'));
      if (page) return page;
    } catch {}
    await sleep(500);
  }
  throw new Error('no page target');
}

const target = await findPageTarget();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let msgId = 0;
const pending = new Map();
const consoleMsgs = [];
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  // 捕获页面 console（classicy 的 RV 日志 / adapter 告警都在这里）
  if (msg.method === 'Runtime.consoleAPICalled') {
    const text = (msg.params.args || [])
      .map((a) => a.value ?? a.description ?? a.type)
      .join(' ');
    consoleMsgs.push(`[${msg.params.type}] ${text.slice(0, 300)}`);
    return;
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    consoleMsgs.push(`[exception] ${JSON.stringify(msg.params.exceptionDetails)?.slice(0, 300)}`);
    return;
  }
  if (msg.id && pending.has(msg.id)) {
    const { res, rej } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) rej(new Error(JSON.stringify(msg.error)));
    else res(msg.result);
  }
};

function send(method, params = {}) {
  const id = ++msgId;
  return new Promise((res, rej) => {
    pending.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

send('Runtime.enable');

async function evaluate(expression, awaitPromise = true) {
  const r = await send('Runtime.evaluate', {
    expression,
    awaitPromise,
    returnByValue: true,
  });
  if (r.exceptionDetails) {
    throw new Error('EVAL ERR: ' + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  }
  return r.result.value;
}

async function waitFor(exprFn, timeout = 20000, interval = 300) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const v = await evaluate(`(${exprFn})()`);
      if (v) return v;
    } catch {}
    await sleep(interval);
  }
  return null;
}

// ---------- 1. 登录 ----------
console.log('== waiting for login form ==');
const hasLogin = await waitFor(`() => !!document.querySelector('#sp-login-password')`, 15000);
if (!hasLogin) {
  console.log('LOGIN FORM NOT FOUND, body:', await evaluate('document.body.innerHTML.slice(0, 300)'));
  process.exit(1);
}
await evaluate(`(() => {
  const el = document.querySelector('#sp-login-password');
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(el, ${JSON.stringify(PASSWORD)});
  el.dispatchEvent(new Event('input', { bubbles: true }));
  const btn = [...document.querySelectorAll('button')].find(b => /Sign In|登录/.test(b.textContent));
  btn && btn.click();
  return true;
})()`);

const desktopReady = await waitFor(`() => !!document.querySelector('#classicyDesktop, [id$=".shortcut"]')`, 20000);
console.log('desktop ready:', !!desktopReady);
await sleep(4000); // 等 reconcile（启动同步）与桌面图标渲染完成

// ---------- 2. FS 种子检查：localStorage 里应已出现宿主机真实目录 ----------
// 注意：snapshot() 用 JSON.stringify(fs, null, 2)，序列化带空格，比较前须去空白
const fsCheck = await evaluate(`(() => {
  const out = {};
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    const v = (localStorage.getItem(k) || '');
    if (!v.includes('_type')) continue;
    let tree;
    try { tree = JSON.parse(v); } catch { continue; }
    const drive = tree && tree['Macintosh HD'];
    if (!drive || drive._type !== 'drive') continue;
    const top = Object.keys(drive).filter((n) => !n.startsWith('_'));
    const firstRoot = top[0] ? drive[top[0]] : null;
    const sub = firstRoot ? Object.keys(firstRoot).filter((n) => !n.startsWith('_')).slice(0, 8) : [];
    out[k] = { topRoots: top, sampleSub: sub, driveType: drive._type, size: v.length };
  }
  return out;
})()`);
console.log('FS SEED:', JSON.stringify(fsCheck, null, 2));
const seedOk = Object.values(fsCheck).some(
  (s) => s.topRoots.length > 0 && s.driveType === 'drive' && !s.topRoots.includes('System Folder')
);
console.log('reconcile replaced tree:', seedOk);

// ---------- 3. 枚举桌面图标并双击 Finder 图标 ----------
const icons = await evaluate(`(() =>
  [...document.querySelectorAll('.classicyDesktopIcon')].map((el) => ({
    id: el.id,
    text: el.textContent.trim().slice(0, 24),
  }))
)()`);
console.log('DESKTOP ICONS:', JSON.stringify(icons));

const dblClicked = await evaluate(`(() => {
  const el = document.querySelector('[id="Finder.app.shortcut"]');
  if (!el) return false;
  const r = el.getBoundingClientRect();
  const opts = { bubbles: true, cancelable: true, view: window, clientX: r.left + r.width/2, clientY: r.top + r.height/2 };
  el.dispatchEvent(new MouseEvent('mousedown', opts));
  el.dispatchEvent(new MouseEvent('mouseup', opts));
  el.dispatchEvent(new MouseEvent('click', opts));
  el.dispatchEvent(new MouseEvent('dblclick', opts));
  return true;
})()`);
console.log('finder icon dblclick dispatched:', dblClicked);
await sleep(2500);

const windowRows = await evaluate(`(() => {
  const wins = [...document.querySelectorAll('div.classicyWindow')].map((el) => ({
    id: el.id,
    title: el.querySelector('.classicyWindowTitleText')?.textContent || '',
    rows: [...el.querySelectorAll('.classicyFileBrowserViewTableRowIconLabel, .classicyTableContainer td:first-child')]
      .map((n) => n.textContent.trim()).filter(Boolean).slice(0, 12),
  }));
  return wins;
})()`);
console.log('FINDER WINDOWS:', JSON.stringify(windowRows, null, 2));

// ---------- 3b. 导航验证：双击第一个根目录行，确认能打开子目录窗口 ----------
const navClicked = await evaluate(`(() => {
  const win = document.querySelector('[id="Finder.app_Macintosh HD"]');
  if (!win) return 'no-window';
  const label = [...win.querySelectorAll('.classicyFileBrowserViewTableRowIconLabel')]
    .find((el) => /^[DC]$/.test(el.textContent.trim()));
  if (!label) return 'no-root-row';
  const row = label.closest('.classicyFileBrowserViewTableRowContainer');
  if (!row) return 'no-row-container';
  const r = row.getBoundingClientRect();
  const opts = { bubbles: true, cancelable: true, view: window, clientX: r.left + r.width/2, clientY: r.top + r.height/2 };
  row.dispatchEvent(new MouseEvent('mousedown', opts));
  row.dispatchEvent(new MouseEvent('mouseup', opts));
  row.dispatchEvent(new MouseEvent('click', opts));
  row.dispatchEvent(new MouseEvent('dblclick', opts));
  return 'dispatched';
})()`);
console.log('navigate into root dir:', navClicked);
await sleep(2500);

const allWindows = await evaluate(`(() =>
  [...document.querySelectorAll('div.classicyWindow')].map((el) => ({
    id: el.id,
    title: el.querySelector('.classicyWindowTitleText')?.textContent || '',
    rowCount: el.querySelectorAll('.classicyFileBrowserViewTableRowContainer').length,
  }))
)()`);
console.log('ALL WINDOWS:', JSON.stringify(allWindows));

// ---------- 3c. 惰性加载验证：继续往更深层双击，确认空壳目录被实时填充 ----------
// SEED_DEPTH=2 只种两层，第 3 层起靠 HostFsLazyLoader 在打开时实时拉取。
// 每轮在 deepest 窗口里按偏好挑目录双击（C → Users → fanka 是确定可读的链路）。
const PREFERRED_BY_ROUND = [
  ['Users', 'Program Files', 'Windows', 'fanka'],
  ['fanka', '.cache', 'Desktop', 'Documents', 'Downloads'],
  ['.cache', '.codebuddy', 'Desktop', 'Documents', 'Downloads'],
];
for (let round = 1; round <= 3; round++) {
  const preferred = PREFERRED_BY_ROUND[round - 1];
  const click = await evaluate(`(() => {
    // 找当前聚焦/最深的 Finder 目录窗口（排除卷根窗口）
    const wins = [...document.querySelectorAll('div.classicyWindow')]
      .filter((el) => el.id.startsWith('Finder.app_Macintosh HD:') && !el.querySelector('.classicyWindowClose')?.classList.contains('disabled'));
    const win = wins[wins.length - 1];
    if (!win) return 'no-deep-window';
    const labels = [...win.querySelectorAll('.classicyFileBrowserViewTableRowIconLabel')]
      .map((el) => el.textContent.trim()).filter(Boolean);
    if (labels.length === 0) return 'empty-window:' + win.id;
    const pick = ${JSON.stringify(preferred)}.find((n) => labels.includes(n)) || labels[0];
    const label = [...win.querySelectorAll('.classicyFileBrowserViewTableRowIconLabel')]
      .find((el) => el.textContent.trim() === pick);
    const row = label.closest('.classicyFileBrowserViewTableRowContainer');
    const r = row.getBoundingClientRect();
    const opts = { bubbles: true, cancelable: true, view: window, clientX: r.left + r.width/2, clientY: r.top + r.height/2 };
    row.dispatchEvent(new MouseEvent('mousedown', opts));
    row.dispatchEvent(new MouseEvent('mouseup', opts));
    row.dispatchEvent(new MouseEvent('click', opts));
    row.dispatchEvent(new MouseEvent('dblclick', opts));
    return 'dispatched:' + win.id + ' -> ' + pick;
  })()`);
  console.log(`deep nav round ${round}:`, click);
  await sleep(4000); // 等 openPaths 更新 → hydrate 异步拉取 → load + bump 重渲染
  const deepWindows = await evaluate(`(() =>
    [...document.querySelectorAll('div.classicyWindow')]
      .filter((el) => el.id.startsWith('Finder.app_Macintosh HD:'))
      .map((el) => ({
        id: el.id,
        rowCount: el.querySelectorAll('.classicyFileBrowserViewTableRowContainer').length,
      }))
  )()`);
  console.log(`windows after round ${round}:`, JSON.stringify(deepWindows));
}

// ---------- 4. Editor 应用存在性检查（文件类型注册在 store 内部，经行为侧间接验证） ----------
const editorIcon = await evaluate(`(() => !!document.querySelector('[id="srv-editor.app.shortcut"]'))()`);
console.log('editor app icon present:', editorIcon);

// ---------- 5. 截图 + console 日志 ----------
const shot = await send('Page.captureScreenshot', { format: 'png' });
if (shot?.data) {
  const { writeFileSync, mkdirSync } = await import('node:fs');
  mkdirSync(SHOT_DIR, { recursive: true });
  writeFileSync(`${SHOT_DIR}/fs-adapter.png`, Buffer.from(shot.data, 'base64'));
  console.log('screenshot saved: .probe/fs-adapter.png');
}
console.log('PAGE CONSOLE (tail):');
for (const m of consoleMsgs.slice(-25)) console.log('  ' + m);

ws.close();
chrome.kill();
process.exit(seedOk && dblClicked ? 0 : 2);
