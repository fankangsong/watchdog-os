#!/usr/bin/env node
/* 编辑器自动草稿调度器回归（src/editorDraft.ts）：零依赖（esbuild 仅作 TS 转译，缺失时 SKIP）。
   守护「2s 防抖 / 15s 不饿死 / 单飞合并 / 保存后先写后删 / 失败暂停重试」这些只靠手点浏览器
   很难覆盖的时序行为。 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/* Windows 下 new URL(...).pathname 会带前导 /D:/，必须用 fileURLToPath 归一 */
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'srv-editor-draft-'));

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

/** 记录写 / 删调用；write 可注入延迟与失败次数 */
function makeDeps({ delay = 0, failTimes = 0, failWith = null } = {}) {
  const calls = [];
  let failures = 0;
  const errors = [];
  return {
    calls,
    errors,
    deps: {
      write: async (p) => {
        calls.push({ kind: 'write', path: p.path, content: p.content });
        if (delay) await sleep(delay);
        if (failures < failTimes) {
          failures += 1;
          throw failWith || new Error('write failed');
        }
        return { ok: true };
      },
      remove: async (p) => {
        calls.push({ kind: 'remove', path: p });
        return { ok: true };
      },
      onError: (e) => errors.push(e),
    },
  };
}

const P = (p, c) => ({ path: p, content: c, baseMtime: 1 });

