#!/usr/bin/env node
/* 编辑器草稿 API 冒烟测试（/api/drafts）：零依赖。spawn server/index.js 子进程，
   验证鉴权 / CRUD / 路径归一 / 列表不读正文 / 体积上限 / 幂等删除 / 并发原子性 /
   落盘位置与格式 / 源文件 disk 状态 / 重启清理（保留期 + 条数 + 残留 .tmp）。

   与 test-prefs-api.js 的差异：草稿目录体积可能很大且属于用户数据，因此**不碰真实数据**——
   全程用 DRAFT_DIR 指向临时目录，finally 递归删除。 */
'use strict';
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 3217;
const BASE = `http://127.0.0.1:${PORT}`;
const TMP = path.join(os.tmpdir(), 'srv-drafts-test-' + Date.now());
const DRAFT_DIR = path.join(TMP, 'drafts');
const ROOT = path.join(__dirname, '..');
const PASSWORD = process.env.PASSWORD || 'test123';
const JWT_SECRET = process.env.JWT_SECRET || 'test-only-jwt-secret-0123456789abcdef0123456789';

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

async function waitHealth() {
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return true;
    } catch { /* 未就绪继续等 */ }
    await sleep(200);
  }
  return false;
}

/** 起一个服务实例；draftsEnv 覆盖草稿相关配置（重启清理测试用） */
function startServer(draftsEnv = {}) {
  return spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      PASSWORD,
      JWT_SECRET,
      BASE_PATH: '/',
      DRAFT_DIR,
      ...draftsEnv,
    },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
}

async function stopServer(child) {
  child.kill('SIGTERM');
  for (let i = 0; i < 50; i++) {
    if (child.exitCode !== null || child.signalCode) return;
    await sleep(100);
  }
}

const put = (url, text, H) =>
  fetch(url, { method: 'PUT', headers: { ...H, 'content-type': 'text/plain; charset=utf-8' }, body: text });
const del = (url, H) => fetch(url, { method: 'DELETE', headers: H });
const q = encodeURIComponent;

/** 手写一个草稿文件（模拟历史 / 崩溃残留），返回文件路径 */
function writeRawDraft(id, meta, content) {
  fs.mkdirSync(DRAFT_DIR, { recursive: true });
  const file = path.join(DRAFT_DIR, id + '.draft');
  fs.writeFileSync(file, 'WDDRAFT/1\n' + JSON.stringify(meta) + '\n' + content, 'utf8');
  return file;
}

