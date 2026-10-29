#!/usr/bin/env node
/* 会话收尾回归测试（src/session.ts）：零依赖。
   守护两条安全底线（用户报障：点 Sign Out 不跳登录页、本地会话存储没清）：
     1. 退出后与会话相关的 localStorage（classicy 持久化的桌面/应用数据、最近文件、聊天记录）必须删除，
        纯外观偏好（字号/主题）应保留；
     2. 退出只能收尾一次（并发 401 / 重复点击不会重复导航）；
     3. 退出必须留下一次性「刚退出」标记，供重载后的 App 直接落在登录页；
     4. notifyUnauthorized（任一接口 401）与主动退出走同一条路径；
     5. 存储被禁用（隐私模式）时不得抛错、仍要完成导航。
   加载方式：优先直接 import .ts（Node ≥22 自带类型擦除），失败再退回 esbuild 转译（两者都不可用则 SKIP）。 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// 注意：必须用 fileURLToPath（Windows 下 URL.pathname 形如 /D:/…，直接 path.join 会拼出 \D:\…）
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src', 'session.ts');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'srv-session-'));

let passed = 0;
let failed = 0;
function ok(name, cond, extra = '') {
  if (cond) {
    passed += 1;
    console.log(`PASS ${name}${extra ? ' — ' + extra : ''}`);
  } else {
    failed += 1;
    console.log(`FAIL ${name}${extra ? ' — ' + extra : ''}`);
  }
}

/* ---------- 浏览器存储桩：语义对齐 Storage ---------- */
function makeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    get length() {
      return map.size;
    },
    key: (i) => [...map.keys()][i] ?? null,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => void map.set(k, String(v)),
    removeItem: (k) => void map.delete(k),
    clear: () => map.clear(),
    dump: () => Object.fromEntries(map),
  };
}

const PRESERVED = ['srv-editor-prefs', 'srv-terminal-prefs', 'srv-finder-prefs'];
const SESSION_KEYS = [
  'classicyDesktopState',
  'classicyStorage',
  'classicyStorage:seq',
  'srv-editor-recent',
  'watchdog-chat-history',
  'watchdog-chat-sessions',
  'watchdog-chat-session:abc',
];

function seed() {
  const all = {};
  for (const k of [...SESSION_KEYS, ...PRESERVED]) all[k] = 'x';
  globalThis.localStorage = makeStorage(all);
  globalThis.sessionStorage = makeStorage();
  const replaced = [];
  globalThis.window = {
    location: { href: 'http://127.0.0.1:3000/tkp/', replace: (url) => replaced.push(url) },
  };
  return replaced;
}

/* 每个场景全新模块实例：session.ts 有模块级 ending 标志，必须重新加载 */
let caseNo = 0;
let loadSession;

async function prepareLoader() {
  // ① Node 自带 TS 类型擦除：直接 import（query 作缓存击碎键，得到全新模块实例）
  try {
    await import(`${pathToFileURL(SRC).href}?probe=1`);
    loadSession = () => import(`${pathToFileURL(SRC).href}?case=${++caseNo}`);
    return true;
  } catch {
    /* 继续尝试 esbuild */
  }
  // ② esbuild 转译（与 test-favorites-store.mjs 同一模式）
  try {
    const esbuild = await import('esbuild');
    const out = path.join(TMP, 'session.mjs');
    await esbuild.build({
      entryPoints: [SRC],
      bundle: true,
      format: 'esm',
      platform: 'node',
      outfile: out,
      logLevel: 'silent',
    });
    loadSession = () => import(`${pathToFileURL(out).href}?case=${++caseNo}`);
    return true;
  } catch {
    return false;
  }
}

(async () => {
  if (!(await prepareLoader())) {
    console.log('SKIP 会话收尾测试（当前 Node 不支持直接 import .ts，且 esbuild 不可用）');
    fs.rmSync(TMP, { recursive: true, force: true });
    process.exit(0);
  }

  /* 场景 1：主动退出的清存储范围 */
  {
    seed();
    const s = await loadSession();
    s.clearClientSession();
    const left = Object.keys(localStorage.dump());
    ok(
      'clears all session keys',
      SESSION_KEYS.every((k) => !left.includes(k)),
      `left=${left.join(',') || '(none)'}`
    );
    ok(
      'keeps pure ui prefs',
      PRESERVED.every((k) => left.includes(k)),
      `kept=${left.filter((k) => PRESERVED.includes(k)).join(',')}`
    );
  }

  /* 场景 2：endSession 一次性收尾（并发 401 不重复导航） */
  {
    const replaced = seed();
    const s = await loadSession();
    s.endSession();
    s.endSession(); // 并发 401 / 重复点击
    ok('navigates exactly once', replaced.length === 1, `calls=${replaced.length} url=${replaced[0] || ''}`);
    ok('navigates to current url', replaced[0] === 'http://127.0.0.1:3000/tkp/');
    ok('clears storage on sign out', !('classicyDesktopState' in localStorage.dump()));
    ok('sets signed-out flag', sessionStorage.getItem('wd-signed-out') === '1');
  }

  /* 场景 3：「刚退出」标记一次性消费 */
  {
    seed();
    const s = await loadSession();
    s.endSession();
    ok('flag consumed first time', s.consumeSignedOutFlag() === true);
    ok('flag not sticky', s.consumeSignedOutFlag() === false);
    ok('flag removed from storage', sessionStorage.getItem('wd-signed-out') === null);
  }

  /* 场景 4：401（notifyUnauthorized）与主动退出同一路径 */
  {
    const replaced = seed();
    const s = await loadSession();
    s.notifyUnauthorized();
    ok(
      '401 path clears storage + navigates',
      replaced.length === 1 && !('classicyStorage' in localStorage.dump()),
      `calls=${replaced.length}`
    );
  }

  /* 场景 5：存储不可用时不得抛错（隐私模式 / 禁用 storage） */
  {
    const denied = {
      get length() {
        throw new Error('denied');
      },
      key: () => {
        throw new Error('denied');
      },
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
      removeItem: () => {
        throw new Error('denied');
      },
    };
    globalThis.localStorage = denied;
    globalThis.sessionStorage = denied;
    const replaced = [];
    globalThis.window = { location: { href: '/', replace: (u) => replaced.push(u) } };
    const s = await loadSession();
    let threw = false;
    try {
      s.endSession();
    } catch {
      threw = true;
    }
    ok('survives denied storage', !threw && replaced.length === 1);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('测试执行失败:', e);
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(1);
});
