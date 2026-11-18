#!/usr/bin/env node
/*
 * 归档 API 冒烟测试（零依赖）：自起 server/index.js 子进程，逐项验证
 * /api/fs/archive/{caps,extract,compress} 的鉴权、进度流、Zip Slip 拒绝、
 * 目标冲突、并发单槽、取消清理与压缩↔解压往返内容一致性。
 *
 * fixture 用纯 JS 生成（store-only ZIP + ustar/GNU tar + gzip）：
 * 不依赖系统 zip/tar 就能造出标准归档，因此本测试在两个平台上行为一致。
 * 真正执行解压/压缩的工具缺失时，相关用例打印 SKIP（caps 会告诉我们）。
 */
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const PORT = 3214;
const PORT_NO_TOOLS = 3215;
const BASE = `http://127.0.0.1:${PORT}`;
const BASE_NO_TOOLS = `http://127.0.0.1:${PORT_NO_TOOLS}`;
const TMP = path.join(os.tmpdir(), 'srv-archive-test-' + Date.now());
const TMP_NO_TOOLS = path.join(os.tmpdir(), 'srv-archive-notools-' + Date.now());
const ROOT = path.join(__dirname, '..');
const PASSWORD = process.env.PASSWORD || 'test123';
const JWT_SECRET = process.env.JWT_SECRET || 'test-only-jwt-secret-0123456789abcdef0123456789';

/* archive.js 在 require 阶段会加载 config.js（缺 PASSWORD / JWT_SECRET 直接 exit），
   所以必须先注入测试用环境变量，再 require。 */
process.env.PASSWORD = process.env.PASSWORD || PASSWORD;
process.env.JWT_SECRET = process.env.JWT_SECRET || JWT_SECRET;
const { __test: archiveInternals } = require('../server/api/archive');

let passed = 0;
let failed = 0;
let skipped = 0;

function ok(name, cond, extra = '') {
  if (cond) {
    passed++;
    console.log(`PASS ${name}${extra ? ' — ' + extra : ''}`);
  } else {
    failed++;
    console.log(`FAIL ${name}${extra ? ' — ' + extra : ''}`);
  }
}

function skip(name, reason) {
  skipped++;
  console.log(`SKIP ${name} — ${reason}`);
}

/* ---------- 零依赖归档生成 ---------- */

function crc32(buf) {
  if (typeof zlib.crc32 === 'function') return zlib.crc32(buf) >>> 0;
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    let c = (crc ^ buf[i]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** 生成 store（不压缩）ZIP；entries: [{ name, data?, dir? }]，目录名需以 / 结尾。
 *  opts.host='fat' 模拟 Windows 资源管理器产物（version made by = FAT 2.0 + UTF-8 标志），
 *  默认 'unix'（3.0），与 Linux/项目自身压出的归档一致。 */
function buildZip(entries, opts = {}) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const data = e.dir ? Buffer.alloc(0) : Buffer.from(e.data == null ? '' : e.data);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 文件名标志
    local.writeUInt16LE(0, 8); // store
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuf, data);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(opts.host === 'fat' ? 0x0014 : 0x031e, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(0, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(e.dir ? 0x10 : 0, 38);
    cd.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([cd, nameBuf]));

    offset += local.length + nameBuf.length + data.length;
  }
  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...chunks, centralBuf, end]);
}

function tarHeader(name, size, type, mode) {
  const h = Buffer.alloc(512);
  h.write(name.slice(0, 100), 0, 'utf8');
  h.write(mode.toString(8).padStart(7, '0') + '\0', 100);
  h.write('0000000\0', 108);
  h.write('0000000\0', 116);
  h.write(size.toString(8).padStart(11, '0') + '\0', 124);
  h.write('00000000000\0', 136);
  h.write('        ', 148); // 校验和先填空格
  h.write(type, 156);
  h.write('ustar\0', 257);
  h.write('00', 263);
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += h[i];
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  return h;
}

/** 生成 tar.gz；entries 同 buildZip */
function buildTarGz(entries) {
  const chunks = [];
  for (const e of entries) {
    const isDir = !!e.dir;
    const name = isDir && !e.name.endsWith('/') ? e.name + '/' : e.name;
    const data = isDir ? Buffer.alloc(0) : Buffer.from(e.data == null ? '' : e.data);
    chunks.push(tarHeader(name, data.length, isDir ? '5' : '0', isDir ? 0o755 : 0o644));
    if (!isDir) {
      chunks.push(data);
      const pad = (512 - (data.length % 512)) % 512;
      if (pad) chunks.push(Buffer.alloc(pad));
    }
  }
  chunks.push(Buffer.alloc(1024)); // 归档结束标记
  return zlib.gzipSync(Buffer.concat(chunks));
}

