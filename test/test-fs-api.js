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

    // 收藏落盘位置：用户目录 ~/.watchdog-os/data.json（与项目目录解耦，同步/重部署不丢收藏）
    const favFile = path.join(os.homedir(), '.watchdog-os', 'data.json');
    let favOnDisk = null;
    try {
      favOnDisk = JSON.parse(fs.readFileSync(favFile, 'utf8'));
    } catch {
      /* 文件不存在时保持 null */
    }
    ok(
      'favorites saved to ~/.watchdog-os/data.json',
      !!favOnDisk && Array.isArray(favOnDisk.favorites) && favOnDisk.favorites.includes(TMP),
      favFile
    );

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

    // copy：同目录复制不覆盖，自动追加 " copy" 后缀且内容一致
    // 越权路径（允许根外）：Windows 用其他盘符，POSIX 用根目录本身
    const outside = process.platform === 'win32' ? 'E:\\' : '/';
    const cp1 = await (
      await fetch(`${BASE}/api/fs/copy`, {
        method: 'POST',
        headers: { ...H, 'content-type': 'application/json' },
        body: JSON.stringify({ path: path.join(TMP, 'b.md'), dir: TMP }),
      })
    ).json();
    ok(
      'copy same dir auto suffix',
      cp1.ok === true &&
        cp1.name === 'b copy.md' &&
        fs.readFileSync(path.join(TMP, 'b copy.md'), 'utf8') === fs.readFileSync(path.join(TMP, 'b.md'), 'utf8'),
      `name=${cp1.name}`
    );

    // copy：再次复制生成 " copy 2"（后缀递增，仍不覆盖）
    const cp1b = await (
      await fetch(`${BASE}/api/fs/copy`, {
        method: 'POST',
        headers: { ...H, 'content-type': 'application/json' },
        body: JSON.stringify({ path: path.join(TMP, 'b.md'), dir: TMP }),
      })
    ).json();
    ok('copy second auto suffix', cp1b.name === 'b copy 2.md', `name=${cp1b.name}`);

    // copy：跨目录复制（目标目录需存在）
    fs.mkdirSync(path.join(TMP, 'dst'), { recursive: true });
    const cp2 = await (
      await fetch(`${BASE}/api/fs/copy`, {
        method: 'POST',
        headers: { ...H, 'content-type': 'application/json' },
        body: JSON.stringify({ path: path.join(TMP, 'b.md'), dir: path.join(TMP, 'dst') }),
      })
    ).json();
    ok(
      'copy cross dir',
      cp2.ok === true &&
        fs.readFileSync(path.join(TMP, 'dst', 'b.md'), 'utf8') === fs.readFileSync(path.join(TMP, 'b.md'), 'utf8')
    );

    // copy：目录递归复制（含子目录与文件）
    fs.mkdirSync(path.join(TMP, 'tree', 'inner'), { recursive: true });
    fs.writeFileSync(path.join(TMP, 'tree', 'inner', 'f.txt'), 'nested');
    const cp3 = await (
      await fetch(`${BASE}/api/fs/copy`, {
        method: 'POST',
        headers: { ...H, 'content-type': 'application/json' },
        body: JSON.stringify({ path: path.join(TMP, 'tree'), dir: TMP }),
      })
    ).json();
    ok(
      'copy dir recursive',
      cp3.ok === true &&
        cp3.name === 'tree copy' &&
        fs.readFileSync(path.join(TMP, 'tree copy', 'inner', 'f.txt'), 'utf8') === 'nested',
      `name=${cp3.name}`
    );

    // copy：目录复制进自身子树 → 400（否则无限递归）
    const cp4 = await fetch(`${BASE}/api/fs/copy`, {
      method: 'POST',
      headers: { ...H, 'content-type': 'application/json' },
      body: JSON.stringify({ path: path.join(TMP, 'tree'), dir: path.join(TMP, 'tree') }),
    });
    ok('copy into itself 400', cp4.status === 400, `status=${cp4.status}`);

    // copy：源不存在 → 404
    const cp5 = await fetch(`${BASE}/api/fs/copy`, {
      method: 'POST',
      headers: { ...H, 'content-type': 'application/json' },
      body: JSON.stringify({ path: path.join(TMP, 'nope.txt'), dir: TMP }),
    });
    ok('copy missing 404', cp5.status === 404, `status=${cp5.status}`);

    // copy：目标不是目录 → 400
    const cp6 = await fetch(`${BASE}/api/fs/copy`, {
      method: 'POST',
      headers: { ...H, 'content-type': 'application/json' },
      body: JSON.stringify({ path: path.join(TMP, 'b.md'), dir: path.join(TMP, 'b.md') }),
    });
    ok('copy dest not dir 400', cp6.status === 400, `status=${cp6.status}`);

    // copy：越权路径 403 / 根目录禁止复制
    const cp7 = await fetch(`${BASE}/api/fs/copy`, {
      method: 'POST',
      headers: { ...H, 'content-type': 'application/json' },
      body: JSON.stringify({ path: path.join(TMP, 'b.md'), dir: outside }),
    });
    ok('copy outside root 403', cp7.status === 403, `status=${cp7.status}`);
    const cp8 = await fetch(`${BASE}/api/fs/copy`, {
      method: 'POST',
      headers: { ...H, 'content-type': 'application/json' },
      body: JSON.stringify({ path: roots.roots[0], dir: TMP }),
    });
    ok('copy root forbidden 403', cp8.status === 403, `status=${cp8.status}`);

    // 越权路径防护（复用在 copy 前已声明的 outside）
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
