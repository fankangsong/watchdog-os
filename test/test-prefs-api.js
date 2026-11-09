#!/usr/bin/env node
/* 用户偏好 API 冒烟测试（/api/prefs/editor 与 /api/prefs/finder）：零依赖。spawn server/index.js 子进程，
   验证鉴权 / 默认读取 / 单字段写入 / 合并语义 / 白名单清洗 / 非法 body / 落盘位置 /
   各作用域键（editor / finder / favorites）互不破坏。测试直接读写真实 ~/.watchdog-os/data.json，
   故前置快照、finally 原样恢复，保证零残留。 */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 3216;
const BASE = `http://127.0.0.1:${PORT}`;
const TMP = path.join(os.tmpdir(), 'srv-prefs-test-' + Date.now());
/* 项目根：入口脚本与子进程 cwd 都必须指向它（config.js 的 diskMounts 缺省值取自 process.cwd()） */
const ROOT = path.join(__dirname, '..');
const PASSWORD = process.env.PASSWORD || 'test123';
/* JWT 签名密钥为必配项（≥32 字节），自起服务时必须注入，否则服务端 fail-fast 退出 */
const JWT_SECRET = process.env.JWT_SECRET || 'test-only-jwt-secret-0123456789abcdef0123456789';
/* 用户数据文件：偏好与收藏夹共用，测试前后快照恢复，不污染开发者真实数据 */
const DATA_FILE = path.join(os.homedir(), '.watchdog-os', 'data.json');

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