let mod;
try {
  const out = path.join(TMP, 'editorDraft.mjs');
  const esbuild = await import('esbuild');
  await esbuild.build({
    entryPoints: [path.join(ROOT, 'src', 'editorDraft.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile: out,
    logLevel: 'silent',
  });
  mod = await import(pathToFileURL(out).href);
} catch (e) {
  /* esbuild 未安装时退到 Node 22+ 的原生类型擦除（本模块只有 interface / 类型标注）。
     复制成 .mts 再导入：避免 package.json 无 "type":"module" 时的模块类型告警刷屏。 */
  try {
    const tsCopy = path.join(TMP, 'editorDraft.mts');
    fs.copyFileSync(path.join(ROOT, 'src', 'editorDraft.ts'), tsCopy);
    mod = await import(pathToFileURL(tsCopy).href);
  } catch (e2) {
    console.log(`SKIP 自动草稿调度器测试（无 esbuild，且当前 Node 不支持 TS 类型擦除：${(e2 && e2.message) || e2}）`);
    process.exit(0);
  }
}
const create = () => mod.createDraftAutosave;

(async () => {
  /* 1. 防抖：连续输入只写一次，内容是最后一次 */
  {
    const { calls, deps } = makeDeps();
    const a = create()({ ...deps, debounceMs: 60, maxWaitMs: 5000 });
    for (let i = 0; i < 4; i++) {
      a.schedule(P('A', 'v' + i));
      await sleep(15);
    }
    await sleep(90);
    ok('debounce collapses bursts', calls.length === 1 && calls[0].content === 'v3', `calls=${calls.length}`);
    a.dispose();
  }

  /* 2. 持续打字不饿死：maxWait 到点强制落盘 */
  {
    const { calls, deps } = makeDeps();
    const a = create()({ ...deps, debounceMs: 5000, maxWaitMs: 70 });
    const t0 = Date.now();
    while (Date.now() - t0 < 220) {
      a.schedule(P('B', 't' + Date.now()));
      await sleep(20);
    }
    await sleep(30);
    ok('maxWait forces flush while typing', calls.length >= 2, `calls=${calls.length}`);
    a.dispose();
  }

  /* 3. 单飞 + 尾随合并：在途时的变化不排队，最多再发一次 */
  {
    const { calls, deps } = makeDeps({ delay: 60 });
    const a = create()({ ...deps, debounceMs: 10, maxWaitMs: 5000 });
    a.schedule(P('C', 'first'));
    await sleep(25); // 写已在途
    a.schedule(P('C', 'second'));
    a.schedule(P('C', 'third'));
    await sleep(180);
    ok('single-flight keeps <=2 writes', calls.length === 2, `calls=${calls.length}`);
    ok('trailing merge writes newest', calls[1].content === 'third', calls[1] && calls[1].content);
    a.dispose();
  }

  /* 4. 同内容不重复写 */
  {
    const { calls, deps } = makeDeps();
    const a = create()({ ...deps, debounceMs: 10, maxWaitMs: 5000 });
    a.schedule(P('D', 'same'));
    await sleep(40);
    a.schedule(P('D', 'same'));
    await sleep(40);
    ok('identical content skipped', calls.length === 1, `calls=${calls.length}`);
    a.dispose();
  }

  /* 5. 切文件：旧文档的 pending 先落盘，再写新文档 */
  {
    const { calls, deps } = makeDeps();
    const a = create()({ ...deps, debounceMs: 20, maxWaitMs: 5000 });
    a.schedule(P('E1', 'old'));
    a.schedule(P('E2', 'new'));
    await sleep(70);
    ok('path switch writes old first', calls.length === 2 && calls[0].path === 'E1' && calls[1].path === 'E2', JSON.stringify(calls.map((c) => c.path)));
    a.dispose();
  }

  /* 6. flush 立即落盘并排空 */
  {
    const { calls, deps } = makeDeps();
    const a = create()({ ...deps, debounceMs: 5000, maxWaitMs: 5000 });
    a.schedule(P('F', 'flush-me'));
    ok('pending true before flush', a.pending() === true);
    await a.flush();
    ok('flush writes immediately', calls.length === 1 && calls[0].content === 'flush-me', `calls=${calls.length}`);
    ok('pending false after flush', a.pending() === false);
    a.dispose();
  }

  /* 7. 失败：上报一次、暂停自动重试、下次 schedule 成功并清错误态 */
  {
    const { calls, deps, errors } = makeDeps({ failTimes: 1 });
    const a = create()({ ...deps, debounceMs: 10, maxWaitMs: 5000 });
    a.schedule(P('G', 'boom'));
    await sleep(50);
    ok('failure reported once', errors.length === 1 && errors[0] instanceof Error, `errors=${errors.length}`);
    ok('failed write kept pending', a.pending() === true);
    await sleep(60);
    ok('no auto retry storm', calls.length === 1, `calls=${calls.length}`);
    a.schedule(P('G', 'boom2'));
    await sleep(50);
    ok('next schedule retries', calls.length === 2 && calls[1].content === 'boom2', `calls=${calls.length}`);
    ok('recovery clears error', errors.length === 2 && errors[1] === null, JSON.stringify(errors.map(String)));
    a.dispose();
  }

  /* 8a. discard 在写之前：只需删除，不必再写 */
  {
    const { calls, deps } = makeDeps();
    const a = create()({ ...deps, debounceMs: 50, maxWaitMs: 5000 });
    a.schedule(P('H1', 'x'));
    a.discard('H1');
    await sleep(90);
    ok('discard before write skips write', calls.length === 1 && calls[0].kind === 'remove', JSON.stringify(calls));
    a.dispose();
  }

  /* 8b. discard 在写途中：必须等写完成后再删（否则删完又被写回来） */
  {
    const { calls, deps } = makeDeps({ delay: 50 });
    const a = create()({ ...deps, debounceMs: 10, maxWaitMs: 5000 });
    a.schedule(P('H2', 'y'));
    await sleep(25); // 在途
    a.discard('H2');
    await sleep(120);
    ok('discard waits for in-flight write', calls.length === 2 && calls[0].kind === 'write' && calls[1].kind === 'remove', JSON.stringify(calls.map((c) => c.kind)));
    a.dispose();
  }

  /* 9. 异常原样上抛给 onError（401 由 api 层统一处理，这里不吞不改） */
  {
    const boom = new Error('Unauthorized');
    const { deps, errors } = makeDeps({ failTimes: 1, failWith: boom });
    const a = create()({ ...deps, debounceMs: 10, maxWaitMs: 5000 });
    a.schedule(P('I', 'z'));
    await sleep(50);
    ok('error passed through unchanged', errors[0] === boom, String(errors[0] && errors[0].message));
    a.dispose();
  }

  /* 10. dispose 后不再发请求 */
  {
    const { calls, deps } = makeDeps();
    const a = create()({ ...deps, debounceMs: 10, maxWaitMs: 5000 });
    a.schedule(P('J', 'nope'));
    a.dispose();
    await sleep(60);
    ok('dispose stops requests', calls.length === 0, `calls=${calls.length}`);
  }

  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
