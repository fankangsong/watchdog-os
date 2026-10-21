#!/usr/bin/env node
/* 页面级共享轮询回归测试（src/sharedPoll.ts + src/polls.ts）：零依赖（esbuild 仅作 TS 转译，缺失时 SKIP）。
   守护 docs/tasks.md 的「轮询接口只在 APP 启动时才工作，APP 退出就不再轮询」：
     1. 零订阅者（退出应用 / 关闭窗口 / 组件卸载）后轮询继续——核心回归；
     2. 订阅即启动并立即首拉；暂停停请求、恢复立即拉一次；改间隔立即生效；
     3. 401（会话失效）停止轮询，重新订阅（重登）后自动重启；
     4. 慢接口不叠加请求；快照引用稳定；reload 语义（暂停中 no-op）；
     5. polls.ts 接线：monitor/docker/printer 各自命中正确的端点。 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'srv-shared-poll-'));

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

/* ---------- mock fetch：按 URL 记录请求，可配置状态码 / 延迟 / 响应体 ---------- */
/* 注意：共享轮询的单例「不因订阅者清零而停止」，前几个用例的轮询器会持续在跑，
   故每个用例用独立 URL，且 count(url) 只统计该 URL 的请求，避免相互污染。 */
function mockFetch(routes) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    calls.push({ url: u, method: (init.method || 'GET').toUpperCase(), t: Date.now() });
    const route = routes[u];
    if (!route) {
      return new Response(JSON.stringify({ error: 'not found' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (route.delay) await sleep(route.delay);
    const status = typeof route.status === 'function' ? route.status() : (route.status ?? 200);
    const body = typeof route.body === 'function' ? route.body() : (route.body ?? {});
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  };
  return {
    calls,
    count: (url) => calls.filter((c) => c.url === url).length,
    urls: () => [...new Set(calls.map((c) => c.url))],
  };
}

/* ---------- esbuild 打包（react 别名到订阅桩；Node 下只直接调用 store 方法） ---------- */
async function bundle(entryFile, outName) {
  const stub = path.join(TMP, 'stub-react.mjs');
  fs.writeFileSync(
    stub,
    `export function useSyncExternalStore(subscribe, getSnapshot) {
  const state = { current: getSnapshot() };
  const unsubscribe = subscribe(() => { state.current = getSnapshot(); });
  return { get snapshot() { return state.current; }, unsubscribe };
}
`
  );
  const out = path.join(TMP, outName);
  const esbuild = await import('esbuild');
  await esbuild.build({
    entryPoints: [entryFile],
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile: out,
    alias: { react: stub },
    logLevel: 'silent',
  });
  return out;
}

let sharedBundle;
let pollsBundle;
try {
  /* sharedPoll 与 api 打同一 bundle：保证 instanceof Unauthorized 是同一个类 */
  const entryShared = path.join(TMP, 'entry-shared.mjs');
  fs.writeFileSync(
    entryShared,
    `export { createSharedPoll, useSharedPoll } from ${JSON.stringify(path.join(ROOT, 'src', 'sharedPoll.ts'))};
export { Unauthorized } from ${JSON.stringify(path.join(ROOT, 'src', 'api.ts'))};
`
  );
  sharedBundle = await bundle(entryShared, 'sharedPoll.mjs');
  pollsBundle = await bundle(path.join(ROOT, 'src', 'polls.ts'), 'polls.mjs');
} catch (e) {
  console.log(`SKIP 共享轮询测试（esbuild 不可用：${(e && e.message) || e}）`);
  process.exit(0);
}
/* query 击碎模块缓存：每个用例拿到全新模块实例（含全新单例） */
let caseNo = 0;
const freshShared = () => import(`${pathToFileURL(sharedBundle).href}?case=${++caseNo}`);
const freshPolls = () => import(`${pathToFileURL(pollsBundle).href}?case=${++caseNo}`);

const IV = 250; // 测试用轮询间隔（createSharedPoll 下限 200ms）

(async () => {
  /* 1. 核心回归：最后一个订阅者退出后，轮询不得停止 */
  {
    const U = './api/x1';
    const net = mockFetch({ [U]: { body: { v: 1 } } });
    const { createSharedPoll } = await freshShared();
    const poll = createSharedPoll(async () => (await fetch(U)).json(), { intervalMs: IV });
    const un = poll.subscribe(() => {});
    await sleep(120);
    un(); // 组件卸载 / 应用退出：订阅者清零
    const before = net.count(U);
    await sleep(IV * 2 + 150);
    const after = net.count(U);
    ok('零订阅者后轮询继续', after > before + 1, `请求数 ${before} → ${after}`);
  }

  /* 2. 订阅即启动并立即首拉（不必等一个间隔） */
  {
    const U = './api/x2';
    const net = mockFetch({ [U]: { body: { v: 1 } } });
    const { createSharedPoll } = await freshShared();
    const poll = createSharedPoll(async () => (await fetch(U)).json(), { intervalMs: IV });
    const un = poll.subscribe(() => {});
    await sleep(600);
    un();
    ok('订阅即立即首拉', net.count(U) >= 1, `首拉后请求数 ${net.count(U)}`);
  }

  /* 3. 暂停停请求；恢复立即拉一次并继续轮询 */
  {
    const U = './api/x3';
    const net = mockFetch({ [U]: { body: { v: 1 } } });
    const { createSharedPoll } = await freshShared();
    const poll = createSharedPoll(async () => (await fetch(U)).json(), { intervalMs: IV });
    const un = poll.subscribe(() => {});
    await sleep(120);
    poll.setPaused(true);
    const atPause = net.count(U);
    await sleep(IV * 2 + 120);
    ok('暂停后停请求', net.count(U) === atPause, `${atPause} → ${net.count(U)}`);
    poll.setPaused(false);
    await sleep(30);
    const afterResume = net.count(U);
    ok('恢复后立即拉一次', afterResume === atPause + 1, `${atPause} → ${afterResume}`);
    await sleep(IV + 120);
    ok('恢复后继续轮询', net.count(U) > afterResume, `${afterResume} → ${net.count(U)}`);
    un();
  }

  /* 4. 改间隔立即生效（按新间隔续轮，旧间隔不再触发） */
  {
    const U = './api/x4';
    const net = mockFetch({ [U]: { body: { v: 1 } } });
    const { createSharedPoll } = await freshShared();
    const poll = createSharedPoll(async () => (await fetch(U)).json(), { intervalMs: IV });
    const un = poll.subscribe(() => {});
    await sleep(120);
    poll.setIntervalMs(2000); // 拉长为 2s
    await sleep(80);
    const afterChange = net.count(U);
    await sleep(1200);
    ok('改间隔立即生效', net.count(U) === afterChange, `${afterChange} → ${net.count(U)}`);
    un();
  }

  /* 5. 401 停止轮询；重新订阅（重登）自动重启 */
  {
    const U = './api/x5';
    let fail = true;
    const net = mockFetch({ [U]: { status: () => (fail ? 401 : 200), body: { v: 1 } } });
    const { createSharedPoll, Unauthorized } = await freshShared();
    const poll = createSharedPoll(async () => {
      const r = await fetch(U);
      if (r.status === 401) throw new Unauthorized();
      return r.json();
    }, { intervalMs: IV });
    const un = poll.subscribe(() => {});
    await sleep(IV * 2 + 150);
    const at401 = net.count(U);
    await sleep(IV * 2 + 150);
    ok('401 后停止轮询', net.count(U) === at401, `${at401} → ${net.count(U)}`);
    ok('401 记入 error', poll.getSnapshot().error instanceof Unauthorized);
    fail = false; // 模拟重新登录后会话恢复
    const un2 = poll.subscribe(() => {});
    await sleep(80);
    ok('重新订阅后重启轮询', net.count(U) > at401, `${at401} → ${net.count(U)}`);
    un();
    un2();
  }

  /* 6. 慢接口不叠加请求（上一次未返回则跳过本轮） */
  {
    const U = './api/x6';
    const net = mockFetch({ [U]: { delay: 400, body: { v: 1 } } });
    const { createSharedPoll } = await freshShared();
    const poll = createSharedPoll(async () => (await fetch(U)).json(), { intervalMs: IV });
    const un = poll.subscribe(() => {});
    await sleep(1000);
    un();
    ok('慢接口不叠加请求', net.count(U) <= 3, `1s 内请求数 ${net.count(U)}`);
  }

  /* 7. 快照引用稳定（useSyncExternalStore 契约）：无变更时同一对象，变更后换新对象 */
  {
    const U = './api/x7';
    mockFetch({ [U]: { body: { v: 1 } } });
    const { createSharedPoll } = await freshShared();
    const poll = createSharedPoll(async () => (await fetch(U)).json(), { intervalMs: IV });
    const un = poll.subscribe(() => {});
    const s1 = poll.getSnapshot();
    const s2 = poll.getSnapshot();
    ok('快照无变更时引用稳定', s1 === s2);
    await sleep(80);
    const s3 = poll.getSnapshot();
    ok('数据到位后快照更新', s3 !== s1 && !!s3.data && s3.data.v === 1, JSON.stringify(s3.data));
    un();
  }

  /* 8. reload：运行中立即拉一次；暂停中 no-op */
  {
    const U = './api/x8';
    const net = mockFetch({ [U]: { body: { v: 1 } } });
    const { createSharedPoll } = await freshShared();
    const poll = createSharedPoll(async () => (await fetch(U)).json(), { intervalMs: 2000 });
    const un = poll.subscribe(() => {});
    await sleep(80);
    const before = net.count(U);
    poll.reload();
    await sleep(60);
    ok('reload 运行中立即拉一次', net.count(U) === before + 1, `${before} → ${net.count(U)}`);
    poll.setPaused(true);
    const atPause = net.count(U);
    poll.reload();
    await sleep(60);
    ok('reload 暂停中 no-op', net.count(U) === atPause);
    un();
  }

  /* 9. polls.ts 接线：三个单例各自命中正确端点（订阅即首拉） */
  {
    const net = mockFetch({
      './api/metrics': { body: { host: { hostname: 'h' } } },
      './api/processes': { body: { available: true, list: [] } },
      './api/docker': { body: { available: true, containers: [] } },
      './api/printer': { body: { available: true, printers: [] } },
    });
    const polls = await freshPolls();
    const unM = polls.monitorPoll.subscribe(() => {});
    const unD = polls.dockerPoll.subscribe(() => {});
    const unP = polls.printerPoll.subscribe(() => {});
    await sleep(150);
    const urls = net.urls().filter((u) => !/\/x\d+$/.test(u)); // 排除前几个用例的遗留轮询
    ok(
      'polls.ts 端点接线',
      urls.includes('./api/metrics') &&
        urls.includes('./api/processes') &&
        urls.includes('./api/docker') &&
        urls.includes('./api/printer'),
      urls.join(', ')
    );
    const snap = polls.monitorPoll.getSnapshot();
    ok(
      'monitorPoll 合并数据形状',
      !!snap.data && !!snap.data.metrics && !!snap.data.processes,
      JSON.stringify(Object.keys(snap.data ?? {}))
    );
    unM();
    unD();
    unP();
  }

  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch { /* 临时目录清理失败忽略 */ }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('测试执行异常:', e);
  process.exit(1);
});