async function waitHealth() {
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return true;
    } catch { /* 未就绪继续等 */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

const jput = (url, body, H) =>
  fetch(url, { method: 'PUT', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify(body) });

(async () => {
  /* 前置快照：原始文本（原本不存在记 null），finally 中原样恢复 */
  let snapshot = null;
  try {
    snapshot = fs.readFileSync(DATA_FILE, 'utf8');
  } catch { /* 原本不存在 */ }

  const child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    // FS_ROOTS 限定到临时目录：让 favorites 的越权路径在 Windows / POSIX 上都可稳定触发
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      PASSWORD,
      JWT_SECRET,
      FS_ROOTS: TMP,
      BASE_PATH: '/',
    },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  try {
    ok('server health', await waitHealth());

    // 未登录 → 401（GET/PUT 统一 JWT 鉴权，401 优先）
    const unauthGet = await fetch(`${BASE}/api/prefs/editor`);
    const unauthPut = await jput(`${BASE}/api/prefs/editor`, { editor: {} }, {});
    ok('unauth GET 401', unauthGet.status === 401, `status=${unauthGet.status}`);
    ok('unauth PUT 401', unauthPut.status === 401, `status=${unauthPut.status}`);

    // 登录取会话 Cookie：服务端只认 HttpOnly Cookie（响应体不再回传 token）
    const login = await fetch(`${BASE}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: PASSWORD }),
    });
    const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
    const H = { Cookie: cookie };
    ok('login cookie', login.status === 200 && !!cookie, `status=${login.status}`);

    // 默认读取：200 且 editor 为对象（不断言具体值——机器上可能有历史记录）
    const d0 = await (await fetch(`${BASE}/api/prefs/editor`, { headers: H })).json();
    ok('GET default', !!d0 && typeof d0.editor === 'object' && d0.editor !== null, JSON.stringify(d0.editor));
    // GET 回传真实落盘路径：编辑器设置面板直接展示，省去"到底存哪了"的猜测
    ok('GET returns data file path', typeof d0.file === 'string' && d0.file === DATA_FILE, d0.file);

    // 单字段写入 + 读回
    const p1 = await (await jput(`${BASE}/api/prefs/editor`, { editor: { wordWrap: true } }, H)).json();
    ok('PUT wordWrap', p1.ok === true && p1.editor.wordWrap === true, JSON.stringify(p1.editor));
    const g1 = await (await fetch(`${BASE}/api/prefs/editor`, { headers: H })).json();
    ok('GET wordWrap back', g1.editor.wordWrap === true, JSON.stringify(g1.editor));

    // 合并语义：只传 showPreview，wordWrap 不被丢
    const p2 = await (await jput(`${BASE}/api/prefs/editor`, { editor: { showPreview: true } }, H)).json();
    ok('PUT merge keeps wordWrap', p2.editor.wordWrap === true && p2.editor.showPreview === true, JSON.stringify(p2.editor));

    // 白名单：非法值/未知字段被忽略，不改变已存值
    const p3 = await (await jput(`${BASE}/api/prefs/editor`, { editor: { wordWrap: 'yes', extra: 1 } }, H)).json();
    ok('whitelist filters invalid', p3.editor.wordWrap === true && p3.editor.extra === undefined, JSON.stringify(p3.editor));

    // ---- 新增的类型化字段（主题/字号/字体，编辑器偏好统一到服务端）----
    const p4 = await (
      await jput(`${BASE}/api/prefs/editor`, { editor: { theme: 'githubDark', fontSize: 18, fontFamily: 'Menlo, Monaco, monospace' } }, H)
    ).json();
    ok(
      'PUT typed fields',
      p4.editor.theme === 'githubDark' && p4.editor.fontSize === 18 && p4.editor.fontFamily === 'Menlo, Monaco, monospace',
      JSON.stringify(p4.editor)
    );
    ok('typed write keeps booleans', p4.editor.wordWrap === true && p4.editor.showPreview === true, JSON.stringify(p4.editor));
    const g4 = await (await fetch(`${BASE}/api/prefs/editor`, { headers: H })).json();
    ok('typed fields read back', g4.editor.theme === 'githubDark' && g4.editor.fontSize === 18, JSON.stringify(g4.editor));

    // 类型/范围校验：字符串型主题、越界字号、超长字体栈一律丢弃且不破坏已存值
    const p5 = await (
      await jput(`${BASE}/api/prefs/editor`, { editor: { theme: 123, fontSize: '14', fontFamily: 'x'.repeat(100) } }, H)
    ).json();
    ok(
      'typed whitelist rejects invalid',
      p5.editor.theme === 'githubDark' && p5.editor.fontSize === 18 && p5.editor.fontFamily === 'Menlo, Monaco, monospace',
      JSON.stringify(p5.editor)
    );
    const p6 = await (await jput(`${BASE}/api/prefs/editor`, { editor: { fontSize: 99 } }, H)).json();
    ok('fontSize out of range rejected', p6.editor.fontSize === 18, JSON.stringify(p6.editor));
    const p7 = await (await jput(`${BASE}/api/prefs/editor`, { editor: { fontSize: 10.5 } }, H)).json();
    ok('fontSize non-integer rejected', p7.editor.fontSize === 18, JSON.stringify(p7.editor));

    // 老客户端只推布尔时，已存的类型化字段不被清掉（部分合并语义）
    const p8 = await (await jput(`${BASE}/api/prefs/editor`, { editor: { showPreview: true } }, H)).json();
    ok(
      'boolean-only PUT keeps typed fields',
      p8.editor.theme === 'githubDark' && p8.editor.fontSize === 18 && p8.editor.wordWrap === true,
      JSON.stringify(p8.editor)
    );

    // 非法 JSON body → 400
    const bad = await fetch(`${BASE}/api/prefs/editor`, {
      method: 'PUT',
      headers: { ...H, 'content-type': 'application/json' },
      body: 'not-json',
    });
    ok('invalid body 400', bad.status === 400, `status=${bad.status}`);

    // 超过 64KB → 400
    const big = '{"editor":{"wordWrap":true},"pad":"' + 'x'.repeat(70 * 1024) + '"}';
    const bigRes = await fetch(`${BASE}/api/prefs/editor`, {
      method: 'PUT',
      headers: { ...H, 'content-type': 'application/json' },
      body: big,
    });
    ok('oversized body 400', bigRes.status === 400, `status=${bigRes.status}`);

    // 落盘位置与内容：用户目录 ~/.watchdog-os/data.json 的 editor 键
    let onDisk = null;
    try {
      onDisk = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    } catch { /* 不存在时保持 null */ }
    ok(
      'saved to ~/.watchdog-os/data.json',
      !!onDisk && !!onDisk.editor && onDisk.editor.wordWrap === true && onDisk.editor.showPreview === true,
      DATA_FILE
    );

    // 与 favorites 键互不破坏：favorites 写不丢 editor
    fs.mkdirSync(TMP, { recursive: true });
    const favDir = path.join(TMP, 'fav-target');
    fs.mkdirSync(favDir, { recursive: true });
    const favRes = await (await jput(`${BASE}/api/fs/favorites`, { favorites: [favDir] }, H)).json();
    ok('favorites PUT ok', favRes.ok === true && favRes.favorites.length === 1, (favRes.favorites || []).join(';'));
    const afterFav = await (await fetch(`${BASE}/api/prefs/editor`, { headers: H })).json();
    ok('prefs survive favorites write', afterFav.editor.wordWrap === true && afterFav.editor.showPreview === true, JSON.stringify(afterFav.editor));

    // ---- finder 作用域（Files 收藏夹侧栏显隐，落盘 data.json 的 finder 键）----
    const f0 = await (await fetch(`${BASE}/api/prefs/finder`, { headers: H })).json();
    ok('finder GET default object', !!f0 && typeof f0.finder === 'object' && f0.finder !== null, JSON.stringify(f0.finder));

    // 单字段写入 + 读回（false = 用户收起了侧栏）
    const f1 = await (await jput(`${BASE}/api/prefs/finder`, { finder: { showFavoritesSidebar: false } }, H)).json();
    ok('finder PUT showFavoritesSidebar', f1.ok === true && f1.finder.showFavoritesSidebar === false, JSON.stringify(f1.finder));
    const fg = await (await fetch(`${BASE}/api/prefs/finder`, { headers: H })).json();
    ok('finder GET back', fg.finder.showFavoritesSidebar === false, JSON.stringify(fg.finder));

    // 白名单：非布尔值 / 未知字段被忽略，已存值不被改坏
    const f2 = await (await jput(`${BASE}/api/prefs/finder`, { finder: { showFavoritesSidebar: 'yes', other: true } }, H)).json();
    ok(
      'finder whitelist filters invalid',
      f2.finder.showFavoritesSidebar === false && f2.finder.other === undefined,
      JSON.stringify(f2.finder)
    );

    // 非法 JSON body → 400（与 editor 同一出口）
    const badFinder = await fetch(`${BASE}/api/prefs/finder`, {
      method: 'PUT',
      headers: { ...H, 'content-type': 'application/json' },
      body: 'not-json',
    });
    ok('finder invalid body 400', badFinder.status === 400, `status=${badFinder.status}`);

    // 作用域互不影响：finder 写不丢 editor
    const afterFinder = await (await fetch(`${BASE}/api/prefs/editor`, { headers: H })).json();
    ok(
      'editor survives finder write',
      afterFinder.editor.wordWrap === true && afterFinder.editor.showPreview === true,
      JSON.stringify(afterFinder.editor)
    );

    // 落盘：finder 键存在，且既有的 favorites 键未被覆盖
    let diskFinder = null;
    try {
      diskFinder = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    } catch { /* 不存在时保持 null */ }
    ok(
      'finder saved to ~/.watchdog-os/data.json',
      !!diskFinder && !!diskFinder.finder && diskFinder.finder.showFavoritesSidebar === false,
      DATA_FILE
    );
    ok(
      'favorites survive finder write',
      !!diskFinder && Array.isArray(diskFinder.favorites) && diskFinder.favorites.includes(favDir),
      JSON.stringify(diskFinder && diskFinder.favorites)
    );

    // 反向：editor 写不丢 favorites
    await jput(`${BASE}/api/prefs/editor`, { editor: { wordWrap: false } }, H);
    let disk2 = null;
    try {
      disk2 = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    } catch { /* 不存在时保持 null */ }
    ok('favorites survive prefs write', !!disk2 && Array.isArray(disk2.favorites) && disk2.favorites.includes(favDir), JSON.stringify(disk2 && disk2.favorites));
    ok('finder survives editor write', !!disk2 && !!disk2.finder && disk2.finder.showFavoritesSidebar === false, JSON.stringify(disk2 && disk2.finder));

    // ---- showPreview:false 完整回环（bug 回归：关掉预览必须能被服务端存住）----
    const pf = await (await jput(`${BASE}/api/prefs/editor`, { editor: { showPreview: false } }, H)).json();
    ok('PUT showPreview false', pf.ok === true && pf.editor.showPreview === false, JSON.stringify(pf.editor));
    const gf = await (await fetch(`${BASE}/api/prefs/editor`, { headers: H })).json();
    ok('GET showPreview false back', gf.editor.showPreview === false, JSON.stringify(gf.editor));
    let diskFalse = null;
    try {
      diskFalse = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    } catch { /* 不存在时保持 null */ }
    ok(
      'showPreview false saved to disk',
      !!diskFalse && !!diskFalse.editor && diskFalse.editor.showPreview === false,
      DATA_FILE
    );

    // 部分合并：只写另一字段，已存的 false 既不丢也不被翻回 true
    const pm = await (await jput(`${BASE}/api/prefs/editor`, { editor: { wordWrap: true } }, H)).json();
    ok('partial merge keeps showPreview false', pm.editor.showPreview === false, JSON.stringify(pm.editor));
    const gm = await (await fetch(`${BASE}/api/prefs/editor`, { headers: H })).json();
    ok('showPreview false survives partial PUT', gm.editor.showPreview === false, JSON.stringify(gm.editor));

    // 未知路径 / 方法 → 404
    const nf = await fetch(`${BASE}/api/prefs/unknown`, { headers: H });
    ok('unknown path 404', nf.status === 404, `status=${nf.status}`);
    const wrongMethod = await fetch(`${BASE}/api/prefs/editor`, {
      method: 'POST',
      headers: { ...H, 'content-type': 'application/json' },
      body: '{}',
    });
    ok('wrong method 404', wrongMethod.status === 404, `status=${wrongMethod.status}`);

    // 清理收藏夹（合并写，editor 键不受影响；整体由下方快照恢复兜底）
    await jput(`${BASE}/api/fs/favorites`, { favorites: [] }, H);
    fs.rmSync(TMP, { recursive: true, force: true });
  } finally {
    // 恢复真实数据文件：原本不存在则删除，原本存在则原样写回
    try {
      if (snapshot === null) fs.rmSync(DATA_FILE, { force: true });
      else fs.writeFileSync(DATA_FILE, snapshot, 'utf8');
    } catch (e) {
      console.error('恢复 data.json 失败:', e.message);
    }
    child.kill('SIGTERM');
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('测试执行失败:', e);
  process.exit(1);
});