/* ---------- HTTP 辅助 ---------- */

async function waitHealth(base) {
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`${base}/api/health`);
      if (r.ok) return true;
    } catch {
      /* 未就绪继续等 */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

function startServer(port, fsRoot, extraEnv = {}) {
  return spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      PASSWORD,
      JWT_SECRET,
      FS_ROOTS: fsRoot,
      BASE_PATH: '/',
      ...extraEnv,
    },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
}

async function login(base) {
  const r = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD }),
  });
  const cookie = (r.headers.get('set-cookie') || '').split(';')[0];
  return { ok: r.status === 200 && !!cookie, cookie };
}

/** 读完整条 NDJSON 流，返回 { status, frames, code } */
async function readNdjson(res) {
  const text = await res.text();
  const frames = [];
  for (const line of text.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try {
      frames.push(JSON.parse(s));
    } catch {
      frames.push({ t: 'raw', raw: s });
    }
  }
  return { status: res.status, frames };
}

async function post(url, cookie, body) {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Cookie: cookie },
    body: JSON.stringify(body),
  });
}

const lastFrame = (frames) => frames[frames.length - 1] || {};

/** 等单槽释放：小任务重试直到 200（取消是异步清理） */
async function waitSlotFree(cookie, archiveAbs, dest) {
  for (let i = 0; i < 40; i++) {
    const r = await post(`${BASE}/api/fs/archive/extract`, cookie, { path: archiveAbs, dest });
    if (r.status === 200) {
      await r.text();
      return true;
    }
    const j = await r.json().catch(() => ({}));
    if (j.code !== 'BUSY') return false;
    await new Promise((res) => setTimeout(res, 200));
  }
  return false;
}

/* ---------- 主流程 ---------- */

