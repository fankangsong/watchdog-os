/**
 * 网络挂载管理（Files 的 SMB / WebDAV 远程目录）：
 * 把远程共享经系统原生 mount（cifs / davfs2）挂到本地 MOUNTS_DIR/<id>，
 * 之后 Files 的所有 node:fs 操作对远程目录完全透明——前端无需知道它是远程的。
 *
 * 安全边界（威胁模型：已登录的 Web 用户不可借本接口提权 / 挂任意文件系统 / 读取任意主机文件）：
 *  1. 挂载动作一律经 sudo -n 调用随项目附带的 mount-helper.sh；sudoers 只白名单该脚本，
 *     脚本内部再对 action、挂载点前缀、UNC/URL 做二次校验。后端绝不拼接 shell 字符串，
 *     全部用 execFile 传参数组（无 shell 注入面）。
 *  2. 连接配置存 ~/.watchdog-os/data.json 的 mounts 键（**不含密码**）；
 *     密码单独写 ~/.watchdog-os/mount-creds/<id>.cred，chmod 600。
 *     API 任何响应都不回传 password 字段（见 publicConn）。
 *  3. id 是服务端生成的严格 slug（/^[A-Za-z0-9_-]{1,64}$/），客户端不可自定义路径，
 *     挂载点 = MOUNTS_DIR/<id>，杜绝路径穿越到 MOUNTS_DIR 之外。
 *  4. SMB 的 UNC 与 WebDAV 的 URL 都做协议/hostname 白名单校验，禁用嵌入凭据的用户名@主机
 *     写法（凭据只走 cred 文件），禁 file:/ftp: 等非目标协议。
 *  5. 检测（caps / status）不需要 sudo：Linux 读 /proc/mounts，据此判断挂载点是否已挂载。
 *
 * 能力探测（/api/mounts/caps）区分三种"不可用"：平台不支持 / 工具缺失 / 未配 sudoers，
 * 前端据此给出可操作的安装提示，而不是笼统的 503。
 */
'use strict';

const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const { execFile } = require('child_process');
const { cfg, MOUNTS_DIR } = require('../config');
const { loadUserData, saveUserData, DATA_DIR } = require('../lib/userdata');
const { readBody, send } = require('../lib/http');

const CRED_DIR = path.join(DATA_DIR, 'mount-creds');
const HELPER = path.join(__dirname, '..', '..', 'scripts', 'mount-helper.sh');
const STORE_KEY = 'mounts';
const MAX_CONNECTIONS = 100;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/* ---------- 工具 ---------- */

function newId() {
  return 'm_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
}

/** 只保留公开字段，密码与凭据文件路径永不回传 */
function publicConn(c) {
  return {
    id: c.id,
    name: c.name,
    protocol: c.protocol,
    host: c.host || '',
    share: c.share || '',
    domain: c.domain || '',
    url: c.url || '',
    username: c.username || '',
    autoMount: !!c.autoMount,
    createdAt: c.createdAt || 0,
    mountPoint: path.join(MOUNTS_DIR, c.id),
  };
}

/** 传输层错误 → HTTP 状态码（业务校验错误统一由调用点 send 400） */
function fail(res, e) {
  const msg = (e && e.message) || String(e);
  return send(res, 500, { error: msg });
}

function readJsonBody(req) {
  return readBody(req, 32 * 1024).then((t) => JSON.parse(t || '{}'));
}

/** 轻量异步命令执行：返回 { ok, stdout, stderr }，永不抛（超时 / 不存在视为 ok:false） */
function run(cmd, args, timeout) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeout || cfg.mounts.timeoutMs, windowsHide: true }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

/* ---------- 配置存储 ---------- */

async function loadConns() {
  const data = await loadUserData();
  const list = data[STORE_KEY];
  return Array.isArray(list) ? list.filter((c) => c && typeof c === 'object' && ID_RE.test(String(c.id))) : [];
}

async function saveConns(list) {
  await saveUserData({ [STORE_KEY]: list });
}

async function credPath(id) {
  return path.join(CRED_DIR, id + '.cred');
}

/** 写凭据文件：目录 700、文件 600（root 可读；普通用户读不到） */
async function writeCred(id, password) {
  await fsp.mkdir(CRED_DIR, { recursive: true, mode: 0o700 });
  const file = await credPath(id);
  await fsp.writeFile(file, String(password), { mode: 0o600, encoding: 'utf8' });
  await fsp.chmod(file, 0o600).catch(() => {});
}