(async () => {
  fs.mkdirSync(TMP, { recursive: true });
  let child = startServer();
  try {
    ok('server health', await waitHealth());

    /* ---- 鉴权：401 优先于任何参数校验 ---- */
    const unauthGet = await fetch(`${BASE}/api/drafts`);
    const unauthPut = await put(`${BASE}/api/drafts?path=${q('x')}`, 'hi', {});
    const unauthDel = await del(`${BASE}/api/drafts`, {});
    ok('unauth GET 401', unauthGet.status === 401, `status=${unauthGet.status}`);
    ok('unauth PUT 401', unauthPut.status === 401, `status=${unauthPut.status}`);
    ok('unauth DELETE 401', unauthDel.status === 401, `status=${unauthDel.status}`);

    const login = await fetch(`${BASE}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: PASSWORD }),
    });
    const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
    const H = { Cookie: cookie };
    ok('login cookie', login.status === 200 && !!cookie, `status=${login.status}`);

    /* ---- 空列表 ---- */
    const empty = await (await fetch(`${BASE}/api/drafts`, { headers: H })).json();
    ok('empty list', Array.isArray(empty.drafts) && empty.drafts.length === 0, JSON.stringify(empty.limits));
    ok('dir is DRAFT_DIR', empty.dir === DRAFT_DIR, empty.dir);

    /* ---- 写入 + 列表 + 单条读取 ---- */
    const srcDir = path.join(TMP, 'src');
    fs.mkdirSync(srcDir, { recursive: true });
    const fileA = path.join(srcDir, 'a.txt');
    fs.writeFileSync(fileA, 'disk version\n', 'utf8');
    const srcMtime = Math.floor(fs.statSync(fileA).mtimeMs);

    const textA = '第一行\nsecond line\r\nemoji 🧠 结尾无换行';
    const w1 = await (await put(`${BASE}/api/drafts?path=${q(fileA)}&baseMtime=${srcMtime}`, textA, H)).json();
    const expectId = crypto.createHash('sha1').update(process.platform === 'win32' ? fileA.toLowerCase() : fileA).digest('hex');
    ok('PUT ok + id = sha1(path)', w1.ok === true && w1.id === expectId, w1.id);
    ok('PUT size = utf8 bytes', w1.size === Buffer.byteLength(textA, 'utf8'), String(w1.size));
    ok('PUT baseMtime roundtrip', w1.baseMtime === srcMtime, String(w1.baseMtime));

    const list1 = await (await fetch(`${BASE}/api/drafts`, { headers: H })).json();
    ok('list has 1 entry', list1.drafts.length === 1, String(list1.drafts.length));
    ok('list entry has no content', !('content' in list1.drafts[0]), Object.keys(list1.drafts[0]).join(','));
    ok('list entry fields', list1.drafts[0].path === fileA && list1.drafts[0].name === 'a.txt', JSON.stringify(list1.drafts[0]).slice(0, 160));
    ok('list disk exists + mtime', list1.drafts[0].disk.exists === true && list1.drafts[0].disk.mtime === srcMtime, JSON.stringify(list1.drafts[0].disk));

    const one = await (await fetch(`${BASE}/api/drafts/${expectId}`, { headers: H })).json();
    ok('GET by id returns content verbatim', one.content === textA, JSON.stringify(one.content));
    ok('GET by id has disk', !!one.disk && one.disk.exists === true);

    /* ---- 非法 id / 未知 id ---- */
    const nf = await fetch(`${BASE}/api/drafts/${'0'.repeat(40)}`, { headers: H });
    ok('unknown id 404', nf.status === 404, `status=${nf.status}`);
    const badId = await fetch(`${BASE}/api/drafts/${'A'.repeat(40)}`, { headers: H });
    ok('uppercase id 404', badId.status === 404, `status=${badId.status}`);
    const shortId = await fetch(`${BASE}/api/drafts/${'a'.repeat(39)}`, { headers: H });
    ok('short id 404', shortId.status === 404, `status=${shortId.status}`);

    /* ---- 同路径二次写入：仍 1 条，正文更新 ---- */
    const w2 = await (await put(`${BASE}/api/drafts?path=${q(fileA)}`, 'v2', H)).json();
    const list2 = await (await fetch(`${BASE}/api/drafts`, { headers: H })).json();
    ok('rewrite keeps single entry', list2.drafts.length === 1, String(list2.drafts.length));
    ok('rewrite updates updatedAt', w2.updatedAt > w1.updatedAt, `${w1.updatedAt} -> ${w2.updatedAt}`);
    const one2 = await (await fetch(`${BASE}/api/drafts/${expectId}`, { headers: H })).json();
    ok('rewrite updates content', one2.content === 'v2', JSON.stringify(one2.content));
    ok('baseMtime defaults to null', w2.baseMtime === null, String(w2.baseMtime));

    /* ---- 路径归一：多余 ./ 与（win32）大小写 ---- */
    const dotted = srcDir + path.sep + '.' + path.sep + 'a.txt';
    const wd = await (await put(`${BASE}/api/drafts?path=${q(dotted)}`, 'dotted', H)).json();
    ok('path.resolve normalization', wd.id === expectId, wd.id);
    if (process.platform === 'win32') {
      const upper = fileA.toUpperCase();
      const wu = await (await put(`${BASE}/api/drafts?path=${q(upper)}`, 'upper', H)).json();
      ok('win32 case-insensitive key', wu.id === expectId, wu.id);
    }

    /* ---- 非法 path ---- */
    const emptyPath = await put(`${BASE}/api/drafts?path=`, 'x', H);
    ok('empty path 400', emptyPath.status === 400, `status=${emptyPath.status}`);
    const longPath = await put(`${BASE}/api/drafts?path=${q('C:' + 'a'.repeat(5000))}`, 'x', H);
    ok('oversized path 400', longPath.status === 400, `status=${longPath.status}`);
    const nulPath = await put(`${BASE}/api/drafts?path=${q('\u0000')}`, 'x', H);
    ok('nul-only path 400', nulPath.status === 400, `status=${nulPath.status}`);

    /* ---- 路径含百分号：只解码一次（URLSearchParams 已解码，再 decodeURIComponent 会抛错） ---- */
    const pctFile = path.join(srcDir, '100% done.txt');
    const wpct = await (await put(`${BASE}/api/drafts?path=${q(pctFile)}`, 'pct', H)).json();
    ok('percent in path accepted', wpct.ok === true && wpct.id === crypto.createHash('sha1').update(process.platform === 'win32' ? pctFile.toLowerCase() : pctFile).digest('hex'), JSON.stringify(wpct.id));
    const pctBack = await (await fetch(`${BASE}/api/drafts/${wpct.id}`, { headers: H })).json();
    ok('percent path roundtrip', pctBack.path === pctFile && pctBack.content === 'pct', pctBack.path);

    /* ---- 体积上限 ---- */
    const big = 'x'.repeat(2 * 1024 * 1024 + 2);
    const tooBig = await put(`${BASE}/api/drafts?path=${q(fileA)}`, big, H);
    ok('oversized content 413', tooBig.status === 413, `status=${tooBig.status}`);

    /* ---- 空正文 ---- */
    const emptyFile = path.join(srcDir, 'empty.txt');
    const we = await (await put(`${BASE}/api/drafts?path=${q(emptyFile)}`, '', H)).json();
    const oneEmpty = await (await fetch(`${BASE}/api/drafts/${we.id}`, { headers: H })).json();
    ok('empty content allowed', we.ok === true && we.size === 0 && oneEmpty.content === '', `size=${we.size}`);

    /* ---- 磁盘格式：文件名只能含 40 位 hex，不能含原路径片段 ---- */
    const onDisk = fs.readdirSync(DRAFT_DIR).filter((n) => n.endsWith('.draft'));
    ok('draft files named by hash only', onDisk.every((n) => /^[0-9a-f]{40}\.draft$/.test(n)), onDisk.join(','));
    const raw = fs.readFileSync(path.join(DRAFT_DIR, expectId + '.draft'), 'utf8');
    ok('file format magic + json header', raw.startsWith('WDDRAFT/1\n'), raw.slice(0, 20).replace(/\n/g, '\\n'));

    /* ---- 坏文件容错：列表跳过，不 500 ---- */
    fs.writeFileSync(path.join(DRAFT_DIR, 'f'.repeat(40) + '.draft'), 'garbage', 'utf8');
    const listBad = await fetch(`${BASE}/api/drafts`, { headers: H });
    const listBadJson = await listBad.json();
    ok('corrupt draft skipped', listBad.status === 200 && listBadJson.drafts.every((d) => d.id !== 'f'.repeat(40)), `status=${listBad.status}`);
    fs.unlinkSync(path.join(DRAFT_DIR, 'f'.repeat(40) + '.draft'));

    /* ---- 源文件被删除：disk.exists=false ---- */
    fs.unlinkSync(fileA);
    const listGone = await (await fetch(`${BASE}/api/drafts`, { headers: H })).json();
    const gone = listGone.drafts.find((d) => d.id === expectId);
    ok('disk.exists=false after source removed', !!gone && gone.disk.exists === false, JSON.stringify(gone && gone.disk));

    /* ---- 并发写入：全部 200，最终正文是其中之一（无半截） ---- */
    const ccFile = path.join(srcDir, 'cc.txt');
    const bodies = Array.from({ length: 5 }, (_, i) => 'concurrent-' + i + '-' + 'y'.repeat(2000));
    const results = await Promise.all(bodies.map((b) => put(`${BASE}/api/drafts?path=${q(ccFile)}`, b, H)));
    ok('concurrent PUT all 200', results.every((r) => r.status === 200), results.map((r) => r.status).join(','));
    const ccList = await (await fetch(`${BASE}/api/drafts`, { headers: H })).json();
    const ccEntry = ccList.drafts.find((d) => d.path === ccFile);
    const ccFull = await (await fetch(`${BASE}/api/drafts/${ccEntry.id}`, { headers: H })).json();
    ok('concurrent final content intact', bodies.includes(ccFull.content), `len=${ccFull.content.length}`);

    /* ---- 删除：按 path 幂等 ---- */
    const d1 = await (await del(`${BASE}/api/drafts?path=${q(fileA)}`, H)).json();
    const d2 = await (await del(`${BASE}/api/drafts?path=${q(fileA)}`, H)).json();
    ok('DELETE by path idempotent', d1.deleted === true && d2.deleted === false, `${d1.deleted}/${d2.deleted}`);
    const delEmptyPath = await del(`${BASE}/api/drafts?path=`, H);
    ok('DELETE empty path 400', delEmptyPath.status === 400, `status=${delEmptyPath.status}`);

    /* ---- 删除：按 id ---- */
    const di = await (await del(`${BASE}/api/drafts/${we.id}`, H)).json();
    ok('DELETE by id', di.ok === true && di.deleted === true, JSON.stringify(di));
    const diAgain = await (await del(`${BASE}/api/drafts/${we.id}`, H)).json();
    ok('DELETE by id idempotent', diAgain.deleted === false, JSON.stringify(diAgain));

    /* ---- 方法不支持 ---- */
    const post = await fetch(`${BASE}/api/drafts`, {
      method: 'POST',
      headers: { ...H, 'content-type': 'application/json' },
      body: '{}',
    });
    ok('POST 404', post.status === 404, `status=${post.status}`);

    /* ---- 全部丢弃 ---- */
    const allDel = await (await del(`${BASE}/api/drafts`, H)).json();
    const afterAll = await (await fetch(`${BASE}/api/drafts`, { headers: H })).json();
    ok('DELETE all clears', allDel.deleted >= 1 && afterAll.drafts.length === 0, `deleted=${allDel.deleted}`);

    /* ================= 阶段 2：重启清理（保留期 / 条数 / 残留 .tmp） ================= */
    const now = Date.now();
    const old = now - 40 * 24 * 60 * 60 * 1000;
    const mk = (id, pathName, updatedAt) =>
      writeRawDraft(id, { path: pathName, name: path.basename(pathName), baseMtime: null, updatedAt, size: 3 }, 'abc');

    mk('1'.repeat(40), path.join(TMP, 'old.txt'), old); // 超过保留期
    const keep = ['2', '3', '4', '5'].map((c, i) => mk(c.repeat(40), path.join(TMP, `k${i}.txt`), now - i * 1000));
    fs.writeFileSync(path.join(DRAFT_DIR, 'deadbeef.' + process.pid + '.1.tmp'), 'partial', 'utf8');

    await stopServer(child);
    child = startServer({ DRAFT_RETENTION_DAYS: '30', DRAFT_MAX_ENTRIES: '3' });
    ok('server health after restart', await waitHealth());

    const afterGc = await (await fetch(`${BASE}/api/drafts`, { headers: H })).json();
    const ids = afterGc.drafts.map((d) => d.id);
    ok('expired draft pruned', !ids.includes('1'.repeat(40)), ids.length + ' left');
    ok('maxEntries enforced', ids.length === 3, String(ids.length));
    ok('newest kept', ids.includes('2'.repeat(40)) && ids.includes('3'.repeat(40)) && ids.includes('4'.repeat(40)), ids.join(','));
    ok('oldest over limit pruned', !ids.includes('5'.repeat(40)), ids.join(','));
    const tmpLeft = fs.readdirSync(DRAFT_DIR).filter((n) => n.endsWith('.tmp'));
    ok('stray .tmp removed', tmpLeft.length === 0, tmpLeft.join(','));
    ok('kept file still exists', fs.existsSync(keep[0]), keep[0]);
  } finally {
    await stopServer(child);
    try {
      fs.rmSync(TMP, { recursive: true, force: true });
    } catch (e) {
      console.error('清理临时目录失败:', e.message);
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('测试执行失败:', e);
  process.exit(1);
});
