#!/usr/bin/env node
/* 文件管理 API 冒烟测试：零依赖。spawn server/index.js 子进程，逐项验证 /api/fs/* 全链路后自清理。 */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 3213;
const BASE = `http://127.0.0.1:${PORT}`;
const TMP = path.join(os.tmpdir(), 'srv-fs-test-' + Date.now());
/* 项目根：入口脚本与子进程 cwd 都必须指向它（config.js 的 diskMounts 缺省值取自 process.cwd()） */
const ROOT = path.join(__dirname, '..');
const PASSWORD = process.env.PASSWORD || 'test123';
/* JWT 签名密钥为必配项（≥32 字节），自起服务时必须注入，否则服务端 fail-fast 退出 */
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

(async () => {
  const child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    // FS_ROOTS 限定到临时目录：让「越权路径 403」在 Windows / POSIX 上都可稳定触发
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

    // 未登录 → 401
    const unauth = await fetch(`${BASE}/api/fs/list`);
    ok('unauth 401', unauth.status === 401, `status=${unauth.status}`);

    // 登录取会话 Cookie：服务端只认 HttpOnly Cookie（响应体不再回传 token）
    const login = await fetch(`${BASE}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: PASSWORD }),
    });
    const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
    const H = { Cookie: cookie };
    ok('login cookie', login.status === 200 && !!cookie, `status=${login.status}`);

    // 根列表
    const roots = await (await fetch(`${BASE}/api/fs/list`, { headers: H })).json();
    ok('roots list', Array.isArray(roots.roots) && roots.roots.length > 0, (roots.roots || []).join(', '));

    // mkdir
    fs.mkdirSync(TMP, { recursive: true });
    const mk = await (
      await fetch(`${BASE}/api/fs/mkdir`, {
        method: 'POST',
        headers: { ...H, 'content-type': 'application/json' },
        body: JSON.stringify({ path: path.join(TMP, 'sub') }),
      })
    ).json();
    ok('mkdir', mk.ok === true);

    // write：读回内容必须与请求体一致（ReFS/Dev Drive 上 stat.size 可能是预分配值，不作断言）
    const text = 'hello 你好\nline2';
    const expectBytes = Buffer.byteLength(text, 'utf8');
    const file = path.join(TMP, 'a.txt');
    const w = await (
      await fetch(`${BASE}/api/fs/write?path=${encodeURIComponent(file)}`, {
        method: 'PUT',
        headers: { ...H, 'content-type': 'text/plain; charset=utf-8' },
        body: text,
      })
    ).json();
    const readback = fs.readFileSync(file, 'utf8');
    ok(
      'write bytes exact',
      w.ok === true && readback === text,
      `resp.size=${w.size} (stat 可能含 ReFS 预分配) diskReadback=${Buffer.byteLength(readback, 'utf8')} expect=${expectBytes}`
    );

    // read
    const rd = await (await fetch(`${BASE}/api/fs/read?path=${encodeURIComponent(file)}`, { headers: H })).json();
    ok('read content', rd.content === text);

    // write?create=1：新建语义 —— 不存在时创建空文件；目标已存在时 409 且不覆盖原内容
    const nf = path.join(TMP, '新建文本.txt');
    const cr1 = await fetch(`${BASE}/api/fs/write?path=${encodeURIComponent(nf)}&create=1`, {
      method: 'PUT',
      headers: { ...H, 'content-type': 'text/plain; charset=utf-8' },
      body: '',
    });
    ok('write create new', cr1.status === 200 && fs.existsSync(nf), `status=${cr1.status}`);
    const cr2 = await fetch(`${BASE}/api/fs/write?path=${encodeURIComponent(file)}&create=1`, {
      method: 'PUT',
      headers: { ...H, 'content-type': 'text/plain; charset=utf-8' },
      body: '',
    });
    ok(
      'write create conflict 409',
      cr2.status === 409 && fs.readFileSync(file, 'utf8') === text,
      `status=${cr2.status}`
    );

    // list & previewable & mode
    const lst = await (await fetch(`${BASE}/api/fs/list?path=${encodeURIComponent(TMP)}`, { headers: H })).json();
    const entry = (lst.entries || []).find((e) => e.name === 'a.txt');
    ok(
      'list entry attrs',
      entry && entry.previewable === 'text' && typeof entry.mode === 'string' && entry.mode.length === 9,
      entry && `mode=${entry.mode} size=${entry.size} mtime=${entry.mtime}`
    );

    // raw：字节级一致（附件下载）
    const raw = await fetch(`${BASE}/api/fs/raw?path=${encodeURIComponent(file)}`, { headers: H });
    const rawBuf = Buffer.from(await raw.arrayBuffer());
    ok(
      'raw bytes exact',
      rawBuf.equals(Buffer.from(text, 'utf8')),
      `status=${raw.status} cd=${raw.headers.get('content-disposition')} len=${rawBuf.length}`
    );

    // upload 二进制 + read 二进制嗅探
    const bin = Buffer.from([1, 2, 0, 3, 255]);
    const up = await (
      await fetch(`${BASE}/api/fs/upload?path=${encodeURIComponent(TMP)}&name=up.bin`, {
        method: 'POST',
        headers: { ...H, 'content-type': 'application/octet-stream' },
        body: bin,
      })
    ).json();
    const rdb = await (
      await fetch(`${BASE}/api/fs/read?path=${encodeURIComponent(path.join(TMP, 'up.bin'))}`, { headers: H })
    ).json();
    ok('upload + binary sniff', up.ok === true && up.size === 5 && rdb.binary === true, `up=${up.size}`);

    // 同名冲突 409 / overwrite=1 覆盖
    const dup = await fetch(`${BASE}/api/fs/upload?path=${encodeURIComponent(TMP)}&name=up.bin`, {
      method: 'POST',
      headers: { ...H, 'content-type': 'application/octet-stream' },
      body: bin,
    });
    ok('upload conflict 409', dup.status === 409, `status=${dup.status}`);
    const dup2 = await fetch(`${BASE}/api/fs/upload?path=${encodeURIComponent(TMP)}&name=up.bin&overwrite=1`, {
      method: 'POST',
      headers: { ...H, 'content-type': 'application/octet-stream' },
      body: bin,
    });
    ok('upload overwrite ok', dup2.status === 200, `status=${dup2.status}`);

    // 收藏持久化
    const f1 = await (
      await fetch(`${BASE}/api/fs/favorites`, {
        method: 'PUT',
        headers: { ...H, 'content-type': 'application/json' },
        body: JSON.stringify({ favorites: [TMP] }),
      })
    ).json();
    const f2 = await (await fetch(`${BASE}/api/fs/favorites`, { headers: H })).json();
    ok('favorites persist', f1.ok === true && Array.isArray(f2.favorites) && f2.favorites.length === 1, (f2.favorites || []).join(';'));

    // rename
    const rn = await (
      await fetch(`${BASE}/api/fs/rename`, {
        method: 'POST',
        headers: { ...H, 'content-type': 'application/json' },
        body: JSON.stringify({ path: file, name: 'b.txt' }),
      })
    ).json();
    ok('rename', rn.ok === true && fs.existsSync(path.join(TMP, 'b.txt')));

    // rename 可修改扩展名（b.txt → b.md）
    const rn2 = await (
      await fetch(`${BASE}/api/fs/rename`, {
        method: 'POST',
        headers: { ...H, 'content-type': 'application/json' },
        body: JSON.stringify({ path: path.join(TMP, 'b.txt'), name: 'b.md' }),
      })
    ).json();
    ok('rename with extension change', rn2.ok === true && fs.existsSync(path.join(TMP, 'b.md')));

    // 越权路径防护（允许根外路径：Windows 用其他盘符，POSIX 用根目录本身）
    const outside = process.platform === 'win32' ? 'E:\\' : '/';
    const bad = await fetch(`${BASE}/api/fs/list?path=${encodeURIComponent(outside)}`, { headers: H });
    ok('traversal guard 403', bad.status === 403, `status=${bad.status}`);
    const badRoot = await fetch(`${BASE}/api/fs/delete`, {
      method: 'POST',
      headers: { ...H, 'content-type': 'application/json' },
      body: JSON.stringify({ path: roots.roots[0] }),
    });
    ok('delete root forbidden 403', badRoot.status === 403, `status=${badRoot.status}`);

    // 清理（允许根本身禁止删除，故删除根内此前创建的 sub 目录；TMP 最后本地清理）
    const delTarget = path.join(TMP, 'sub');
    const del = await (
      await fetch(`${BASE}/api/fs/delete`, {
        method: 'POST',
        headers: { ...H, 'content-type': 'application/json' },
        body: JSON.stringify({ path: delTarget }),
      })
    ).json();
    ok('delete dir', del.ok === true && !fs.existsSync(delTarget));
    await fetch(`${BASE}/api/fs/favorites`, {
      method: 'PUT',
      headers: { ...H, 'content-type': 'application/json' },
      body: JSON.stringify({ favorites: [] }),
    });
    fs.rmSync(TMP, { recursive: true, force: true });
  } finally {
    child.kill('SIGTERM');
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('测试执行失败:', e);
  process.exit(1);
});