async function deleteCred(id) {
  await fsp.unlink(await credPath(id)).catch(() => {});
}

/* ---------- 输入校验 ---------- */

/** 校验连接器字段；返回规范化后的连接对象，或抛 Error（消息即给用户看的提示） */
function validateConn(body, existing) {
  if (!body || typeof body !== 'object') throw new Error('Invalid request body');
  const protocol = String(body.protocol || (existing && existing.protocol) || '').toLowerCase();
  if (protocol !== 'smb' && protocol !== 'webdav') throw new Error('protocol must be smb or webdav');

  const name = String(body.name || (existing && existing.name) || '').trim().slice(0, 80);
  if (!name) throw new Error('name is required');

  const username = String(body.username != null ? body.username : existing ? existing.username : '').trim().slice(0, 256);
  const domain = String(body.domain != null ? body.domain : existing ? existing.domain : '').trim().slice(0, 128);
  const autoMount = body.autoMount != null ? !!body.autoMount : existing ? !!existing.autoMount : false;

  const conn = {
    id: existing ? existing.id : newId(),
    name,
    protocol,
    username,
    domain,
    autoMount,
    createdAt: existing ? existing.createdAt : Date.now(),
  };

  if (protocol === 'smb') {
    const host = String(body.host != null ? body.host : existing ? existing.host : '').trim().slice(0, 253);
    const share = String(body.share != null ? body.share : existing ? existing.share : '').trim().slice(0, 128);
    // 禁止 host 里嵌凭据 / 路径 / 空白；仅允许域名、IPv4、IPv6(带括号)、下划线、连字符、点
    if (!host || !/^[A-Za-z0-9._\-\[\]:]+$/.test(host)) throw new Error('Invalid SMB host');
    if (!share || share.includes('\\') || share.includes('/') || share.includes('..')) throw new Error('Invalid SMB share');
    conn.host = host;
    conn.share = share;
  } else {
    let url = String(body.url != null ? body.url : existing ? existing.url : '').trim();
    if (!url) throw new Error('WebDAV URL is required');
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error('Invalid WebDAV URL');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('WebDAV URL must be http(s)');
    if (parsed.username || parsed.password) throw new Error('Do not embed credentials in the WebDAV URL');
    conn.url = url;
  }

  // 密码：新增必填；更新时留空 = 保留原密码
  const hasPwdField = Object.prototype.hasOwnProperty.call(body, 'password');
  const password = hasPwdField ? String(body.password == null ? '' : body.password) : '';
  if (!existing && !password) throw new Error('password is required');
  if (password.length > 4096) throw new Error('password is too long');
  conn._password = password; // 仅内部传递，publicConn 不输出
  return conn;
}

/* ---------- 能力探测 ---------- */

/** 同步判断某可执行文件是否存在于 PATH（零依赖） */
function which(bin) {
  const parts = String(process.env.PATH || '').split(path.delimiter);
  for (const d of parts) {
    if (!d) continue;
    const p = path.join(d, bin);
    try {
      if (fs.statSync(p).isFile()) return true;
    } catch { /* 不存在 */ }
  }
  return false;
}

/**
 * 能力矩阵（不触发挂载，只读探测）：
 *  platform / supported / reasons[] / missing[] / sudo / helper / engines{smb,webdav}
 */
async function caps() {
  const linux = process.platform === 'linux';
  const reasons = [];
  const missing = [];
  if (!linux) reasons.push('native mount is only supported on Linux');

  const hasMount = which('mount');
  const hasUmount = which('umount');
  const hasSudo = which('sudo');
  let helperOk = false;
  try {
    const st = await fsp.stat(HELPER);
    helperOk = st.isFile() && (st.mode & 0o111) !== 0;
  } catch {
    helperOk = false;
  }
  if (!hasMount) missing.push('mount');
  if (!hasUmount) missing.push('umount');
  if (!hasSudo) missing.push('sudo');
  if (!helperOk) missing.push('scripts/mount-helper.sh (executable)');

  // sudoers 是否真的配好：sudo -n -l 列出权限，检查是否含 helper 绝对路径。
  // 失败不视为致命（可能只是当前用户不在白名单），单独标记以便给出安装提示。
  let sudoersOk = false;
  if (hasSudo) {
    const r = await run('sudo', ['-n', '-l'], 8000);
    sudoersOk = r.ok && r.stdout.includes(HELPER);
  }

  const engines = {
    smb: linux && hasMount && fs.existsSync('/sbin/mount.cifs'),
    webdav: linux && hasMount && (fs.existsSync('/sbin/mount.davfs') || fs.existsSync('/usr/sbin/mount.davfs')),
  };
  if (linux && !engines.smb) missing.push('cifs-utils (mount.cifs)');
  if (linux && !engines.webdav) missing.push('davfs2 (mount.davfs)');

  const supported = linux && hasMount && hasSudo && helperOk && sudoersOk && (engines.smb || engines.webdav);
  return {
    platform: process.platform,
    supported,
    reasons,
    missing,
    sudoersOk,
    helper: HELPER,
    mountsDir: MOUNTS_DIR,
    engines,
  };
}

