#!/usr/bin/env node
/* Files 偏好 store 回归测试（src/finderPrefs.ts）：零依赖（esbuild 仅作 TS 转译，缺失时 SKIP）。
   守护「首次打开 Files 即展开收藏夹侧栏 + 显隐记住并落盘 ~/.watchdog-os」的语义：
     1. 服务端无记录 → 默认展开（true），且不产生任何 PUT（不给从未切换过的用户写盘）；
     2. 服务端有 false → 加载后按服务端值收起；
     3. 切换 → PUT 一次并落地；重复设同值不产生多余 PUT；
     4. 加载（GET）在途时用户已切换 → 本地胜出，加载完成后把本地值补推上去；
     5. GET 失败 → 保持默认展开，不发 PUT、不崩；
     6. PUT 失败 → UI 不回滚（偏好丢失优于界面错乱），下次切换重试成功。 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const STORE_SRC = path.join(ROOT, 'src', 'finderPrefs.ts');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'srv-finder-prefs-'));

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

/* ---------- mock 服务端：语义对齐 server/api/prefs.js 的 GET/PUT /api/prefs/finder ---------- */
function mockServer({ initial = null, getDelay = 0, putDelays = [], failGet = false, failPuts = 0 } = {}) {
  const state = initial ? { ...initial } : {}; // 服务端 finder 键（可能为空对象 = 从未设置）
  const puts = [];
  let putIdx = 0;
  let fails = failPuts;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const method = (init.method || 'GET').toUpperCase();
    const json = (body, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (!u.includes('/api/prefs/finder')) return json({ error: 'not found' }, 404);
    if (method === 'PUT') {
      const body = JSON.parse(init.body || '{}');
      const incoming = (body && body.finder) || {};
      const delay = putDelays[putIdx] ?? 0;
      putIdx += 1;
      await sleep(delay);
      if (fails > 0) {
        fails -= 1;
        return json({ error: 'boom' }, 500);
      }
      // 部分合并语义：只落布尔字段，未传字段保留
      for (const [k, v] of Object.entries(incoming)) if (typeof v === 'boolean') state[k] = v;
      puts.push({ ...incoming });
      return json({ ok: true, finder: { ...state } });
    }
    if (failGet) return json({ error: 'boom' }, 500);
    const snap = { ...state }; // 请求到达时快照，延迟响应（模拟慢加载）
    await sleep(getDelay);
    return json({ finder: snap });
  };
  return { state: () => ({ ...state }), puts };
}

/* esbuild 只作 TS 转译。pnpm 布局下它没有顶层软链（node_modules/.pnpm/esbuild@x/...），
   直接 import('esbuild') 会失败；这里补一层嵌套路径兜底，避免测试在本机永远 SKIP。 */
async function loadEsbuild() {
  try {
    return await import('esbuild');
  } catch {
    const pnpmDir = path.join(ROOT, 'node_modules', '.pnpm');
    if (fs.existsSync(pnpmDir)) {
      for (const name of fs.readdirSync(pnpmDir)) {
        if (!name.startsWith('esbuild@')) continue;
        const entry = path.join(pnpmDir, name, 'node_modules', 'esbuild', 'lib', 'main.js');
        if (fs.existsSync(entry)) return import(pathToFileURL(entry).href);
      }
    }
    throw new Error('esbuild not found (npm/pnpm 布局均未命中)');
  }
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
  const out = path.join(TMP, 'finderPrefs.mjs');
  const esbuild = await loadEsbuild();
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
  console.log(`SKIP Files 偏好 store 测试（esbuild 不可用：${(e && e.message) || e}）`);
  process.exit(0);
}
/* 每个场景全新模块实例（模块级状态重置），query 作缓存击碎键 */
let caseNo = 0;
async function freshStore() {
  return import(`${pathToFileURL(bundle).href}?case=${++caseNo}`);
}

