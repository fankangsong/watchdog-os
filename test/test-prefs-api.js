#!/usr/bin/env node
/* 用户偏好 API 冒烟测试（/api/prefs/editor）：零依赖。spawn server/index.js 子进程，
   验证鉴权 / 默认读取 / 单字段写入 / 合并语义 / 白名单清洗 / 非法 body / 落盘位置 /
   与 favorites 键互不破坏。测试直接读写真实 ~/.watchdog-os/data.json，
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

    // 反向：editor 写不丢 favorites
    await jput(`${BASE}/api/prefs/editor`, { editor: { wordWrap: false } }, H);
    let disk2 = null;
    try {
      disk2 = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    } catch { /* 不存在时保持 null */ }
    ok('favorites survive prefs write', !!disk2 && Array.isArray(disk2.favorites) && disk2.favorites.includes(favDir), JSON.stringify(disk2 && disk2.favorites));

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