/* ---------- 挂载状态（无需 sudo） ---------- */

/**
 * 读取 /proc/mounts 返回已挂载路径集合（Linux）。
 * 每个挂载点在 /proc/mounts 里第二列是转义后的路径（\040 表示空格等），
 * 我们的挂载点 id 是纯 slug 无空格，故直接字符串比较即可。
 */
async function mountedSet() {
  const out = new Set();
  if (process.platform !== 'linux') return out;
  try {
    const txt = await fsp.readFile('/proc/mounts', 'utf8');
    for (const line of txt.split('\n')) {
      const cols = line.split(/\s+/);
      if (cols.length >= 2 && cols[1].startsWith(MOUNTS_DIR)) out.add(cols[1]);
    }
  } catch {
    /* /proc 不可读：状态一律显示未挂载（安全侧） */
  }
  return out;
}

/**
 * 列连接 + 实时状态。返回 { connections: [...], caps }。
 * 每项含 mounted:boolean，不含 password。
 */
async function listPayload() {
  const [conns, mounted, c] = await Promise.all([loadConns(), mountedSet(), caps()]);
  return {
    connections: conns.map((x) => ({ ...publicConn(x), mounted: mounted.has(path.join(MOUNTS_DIR, x.id)) })),
    caps: c,
  };
}

/* ---------- 挂载 / 卸载 ---------- */

/** 供启动恢复 / 单个连接挂载；返回 { ok, error? } */
async function doMount(conn) {
  const mp = path.join(MOUNTS_DIR, conn.id);
  await fsp.mkdir(mp, { recursive: true });
  const args = [HELPER, 'mount', conn.protocol, mp];
  const cred = await credPath(conn.id);
  if (conn.protocol === 'smb') {
    // UNC 形如 //host/share（helper 负责拼 vers/domain 等选项，凭据从 cred 文件读）
    args.push('//' + conn.host + '/' + conn.share, cred, conn.domain || '', conn.username || '');
  } else {
    args.push(conn.url, cred, conn.username || '');
  }
  const r = await run('sudo', ['-n', ...args]);
  if (!r.ok) return { ok: false, error: (r.stderr || r.stdout || 'mount failed').trim().slice(0, 500) };
  return { ok: true };
}

async function doUnmount(conn) {
  const mp = path.join(MOUNTS_DIR, conn.id);
  const r = await run('sudo', ['-n', HELPER, 'umount', mp]);
  if (!r.ok) return { ok: false, error: (r.stderr || r.stdout || 'umount failed').trim().slice(0, 500) };
  return { ok: true };
}

/** 启动恢复：对标记为 autoMount 的连接逐个尝试挂载（失败只 warn，不影响服务启动） */
async function startMounts() {
  try {
    const c = await caps();
    if (!c.supported) {
      console.warn('[mounts] 自动挂载跳过：' + (c.missing.join(', ') || c.reasons.join(', ')));
      return;
    }
    const conns = await loadConns();
    for (const conn of conns) {
      if (!conn.autoMount) continue;
      try {
        const r = await doMount(conn);
        console.log(`[mounts] ${r.ok ? 'mounted' : 'FAILED'} ${conn.name} (${conn.id})${r.error ? ': ' + r.error : ''}`);
      } catch (e) {
        console.warn(`[mounts] auto mount ${conn.id} 异常:`, (e && e.message) || e);
      }
    }
  } catch (e) {
    console.warn('[mounts] 初始化失败（不影响其他接口）:', (e && e.message) || e);
  }
}

/* ---------- 路由 ---------- */