(async () => {
  /* 场景 1：服务端从未设置 → 默认展开，且不写盘 */
  {
    const srv = mockServer();
    const store = await freshStore();
    const sub = store.useFinderPrefs();
    await sleep(30);
    ok('场景1 默认展开', sub.snapshot.showFavoritesSidebar === true, JSON.stringify(sub.snapshot));
    ok('场景1 未设置不写盘', srv.puts.length === 0, `puts=${srv.puts.length}`);
    sub.unsubscribe();
  }

  /* 场景 2：服务端记录 false → 加载后按上次选择收起 */
  {
    const srv = mockServer({ initial: { showFavoritesSidebar: false } });
    const store = await freshStore();
    const sub = store.useFinderPrefs();
    await sleep(30);
    ok('场景2 服务端 false 生效', sub.snapshot.showFavoritesSidebar === false, JSON.stringify(sub.snapshot));
    ok('场景2 加载不写盘', srv.puts.length === 0, `puts=${srv.puts.length}`);
    sub.unsubscribe();
  }

  /* 场景 3：切换落盘 + 同值去重 */
  {
    const srv = mockServer({ initial: { showFavoritesSidebar: true } });
    const store = await freshStore();
    const sub = store.useFinderPrefs();
    await sleep(30);
    store.setShowFavoritesSidebar(false);
    ok('场景3 乐观更新即时生效', sub.snapshot.showFavoritesSidebar === false, JSON.stringify(sub.snapshot));
    await sleep(30);
    ok('场景3 切换后落盘', srv.state().showFavoritesSidebar === false, JSON.stringify(srv.state()));
    ok('场景3 一次切换一次 PUT', srv.puts.length === 1, `puts=${srv.puts.length}`);
    store.setShowFavoritesSidebar(false); // 同值：不应再发 PUT
    await sleep(30);
    ok('场景3 同值去重', srv.puts.length === 1, `puts=${srv.puts.length}`);
    store.setShowFavoritesSidebar(true);
    await sleep(30);
    ok('场景3 反向切换落盘', srv.state().showFavoritesSidebar === true && srv.puts.length === 2, JSON.stringify(srv.state()));
    sub.unsubscribe();
  }

  /* 场景 4：加载在途时用户已切换 → 本地胜出并补推 */
  {
    const srv = mockServer({ initial: { showFavoritesSidebar: true }, getDelay: 80 });
    const store = await freshStore();
    const sub = store.useFinderPrefs(); // GET 在途
    store.setShowFavoritesSidebar(false); // 用户先动手
    await sleep(180); // 等延迟 GET + 补推完成
    ok('场景4 本地胜出', sub.snapshot.showFavoritesSidebar === false, JSON.stringify(sub.snapshot));
    ok('场景4 本地值已补推', srv.state().showFavoritesSidebar === false, JSON.stringify(srv.state()));
    ok('场景4 仅一次 PUT', srv.puts.length === 1, `puts=${srv.puts.length}`);
    sub.unsubscribe();
  }

  /* 场景 5：GET 失败 → 保持默认展开、不写盘、不抛错 */
  {
    const srv = mockServer({ failGet: true });
    const store = await freshStore();
    const sub = store.useFinderPrefs();
    await sleep(30);
    ok('场景5 加载失败保持默认', sub.snapshot.showFavoritesSidebar === true, JSON.stringify(sub.snapshot));
    ok('场景5 加载失败不写盘', srv.puts.length === 0, `puts=${srv.puts.length}`);
    sub.unsubscribe();
  }

  /* 场景 6：PUT 失败不回滚 UI，下次切换重试成功 */
  {
    const srv = mockServer({ initial: { showFavoritesSidebar: true }, failPuts: 1 });
    const store = await freshStore();
    const sub = store.useFinderPrefs();
    await sleep(30);
    store.setShowFavoritesSidebar(false); // 首次 PUT 失败
    await sleep(40);
    ok('场景6 失败不回滚 UI', sub.snapshot.showFavoritesSidebar === false, JSON.stringify(sub.snapshot));
    ok('场景6 服务端仍是旧值', srv.state().showFavoritesSidebar === true, JSON.stringify(srv.state()));
    store.setShowFavoritesSidebar(true); // 回到服务端值：无需 PUT
    await sleep(30);
    store.setShowFavoritesSidebar(false); // 再次差异：重试成功
    await sleep(40);
    ok('场景6 重试成功', srv.state().showFavoritesSidebar === false && srv.puts.length === 1, JSON.stringify(srv.state()));
    sub.unsubscribe();
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