(async () => {
  /* ---- 工具选择单测（与平台无关）----
     回归：pickTool 曾缺 'zip' 分支，Linux 上 zip 压缩拿到 tar 路径 + zip 的 -r 参数，
     tar 报 `Options '-Aru' are incompatible with '-f -'`。 */
  const fakeCaps = { tools: { tar: { path: 'T' }, zip: { path: 'Z' }, unzip: { path: 'U' } } };
  ok('pickTool zip → zip', archiveInternals.pickTool(fakeCaps, 'zip').cmd === 'Z');
  ok('pickTool bsdtar → tar', archiveInternals.pickTool(fakeCaps, 'bsdtar').cmd === 'T');
  ok('pickTool unzip → unzip', archiveInternals.pickTool(fakeCaps, 'unzip').cmd === 'U');
  ok('pickTool gnutar → tar', archiveInternals.pickTool(fakeCaps, 'gnutar').cmd === 'T');
  ok(
    'pickTool 缺工具 → null',
    archiveInternals.pickTool({ tools: { tar: null, zip: null, unzip: null } }, 'zip') === null
  );
  ok(
    'zip 参数以 -r 开头',
    archiveInternals.compressCommand({ cmd: 'Z', kind: 'zip' }, 'zip', '/o/a.zip', ['d'], '/src', 'zip').args[0] === '-r'
  );
  ok(
    'unzip 支持 -O 时添加 UTF-8 参数',
    archiveInternals
      .extractCommand({ cmd: 'U', kind: 'unzip', charset: true }, 'unzip', '/a.zip', '/d', { utf8Names: true })
      .args.includes('-O')
  );
  ok(
    'unzip 不支持 -O 时不添加',
    !archiveInternals
      .extractCommand({ cmd: 'U', kind: 'unzip', charset: false }, 'unzip', '/a.zip', '/d', { utf8Names: true })
      .args.includes('-O')
  );
  /* 回归：LC_ALL=C 时 Info-ZIP 把中文名转义成 #U9ad8…；LANGUAGE 会让 C locale 仍输出中文消息 */
  if (process.platform === 'linux') {
    const spawnEnv = archiveInternals.spawnOpts({}).env;
    ok('spawnOpts 使用 UTF-8 locale', /utf-?8/i.test(spawnEnv.LC_ALL || ''), `LC_ALL=${spawnEnv.LC_ALL}`);
    ok('spawnOpts 清空 LANGUAGE', spawnEnv.LANGUAGE === '', `LANGUAGE=${JSON.stringify(spawnEnv.LANGUAGE)}`);
  } else {
    skip('spawnOpts locale', `platform=${process.platform}`);
  }

  fs.mkdirSync(TMP, { recursive: true });
  fs.mkdirSync(TMP_NO_TOOLS, { recursive: true });

  const child = startServer(PORT, TMP);
  let childNoTools = null;
  try {
    ok('server health', await waitHealth(BASE));

    /* ---- 鉴权 ---- */
    ok('caps unauth 401', (await fetch(`${BASE}/api/fs/archive/caps`)).status === 401);
    ok(
      'extract unauth 401',
      (await fetch(`${BASE}/api/fs/archive/extract`, { method: 'POST', body: '{}' })).status === 401
    );

    const { ok: logged, cookie } = await login(BASE);
    ok('login cookie', logged);

    /* ---- 能力探测 ---- */
    const capsRes = await fetch(`${BASE}/api/fs/archive/caps`, { headers: { Cookie: cookie } });
    const caps = await capsRes.json();
    ok('caps 200', capsRes.status === 200 && caps.can && typeof caps.can.extractZip.ok === 'boolean');
    ok(
      'caps 结构完整',
      ['extractZip', 'extractTarGz', 'compressZip', 'compressTarGz'].every((k) => k in caps.can) &&
        'tar' in caps.tools,
      `platform=${caps.platform} tar=${caps.tools.tar ? caps.tools.tar.kind : 'none'}`
    );
    ok(
      'caps refresh=1',
      (await fetch(`${BASE}/api/fs/archive/caps?refresh=1`, { headers: { Cookie: cookie } })).status === 200
    );
    const canExtractZip = caps.can.extractZip.ok;
    const canExtractTar = caps.can.extractTarGz.ok;
    const canCompressZip = caps.can.compressZip.ok;
    const canCompressTar = caps.can.compressTarGz.ok;

    /* ---- fixture 落地 ---- */
    const sampleDir = path.join(TMP, 'payload');
    fs.mkdirSync(path.join(sampleDir, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(sampleDir, 'a.txt'), 'hello archive\n');
    fs.writeFileSync(path.join(sampleDir, '中文.txt'), '中文内容\n');
    fs.writeFileSync(path.join(sampleDir, 'sub', 'b.txt'), 'nested\n');

    const zipAbs = path.join(TMP, 'sample.zip');
    fs.writeFileSync(
      zipAbs,
      buildZip([
        { name: 'sample/', dir: true },
        { name: 'sample/a.txt', data: 'hello archive\n' },
        { name: 'sample/中文.txt', data: '中文内容\n' },
        { name: 'sample/sub/', dir: true },
        { name: 'sample/sub/b.txt', data: 'nested\n' },
      ])
    );

    const tgzAbs = path.join(TMP, 'sample-tar.tar.gz');
    fs.writeFileSync(
      tgzAbs,
      buildTarGz([
        { name: 'sample', dir: true },
        { name: 'sample/a.txt', data: 'hello archive\n' },
        { name: 'sample/中文.txt', data: '中文内容\n' },
        { name: 'sample/sub', dir: true },
        { name: 'sample/sub/b.txt', data: 'nested\n' },
      ])
    );

    /* ---- 解压 zip（默认同名子文件夹 + 进度帧） ---- */
    if (!canExtractZip) {
      skip('extract zip', 'no zip extractor available');
    } else {
      const r = await post(`${BASE}/api/fs/archive/extract`, cookie, { path: zipAbs });
      const { frames } = await readNdjson(r);
      const done = lastFrame(frames);
      const progress = frames.filter((f) => f.t === 'progress');
      ok('extract zip 200 + done', r.status === 200 && done.t === 'done', `status=${r.status} frames=${frames.length}`);
      ok('extract zip 帧类型合法', frames.every((f) => ['progress', 'done', 'error'].includes(f.t)));
      ok('extract zip 有进度帧', progress.length > 0, `${progress.length} 帧`);
      ok(
        'extract zip 百分比单调',
        progress.every((f, i) => i === 0 || f.percent >= progress[i - 1].percent)
      );
      ok('extract zip items', done.items === 5, `items=${done.items}`);
      ok('extract zip dest 同名文件夹', done.dest === path.join(TMP, 'sample'), done.dest || '(none)');
      ok('extract zip 内容一致', fs.readFileSync(path.join(TMP, 'sample', 'a.txt'), 'utf8') === 'hello archive\n');
      ok(
        'extract zip 中文文件名',
        fs.readFileSync(path.join(TMP, 'sample', '中文.txt'), 'utf8') === '中文内容\n'
      );
      ok(
        'extract zip 子目录',
        fs.readFileSync(path.join(TMP, 'sample', 'sub', 'b.txt'), 'utf8') === 'nested\n'
      );
      ok('extract 无 staging 残留', fs.readdirSync(TMP).every((n) => !n.startsWith('.wdpart-')));

      /* 再解一次 → sample 2 */
      const r2 = await post(`${BASE}/api/fs/archive/extract`, cookie, { path: zipAbs });
      const d2 = lastFrame((await readNdjson(r2)).frames);
      ok('extract 重名自动编号', d2.dest === path.join(TMP, 'sample 2'), d2.dest || '(none)');
    }

    /* ---- 解压 tar.gz ---- */
    if (!canExtractTar) {
      skip('extract tar.gz', 'no tar.gz extractor available');
    } else {
      const r = await post(`${BASE}/api/fs/archive/extract`, cookie, { path: tgzAbs });
      const d = lastFrame((await readNdjson(r)).frames);
      ok('extract tar.gz done', r.status === 200 && d.t === 'done', `status=${r.status}`);
      ok('extract tar.gz dest', d.dest === path.join(TMP, 'sample-tar'), d.dest || '(none)');
      ok(
        'extract tar.gz 内容一致（顶层目录已上提）',
        fs.readFileSync(path.join(TMP, 'sample-tar', 'a.txt'), 'utf8') === 'hello archive\n'
      );
    }

    /* ---- 显式目标：自动创建 + 空目录 ---- */
    if (canExtractZip) {
      const dest = path.join(TMP, 'explicit-out');
      const r = await post(`${BASE}/api/fs/archive/extract`, cookie, { path: zipAbs, dest });
      const d = lastFrame((await readNdjson(r)).frames);
      ok('extract 显式新目标', r.status === 200 && d.t === 'done' && d.createdDest === true, d.dest || '');
      // 显式目标保留归档原始结构（不做顶层目录上提）
      ok('extract 显式目标已创建', fs.existsSync(path.join(dest, 'sample', 'a.txt')));

      // 目标非空 → 409 DEST_NOT_EMPTY；带 overwrite 合并覆盖
      fs.writeFileSync(path.join(dest, 'keep.txt'), 'keep me\n');
      fs.writeFileSync(path.join(dest, 'sample', 'a.txt'), 'stale\n');
      const conflict = await post(`${BASE}/api/fs/archive/extract`, cookie, { path: zipAbs, dest });
      const cj = await conflict.json();
      ok('extract 目标非空 409', conflict.status === 409 && cj.code === 'DEST_NOT_EMPTY', `status=${conflict.status}`);
      const over = await post(`${BASE}/api/fs/archive/extract`, cookie, { path: zipAbs, dest, overwrite: true });
      const od = lastFrame((await readNdjson(over)).frames);
      ok('extract overwrite 合并', over.status === 200 && od.t === 'done', `status=${over.status}`);
      ok(
        'extract overwrite 覆盖同名',
        fs.readFileSync(path.join(dest, 'sample', 'a.txt'), 'utf8') === 'hello archive\n'
      );
      ok('extract overwrite 保留其它文件', fs.existsSync(path.join(dest, 'keep.txt')));
    }

    /* ---- 空归档 ---- */
    if (canExtractZip) {
      const emptyZip = path.join(TMP, 'empty.zip');
      fs.writeFileSync(emptyZip, buildZip([]));
      const r = await post(`${BASE}/api/fs/archive/extract`, cookie, { path: emptyZip });
      const d = lastFrame((await readNdjson(r)).frames);
      ok('extract 空归档 done', r.status === 200 && d.t === 'done', `status=${r.status} items=${d.items}`);
    }

    /* Windows 风格归档（host=FAT + UTF-8 标志）：Linux 的 unzip 默认按 OEM 解码，会变成 ф╕нцЦЗ */
    if (canExtractZip) {
      const winZip = path.join(TMP, 'win-style.zip');
      fs.writeFileSync(
        winZip,
        buildZip(
          [
            { name: 'win/', dir: true },
            { name: 'win/中文名.txt', data: '中文名\n' },
          ],
          { host: 'fat' }
        )
      );
      const winDest = path.join(TMP, 'win-out');
      const rw = await post(`${BASE}/api/fs/archive/extract`, cookie, { path: winZip, dest: winDest });
      const dw = lastFrame((await readNdjson(rw)).frames);
      ok('extract Windows 风格 zip done', dw.t === 'done', `status=${rw.status}`);
      ok(
        'extract Windows 风格 zip 中文名',
        fs.existsSync(path.join(winDest, 'win', '中文名.txt')) &&
          fs.readFileSync(path.join(winDest, 'win', '中文名.txt'), 'utf8') === '中文名\n'
      );
    }

    /* ---- Zip Slip / 参数拒绝 ---- */
    if (canExtractZip) {
      const evilCases = [
        ['../evil.txt', '../evil.txt'],
        ['/abs-evil.txt', '/abs-evil.txt'],
        ['C:/drive-evil.txt', 'C:/drive-evil.txt'],
        ['a/../../x.txt', 'a/../../x.txt'],
        ['a\\..\\..\\win-evil.txt', 'a\\..\\..\\win-evil.txt'],
      ];
      for (const [entryName, label] of evilCases) {
        const abs = path.join(TMP, 'evil-' + Math.random().toString(16).slice(2) + '.zip');
        fs.writeFileSync(abs, buildZip([{ name: entryName, data: 'pwn\n' }]));
        const r = await post(`${BASE}/api/fs/archive/extract`, cookie, { path: abs });
        const j = await r.json();
        ok(`zip-slip 拒绝 ${label}`, r.status === 400 && j.code === 'UNSAFE_ARCHIVE', `status=${r.status}`);
        ok(`zip-slip 未落盘 ${label}`, !fs.existsSync(path.join(TMP, 'evil.txt')) && !fs.existsSync(path.join(TMP, 'x.txt')));
        fs.unlinkSync(abs);
      }
    }

    ok(
      'extract 不存在 404',
      (await post(`${BASE}/api/fs/archive/extract`, cookie, { path: path.join(TMP, 'nope.zip') })).status === 404
    );
    ok(
      'extract 越权 403',
      (await post(`${BASE}/api/fs/archive/extract`, cookie, { path: path.join(os.tmpdir(), 'outside-archive.zip') })).status ===
        403
    );
    ok(
      'extract 非归档 400',
      (await post(`${BASE}/api/fs/archive/extract`, cookie, { path: path.join(TMP, 'a.txt') })).status === 400
    );

    const destAsFile = path.join(TMP, 'dest-is-file');
    fs.writeFileSync(destAsFile, 'x');
    const rFile = await post(`${BASE}/api/fs/archive/extract`, cookie, { path: zipAbs, dest: destAsFile });
    const jFile = await rFile.json();
    ok('extract 目标是文件 400', rFile.status === 400 && jFile.code === 'DEST_NOT_DIR', `status=${rFile.status}`);

    const rRoot = await post(`${BASE}/api/fs/archive/extract`, cookie, { path: zipAbs, dest: TMP });
    const jRoot = await rRoot.json();
    ok('extract 目标非空 409（根同义）', [400, 409].includes(rRoot.status), `status=${rRoot.status} code=${jRoot.code}`);

    /* ---- 并发单槽 + 取消 ---- */
    if (canExtractZip) {
      const bigZip = path.join(TMP, 'big.zip');
      const entries = [];
      for (let i = 0; i < 6000; i++) {
        entries.push({ name: `big/f${i}.txt`, data: 'x'.repeat(64) });
      }
      fs.writeFileSync(bigZip, buildZip(entries));

      const bigDest = path.join(TMP, 'big-out');
      const first = post(`${BASE}/api/fs/archive/extract`, cookie, { path: bigZip, dest: bigDest });
      await new Promise((r) => setTimeout(r, 60));
      const second = await post(`${BASE}/api/fs/archive/extract`, cookie, { path: zipAbs, dest: path.join(TMP, 'busy-out') });
      const sj = await second.json().catch(() => ({}));
      ok('并发第二个请求 409 BUSY', second.status === 409 && sj.code === 'BUSY', `status=${second.status}`);
      await first.then((r) => r.text());

      // 取消：读到首个 chunk 后 abort，服务端应清理 staging 并释放槽
      const ac = new AbortController();
      const cancelDest = path.join(TMP, 'cancel-out');
      let sawBytes = false;
      try {
        const res = await fetch(`${BASE}/api/fs/archive/extract`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', Cookie: cookie },
          body: JSON.stringify({ path: bigZip, dest: cancelDest }),
          signal: ac.signal,
        });
        const reader = res.body.getReader();
        const first1 = await reader.read();
        sawBytes = !first1.done;
        ac.abort();
        await reader.read().catch(() => {});
      } catch (e) {
        sawBytes = sawBytes || (e && e.name === 'AbortError');
      }
      ok('取消：已收到进度字节', sawBytes);
      const freed = await waitSlotFree(cookie, zipAbs, path.join(TMP, 'after-cancel'));
      ok('取消：单槽已释放', freed);
      ok('取消：无 staging 残留', fs.readdirSync(TMP).every((n) => !n.startsWith('.wdpart-')));
      ok('取消：目标目录未留下半成品', !fs.existsSync(cancelDest) || fs.readdirSync(cancelDest).length === 0);
    }

    /* ---- 压缩 ---- */
    if (canCompressZip) {
      const outDir = path.join(TMP, 'compress-out');
      fs.mkdirSync(outDir, { recursive: true });

      // 单文件 → zip
      const srcFile = path.join(TMP, 'single.txt');
      fs.writeFileSync(srcFile, 'single file\n');
      const r1 = await post(`${BASE}/api/fs/archive/compress`, cookie, {
        paths: [srcFile],
        format: 'zip',
        dest: outDir,
      });
      const d1 = lastFrame((await readNdjson(r1)).frames);
      ok('compress 单文件 done', r1.status === 200 && d1.t === 'done', `status=${r1.status}`);
      ok('compress 单文件产物', d1.dest === path.join(outDir, 'single.txt.zip'), d1.dest || '');
      ok('compress 产物非空', fs.existsSync(d1.dest) && fs.statSync(d1.dest).size > 0);

      // 目录 → zip → 再解回，内容一致
      const r2 = await post(`${BASE}/api/fs/archive/compress`, cookie, {
        paths: [sampleDir],
        format: 'zip',
        dest: outDir,
      });
      const d2 = lastFrame((await readNdjson(r2)).frames);
      ok('compress 目录 done', r2.status === 200 && d2.t === 'done', d2.dest || '');
      const roundTrip = path.join(TMP, 'roundtrip');
      if (d2.dest && canExtractZip) {
        const r3 = await post(`${BASE}/api/fs/archive/extract`, cookie, { path: d2.dest, dest: roundTrip });
        await readNdjson(r3);
        // 显式目标保留归档原始结构（payload/ 顶层目录不被上提）
        ok(
          'compress→extract 往返一致',
          fs.existsSync(path.join(roundTrip, 'payload', 'sub', 'b.txt')) &&
            fs.readFileSync(path.join(roundTrip, 'payload', 'a.txt'), 'utf8') === 'hello archive\n'
        );
        // 中文名必须原样还原（C locale 下 unzip 会写成 #U4e2d#U6587.txt 这类转义）
        ok(
          '往返中文文件名未变形',
          fs.existsSync(path.join(roundTrip, 'payload', '中文.txt')) &&
            fs.readFileSync(path.join(roundTrip, 'payload', '中文.txt'), 'utf8') === '中文内容\n'
        );
      }
      // 重名 → 自动编号
      const r4 = await post(`${BASE}/api/fs/archive/compress`, cookie, {
        paths: [srcFile],
        format: 'zip',
        dest: outDir,
      });
      const d4 = lastFrame((await readNdjson(r4)).frames);
      ok('compress 重名自动编号', /single\.txt 2\.zip$/.test(d4.dest || ''), d4.dest || '');

      // tar.gz
      if (canCompressTar) {
        const r5 = await post(`${BASE}/api/fs/archive/compress`, cookie, {
          paths: [srcFile],
          format: 'tar.gz',
          dest: outDir,
        });
        const d5 = lastFrame((await readNdjson(r5)).frames);
        ok('compress tar.gz done', r5.status === 200 && /\.tar\.gz$/.test(d5.dest || ''), d5.dest || '');
      } else {
        skip('compress tar.gz', 'no tar.gz compressor available');
      }
    } else {
      skip('compress zip', 'no zip compressor available');
    }

    /* ---- 压缩参数拒绝 ---- */
    if (canCompressZip) {
      const outDir = path.join(TMP, 'compress-out');
      const e1 = await post(`${BASE}/api/fs/archive/compress`, cookie, { paths: [], format: 'zip', dest: outDir });
      ok('compress 空选择 400', e1.status === 400 && (await e1.json()).code === 'EMPTY_SELECTION');

      const e2 = await post(`${BASE}/api/fs/archive/compress`, cookie, {
        paths: [path.join(os.tmpdir(), 'outside.txt')],
        format: 'zip',
        dest: outDir,
      });
      ok('compress 越权 403', e2.status === 403);

      const e3 = await post(`${BASE}/api/fs/archive/compress`, cookie, {
        paths: [path.join(TMP, 'ghost.txt')],
        format: 'zip',
        dest: outDir,
      });
      ok('compress 源不存在 404', e3.status === 404);

      const e4 = await post(`${BASE}/api/fs/archive/compress`, cookie, {
        paths: [path.join(TMP, 'single.txt')],
        format: 'rar',
        dest: outDir,
      });
      ok('compress 非法格式 400', e4.status === 400);

      // 产物落在被压缩目录内部：dest 指向 payload 自己
      const e5 = await post(`${BASE}/api/fs/archive/compress`, cookie, {
        paths: [path.join(TMP, 'payload')],
        format: 'zip',
        dest: path.join(TMP, 'payload'),
      });
      ok('compress 产物在源内 400', e5.status === 400, `status=${e5.status}`);
    }

    /* ---- 非法 body ---- */
    const badBody = await fetch(`${BASE}/api/fs/archive/extract`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Cookie: cookie },
      body: '{not json',
    });
    ok('extract 非法 body 400', badBody.status === 400);

    /* ---- 工具缺失（第二实例，路径指向不存在的文件） ---- */
    childNoTools = startServer(PORT_NO_TOOLS, TMP_NO_TOOLS, {
      ARCHIVE_TAR_PATH: path.join(TMP_NO_TOOLS, 'no-tar'),
      ARCHIVE_UNZIP_PATH: path.join(TMP_NO_TOOLS, 'no-unzip'),
      ARCHIVE_ZIP_PATH: path.join(TMP_NO_TOOLS, 'no-zip'),
    });
    ok('no-tools server health', await waitHealth(BASE_NO_TOOLS));
    const nt = await login(BASE_NO_TOOLS);
    const ntCaps = await (await fetch(`${BASE_NO_TOOLS}/api/fs/archive/caps`, { headers: { Cookie: nt.cookie } })).json();
    ok(
      'no-tools caps 全 false',
      !ntCaps.can.extractZip.ok && !ntCaps.can.extractTarGz.ok && !ntCaps.can.compressZip.ok && !ntCaps.can.compressTarGz.ok,
      JSON.stringify(ntCaps.can.extractZip)
    );
    ok('no-tools 有安装提示', typeof ntCaps.can.extractZip.hint === 'string' && ntCaps.can.extractZip.hint.length > 0);

    // 归档必须落在第二实例自己的 FS_ROOTS 内，否则会先被 403 挡掉
    const ntZip = path.join(TMP_NO_TOOLS, 'sample.zip');
    fs.copyFileSync(zipAbs, ntZip);
    const ntExtract = await post(`${BASE_NO_TOOLS}/api/fs/archive/extract`, nt.cookie, { path: ntZip });
    const ntj = await ntExtract.json();
    ok('no-tools extract 503', ntExtract.status === 503 && ntj.code === 'TOOL_MISSING', `status=${ntExtract.status}`);
    ok('no-tools 503 带 hint', typeof ntj.hint === 'string' && ntj.hint.length > 0);
  } catch (e) {
    failed++;
    console.log('FAIL 未捕获异常 — ' + ((e && e.stack) || e));
  } finally {
    for (const c of [child, childNoTools]) {
      if (!c) continue;
      try {
        c.kill('SIGTERM');
      } catch {
        /* 已退出 */
      }
    }
    await new Promise((r) => setTimeout(r, 300));
    for (const dir of [TMP, TMP_NO_TOOLS]) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* 忽略 */
      }
    }
    console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped`);
    process.exit(failed === 0 ? 0 : 1);
  }
})();