async function mountsRoute(req, res, p, url) {
  const method = req.method || 'GET';
  try {
    /* GET /api/mounts/caps：能力矩阵（信息性，任何状态都 200） */
    if (p === '/api/mounts/caps' && method === 'GET') {
      return send(res, 200, await caps());
    }

    /* GET /api/mounts：列连接 + 状态 */
    if (p === '/api/mounts' && method === 'GET') {
      return send(res, 200, await listPayload());
    }

    /* POST /api/mounts：新建连接 */
    if (p === '/api/mounts' && method === 'POST') {
      let body;
      try {
        body = await readJsonBody(req);
      } catch {
        return send(res, 400, { error: 'Invalid request body' });
      }
      const conns = await loadConns();
      if (conns.length >= MAX_CONNECTIONS) return send(res, 409, { error: 'Too many connections' });
      let conn;
      try {
        conn = validateConn(body, null);
      } catch (e) {
        return send(res, 400, { error: e.message });
      }
      const pwd = conn._password;
      delete conn._password;
      await writeCred(conn.id, pwd);
      const saved = [...conns, conn];
      await saveConns(saved);
      return send(res, 200, { ok: true, connection: publicConn(conn) });
    }

    /* PUT /api/mounts/:id：更新连接（password 留空 = 保留原密码） */
    const putMatch = p.match(/^\/api\/mounts\/([A-Za-z0-9_-]+)$/);
    if (putMatch && (method === 'PUT' || method === 'PATCH')) {
      const id = putMatch[1];
      const conns = await loadConns();
      const idx = conns.findIndex((c) => c.id === id);
      if (idx < 0) return send(res, 404, { error: 'Connection not found' });
      let body;
      try {
        body = await readJsonBody(req);
      } catch {
        return send(res, 400, { error: 'Invalid request body' });
      }
      let conn;
      try {
        conn = validateConn(body, conns[idx]);
      } catch (e) {
        return send(res, 400, { error: e.message });
      }
      conn.id = id; // 锚定，杜绝改 id
      const pwd = conn._password;
      delete conn._password;
      if (pwd) await writeCred(id, pwd);
      const saved = conns.slice();
      saved[idx] = conn;
      await saveConns(saved);
      return send(res, 200, { ok: true, connection: publicConn(conn) });
    }

    /* DELETE /api/mounts/:id：删除连接（先卸载，再删配置与凭据） */
    const delMatch = p.match(/^\/api\/mounts\/([A-Za-z0-9_-]+)$/);
    if (delMatch && method === 'DELETE') {
      const id = delMatch[1];
      const conns = await loadConns();
      const conn = conns.find((c) => c.id === id);
      if (!conn) return send(res, 404, { error: 'Connection not found' });
      const mounted = await mountedSet();
      if (mounted.has(path.join(MOUNTS_DIR, id))) {
        const r = await doUnmount(conn);
        if (!r.ok) return send(res, 409, { error: 'Unmount before delete failed: ' + r.error });
      }
      await saveConns(conns.filter((c) => c.id !== id));
      await deleteCred(id);
      return send(res, 200, { ok: true });
    }

    /* POST /api/mounts/:id/mount：挂载 */
    const mountMatch = p.match(/^\/api\/mounts\/([A-Za-z0-9_-]+)\/mount$/);
    if (mountMatch && method === 'POST') {
      const c = await caps();
      if (!c.supported) return send(res, 503, { error: 'Mount not available', caps: c });
      const conn = (await loadConns()).find((x) => x.id === mountMatch[1]);
      if (!conn) return send(res, 404, { error: 'Connection not found' });
      const r = await doMount(conn);
      if (!r.ok) return send(res, 502, { error: r.error });
      return send(res, 200, { ok: true, mountPoint: path.join(MOUNTS_DIR, conn.id) });
    }

    /* POST /api/mounts/:id/unmount：卸载 */
    const unmountMatch = p.match(/^\/api\/mounts\/([A-Za-z0-9_-]+)\/unmount$/);
    if (unmountMatch && method === 'POST') {
      const conn = (await loadConns()).find((x) => x.id === unmountMatch[1]);
      if (!conn) return send(res, 404, { error: 'Connection not found' });
      const r = await doUnmount(conn);
      if (!r.ok) return send(res, 502, { error: r.error });
      return send(res, 200, { ok: true });
    }

    return send(res, 404, { error: 'not found' });
  } catch (e) {
    return fail(res, e);
  }
}

module.exports = {
  mountsRoute,
  caps,
  listPayload,
  startMounts,
  mountedSet,
  MOUNTS_DIR,
  CRED_DIR,
  HELPER,
  _test: { validateConn, publicConn, newId, ID_RE },
};
