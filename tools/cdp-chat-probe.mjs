// 零依赖 CDP 驱动脚本：登录 watchdog-os，双击 Chat 图标，观察启动窗口
// 用法: node tools/cdp-chat-probe.mjs [--keep-open]
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const BASE = 'http://127.0.0.1:1234/';
const CDP_PORT = 9222;
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
  `--user-data-dir=D:/code/watchdog-os/.probe/chrome-profile-${Date.now()}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-extensions',
  `--window-size=${process.env.PROBE_W ?? 1280},${process.env.PROBE_H ?? 800}`,
  BASE,
], { stdio: 'ignore' });

async function findPageTarget() {
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
      const list = await res.json();
      const page = list.find((t) => t.type === 'page' && t.url.startsWith('http://127.0.0.1:1234'));
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
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
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

const consoleErrors = [];
send('Runtime.enable');
send('Log.enable').catch(() => {});

async function waitFor(exprFn, timeout = 20000, interval = 300) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const v = await evaluate(`(${exprFn})()`);
      if (v) return v;
    } catch (e) {
      // 页面可能正在导航，忽略瞬时错误
    }
    await sleep(interval);
  }
  return null;
}

// ---------- 1. 登录 ----------
console.log('== waiting for login form ==');
const hasLogin = await waitFor(`() => !!document.querySelector('#sp-login-password')`, 15000);
if (!hasLogin) {
  const html = await evaluate('document.body.innerHTML.slice(0, 500)');
  console.log('LOGIN FORM NOT FOUND, body:', html);
  process.exit(1);
}
console.log('== logging in ==');
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
await sleep(2500); // 等桌面图标渲染

// ---------- 2. 找到 Chat 图标并双击 ----------
const chatIconInfo = await evaluate(`(() => {
  const icons = [...document.querySelectorAll('[id]')].filter(el => /chat/i.test(el.id));
  return icons.map(el => ({ id: el.id, tag: el.tagName, cls: el.className }));
})()`);
console.log('chat-ish elements:', JSON.stringify(chatIconInfo));

// classicy 桌面图标 id 形如 `<appId>.shortcut`；双击触发打开
const dblClicked = await evaluate(`(() => {
  const el = document.querySelector('#srv-chat.app.shortcut') ||
             [...document.querySelectorAll('[id]')].find(e => e.id === 'srv-chat.app.shortcut');
  if (!el) return false;
  const r = el.getBoundingClientRect();
  const opts = { bubbles: true, cancelable: true, view: window, clientX: r.left + r.width/2, clientY: r.top + r.height/2 };
  el.dispatchEvent(new MouseEvent('mousedown', opts));
  el.dispatchEvent(new MouseEvent('mouseup', opts));
  el.dispatchEvent(new MouseEvent('click', opts));
  el.dispatchEvent(new MouseEvent('dblclick', opts));
  return true;
})()`);
console.log('chat icon dblclick dispatched:', dblClicked);
await sleep(3000);

// ---------- 3. 观察窗口 DOM ----------
const windowReport = await evaluate(`(() => {
  const wins = [...document.querySelectorAll('div.classicyWindow')].map(el => {
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return {
      id: el.id,
      display: cs.display,
      left: Math.round(r.left),
      top: Math.round(r.top),
      w: Math.round(r.width),
      h: Math.round(r.height),
      title: el.querySelector('.classicyWindowTitleText')?.textContent || '',
    };
  });
  const byId = (s) => document.querySelector('[id="' + s + '"]');
  const sessions = byId('srv-chat.app_chat-sessions');
  const main = byId('srv-chat.app_chat-main');
  return {
    allWindows: wins,
    sessionsExists: !!sessions,
    mainExists: !!main,
  };
})()`);
console.log('WINDOWS:', JSON.stringify(windowReport, null, 2));

// 控制台错误
const errs = await evaluate(`(() => (window.__errs || []).slice(-10))()`).catch(() => []);
console.log('page errors:', JSON.stringify(errs));

// ---------- 4. 截图 ----------
const shot = await send('Page.captureScreenshot', { format: 'png' });
if (shot?.data) {
  const { writeFileSync, mkdirSync } = await import('node:fs');
  mkdirSync(SHOT_DIR, { recursive: true });
  writeFileSync(`${SHOT_DIR}/chat-launch.png`, Buffer.from(shot.data, 'base64'));
  console.log('screenshot saved');
}

ws.close();
chrome.kill();
process.exit(0);
