#!/usr/bin/env node
/* 收藏夹 store 竞态回归测试（src/favoritesStore.ts）：零依赖（esbuild 仅作 TS 转译，缺失时 SKIP）。
   复现并守护 docs/tasks.md 的「添加到收藏夹会覆盖上一次添加的目录」：
   根因是变更操作不与「首次加载」互等、提交不串行、加载期间的过期 GET 响应后会落地覆盖新状态，
   导致 PUT 全量列表时丢条目（服务端 favorites 为全量替换语义，丢条目即覆盖）。
   场景：
     1. 初始 GET 响应晚于首次提交（用户报告的复现路径）；
     2. 未等加载完成即添加（无订阅时直接调用）；
     3. 并发添加 + 服务端乱序处理 PUT；
     4. 加载失败时变更必须报错，不得破坏性盲写；
     5. 正常增 / 删 / 去重 / 切换回归。 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
const STORE_SRC = path.join(ROOT, 'src', 'favoritesStore.ts');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'srv-fav-store-'));

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
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/* ---------- mock 服务端：语义对齐 server/api/fs.js 的 GET/PUT /api/fs/favorites ---------- */
function mockServer({ initial = [], getDelay = 0, putDelays = [], failGet = false }) {
  let list = [...initial];
  const puts = [];
  let putIdx = 0;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const method = (init.method || 'GET').toUpperCase();
    const json = (body, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (!u.includes('/api/fs/favorites')) return json({ error: 'not found' }, 404);
    if (method === 'PUT') {
      const body = JSON.parse(init.body || '{}');
      const incoming = Array.isArray(body.favorites) ? body.favorites : [];
      const delay = putDelays[putIdx] ?? 0;
      putIdx += 1;
      await sleep(delay); // 并发 PUT 在服务端可乱序落地（全量替换，后写覆盖先写）
      list = incoming;
      puts.push([...list]);
      return json({ ok: true, favorites: [...list] });
    }
    if (failGet) return json({ error: 'boom' }, 500);
    const snap = [...list]; // 请求到达时快照，延迟响应（模拟慢加载）
    await sleep(getDelay);
    return json({ favorites: snap });
  };
  return { getList: () => [...list], puts };
}

/* ---------- 经 esbuild 把 TS store 打包成 Node ESM（react 别名到订阅桩） ---------- */
async function bundleStore() {
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
  const out = path.join(TMP, 'favoritesStore.mjs');
  const esbuild = await import('esbuild');
  await esbuild.build({
    entryPoints: [STORE_SRC],
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile: out,
    alias: { react: stub },
    logLevel: 'silent',
  });
  return out;
}

let bundle;
try {
  bundle = await bundleStore();
} catch (e) {
  console.log(`SKIP 收藏夹 store 竞态测试（esbuild 不可用：${(e && e.message) || e}）`);
  process.exit(0);
}
/* 每个场景全新模块实例（模块级状态重置），query 作缓存击碎键 */
let caseNo = 0;
async function freshStore() {
  return import(`${pathToFileURL(bundle).href}?case=${++caseNo}`);
}

(async () => {
  /* 场景 1：初始 GET 响应晚于首次提交——用户报告的「添加覆盖上一次」复现路径 */
  {
    const srv = mockServer({ initial: ['/data/old'], getDelay: 80 });
    const store = await freshStore();
    const sub = store.useFavorites(); // 挂载即触发 GET（在途，快照 ['/data/old']）
    await store.addFavorites(['/data/a']); // 修复后：等 GET 落地再合并；修复前：盲写 ['/data/a']
    await sleep(150); // 让延迟的 GET 响应有机会（错误地）后落地
    await store.addFavorites(['/data/b']);
    sub.unsubscribe();
    ok('场景1 加载响应晚于提交', eq(srv.getList(), ['/data/old', '/data/a', '/data/b']), JSON.stringify(srv.getList()));
  }

  /* 场景 2：未订阅（未加载）即添加——盲写丢旧条目 */
  {
    const srv = mockServer({ initial: ['/data/old'] });
    const store = await freshStore();
    await store.addFavorites(['/data/a']);
    ok('场景2 变更前先加载', eq(srv.getList(), ['/data/old', '/data/a']), JSON.stringify(srv.getList()));
  }

  /* 场景 3：并发添加 + 服务端乱序处理 PUT——提交必须串行且基于最新状态 */
  {
    const srv = mockServer({ initial: ['/data/old'], putDelays: [40, 5, 0] });
    const store = await freshStore();
    const sub = store.useFavorites();
    await sleep(30); // 等首次加载完成
    await Promise.all([
      store.addFavorites(['/data/a']),
      store.addFavorites(['/data/b']),
      store.addFavorites(['/data/c']),
    ]);
    sub.unsubscribe();
    ok('场景3 并发添加互不丢失', eq(srv.getList(), ['/data/old', '/data/a', '/data/b', '/data/c']), JSON.stringify(srv.getList()));
  }

  /* 场景 4：加载失败时变更报错，且不破坏服务端已有列表 */
  {
    const srv = mockServer({ initial: ['/data/old'], failGet: true });
    const store = await freshStore();
    const sub = store.useFavorites();
    await sleep(20);
    let threw = false;
    try {
      await store.addFavorites(['/data/a']);
    } catch {
      threw = true;
    }
    sub.unsubscribe();
    ok('场景4 加载失败变更报错', threw);
    ok('场景4 服务端列表未被破坏', eq(srv.getList(), ['/data/old']), JSON.stringify(srv.getList()));
  }

  /* 场景 5：正常流程回归（加载后增 / 增重 / 删 / 切换 / 快照同步） */
  {
    const srv = mockServer({ initial: ['/data/old'] });
    const store = await freshStore();
    const sub = store.useFavorites();
    await sleep(30);
    await store.addFavorites(['/data/a']);
    await store.addFavorites(['/data/b']);
    await store.addFavorites(['/data/b']); // 重复添加去重
    await store.removeFavorites(['/data/old']);
    await store.toggleFavorite('/data/c'); // 加入
    await store.toggleFavorite('/data/c'); // 再切为移除
    sub.unsubscribe();
    ok('场景5 正常增删切换', eq(srv.getList(), ['/data/a', '/data/b']), JSON.stringify(srv.getList()));
    ok('场景5 快照同步', eq(sub.snapshot, ['/data/a', '/data/b']), JSON.stringify(sub.snapshot));
    ok('场景5 isFavorite', store.isFavorite('/data/b') && !store.isFavorite('/data/c'));
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
