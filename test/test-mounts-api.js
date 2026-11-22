#!/usr/bin/env node
/* 网络挂载 API 冒烟测试：零依赖。spawn 服务子进程，验证 /api/mounts/* 的连接 CRUD、
 * 鉴权、密码隔离、输入校验与能力探测后自清理。不执行真实 mount（无需 root / cifs-utils）。
 * 用法：node test/test-mounts-api.js
 */
'use strict';
const { spawn } = require('child_process');
const os = require('os');
const path = require('path');

const PORT = 3219;
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = path.join(__dirname, '..');
const PASSWORD = process.env.PASSWORD || 'test123';
const JWT_SECRET = process.env.JWT_SECRET || 'test-only-jwt-secret-0123456789abcdef0123456789';
const TMP_HOME = path.join(os.tmpdir(), 'srv-mounts-test-' + Date.now());

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

async function jfetch(url, H, init = {}) {
  const r = await fetch(url, { ...init, headers: { ...H, 'content-type': 'application/json', ...(init.headers || {}) } });
  let body = null;
  try { body = await r.json(); } catch { /* 非 JSON */ }
  return { status: r.status, body };
}

(async () => {
  // 用临时 HOME 隔离 userdata / 凭据，避免污染真实 ~/.watchdog-os
  try { require('fs').rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* 首次运行目录不存在 */ }
  // 同时设 USERPROFILE 与 HOME：Windows 上 os.homedir() 读 USERPROFILE，POSIX 读 HOME，
  // 少设一个都会导致 userdata.js 写到真实用户目录、污染测试数据。
  const env = {
    ...process.env,
    PORT: String(PORT),
    PASSWORD,
    JWT_SECRET,
    BASE_PATH: '/',
    HOME: TMP_HOME,
    USERPROFILE: TMP_HOME,
    MOUNTS_AUTO_MOUNT: 'false', // 不尝试恢复挂载（测试环境无 sudo）
  };
  const child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    cwd: ROOT,
    env,
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  try {
    ok('server health', await waitHealth());
    if (!(await waitHealth())) throw new Error('server did not start');

    const unauth = await fetch(`${BASE}/api/mounts`);
    ok('mounts unauth 401', unauth.status === 401, `status=${unauth.status}`);

    const login = await fetch(`${BASE}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: PASSWORD }),
    });
    const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
    const H = { Cookie: cookie };
    ok('login cookie', login.status === 200 && !!cookie);

    // caps：任何状态都 200，字段齐全
    const caps = await jfetch(`${BASE}/api/mounts/caps`, H);
    ok('caps 200', caps.status === 200);
    ok('caps shape', caps.body && typeof caps.body.supported === 'boolean' && Array.isArray(caps.body.missing));

    // 初始列表为空
    const empty = await jfetch(`${BASE}/api/mounts`, H);
    ok('empty list', empty.status === 200 && empty.body.connections.length === 0);

    // 校验：SMB 缺密码 → 400
    const badNoPwd = await jfetch(`${BASE}/api/mounts`, H, {
      method: 'POST',
      body: JSON.stringify({ name: 'x', protocol: 'smb', host: 'h', share: 's', username: 'u' }),
    });
    ok('create requires password', badNoPwd.status === 400, `status=${badNoPwd.status}`);

    // 校验：WebDAV URL 内嵌凭据 → 400
    const badUrl = await jfetch(`${BASE}/api/mounts`, H, {
      method: 'POST',
      body: JSON.stringify({ name: 'x', protocol: 'webdav', url: 'https://u:p@host/dav', username: 'u', password: 'p' }),
    });
    ok('reject embedded creds in URL', badUrl.status === 400, `status=${badUrl.status}`);

    // 校验：SMB share 路径穿越 → 400
    const badShare = await jfetch(`${BASE}/api/mounts`, H, {
      method: 'POST',
      body: JSON.stringify({ name: 'x', protocol: 'smb', host: 'h', share: '../../etc', username: 'u', password: 'p' }),
    });
    ok('reject traversal share', badShare.status === 400, `status=${badShare.status}`);

    // 校验：非法协议 → 400
    const badProto = await jfetch(`${BASE}/api/mounts`, H, {
      method: 'POST',
      body: JSON.stringify({ name: 'x', protocol: 'ftp', host: 'h', share: 's', username: 'u', password: 'p' }),
    });
    ok('reject unknown protocol', badProto.status === 400, `status=${badProto.status}`);

    // 新建 SMB 连接
    const created = await jfetch(`${BASE}/api/mounts`, H, {
      method: 'POST',
      body: JSON.stringify({ name: 'Office NAS', protocol: 'smb', host: '192.168.1.10', share: 'public', username: 'alice', password: 'secret', autoMount: false }),
    });
    ok('create SMB', created.status === 200 && created.body.connection.name === 'Office NAS', `status=${created.status}`);
    const id = created.body && created.body.connection && created.body.connection.id;
    ok('no password in response', !!id && !JSON.stringify(created.body).includes('secret'));
    ok('id is safe slug', /^[A-Za-z0-9_-]+$/.test(id || ''), `id=${id}`);

    // 新建 WebDAV 连接
    const created2 = await jfetch(`${BASE}/api/mounts`, H, {
      method: 'POST',
      body: JSON.stringify({ name: 'Cloud', protocol: 'webdav', url: 'https://dav.example.com/remote.php/dav', username: 'bob', password: 'pw' }),
    });
    ok('create WebDAV', created2.status === 200, `status=${created2.status}`);

    // 列表有两条，mounted=false，不含密码
    const listed = await jfetch(`${BASE}/api/mounts`, H);
    ok('list has 2', listed.body.connections.length === 2);
    ok('list mounted false', listed.body.connections.every((c) => c.mounted === false));
    ok('list no password', !JSON.stringify(listed.body).includes('secret') && !JSON.stringify(listed.body).includes('pw'));

    // 更新：改名字 + 留空密码（保留）
    const updated = await jfetch(`${BASE}/api/mounts/${id}`, H, {
      method: 'PUT',
      body: JSON.stringify({ name: 'Renamed NAS', protocol: 'smb', host: '192.168.1.10', share: 'public', username: 'alice' }),
    });
    ok('update keeps id/password', updated.status === 200 && updated.body.connection.id === id && updated.body.connection.name === 'Renamed NAS', `status=${updated.status}`);

    // fs 根列表：Linux 下包含挂载父目录（MOUNTS_DIR 并入 FS_ROOTS）；
    // Windows 下原生挂载被禁用，按设计不并入——两种都符合预期。
    const roots = await jfetch(`${BASE}/api/fs/list`, H);
    const hasMountsRoot = roots.body.roots.some((r) => r.endsWith('mounts'));
    ok(
      'roots mounts dir (platform-aware)',
      process.platform === 'win32' ? !hasMountsRoot : hasMountsRoot,
      `platform=${process.platform}, roots=${(roots.body.roots || []).join(', ')}`
    );

    // 不存在 id 的操作 → 404
    const notFound = await jfetch(`${BASE}/api/mounts/m_nope/unmount`, H, { method: 'POST' });
    ok('unknown id 404', notFound.status === 404, `status=${notFound.status}`);

    // 删除连接（未挂载，直接删）
    const deleted = await jfetch(`${BASE}/api/mounts/${id}`, H, { method: 'DELETE' });
    ok('delete connection', deleted.status === 200, `status=${deleted.status}`);
    const after = await jfetch(`${BASE}/api/mounts`, H);
    ok('list after delete', after.body.connections.length === 1);
  } finally {
    child.kill('SIGTERM');
    // 清理临时 HOME
    try { require('fs').rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* 忽略 */ }
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error(e && e.stack || e);
  process.exit(1);
});
