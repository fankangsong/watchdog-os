/**
 * 文件管理模块（FinderApp / EditorApp 数据源，零依赖 fs API）：
 * 目录浏览 / 文本读写 / 原始流下载 / 流式上传 / mkdir / delete / rename / 收藏夹。
 * 从 server.js 原样搬移（原 1218-1606 行），函数体不变；
 * data/ 目录路径按模块新位置（server/api/）上跳两级定位到项目根。
 */
'use strict';

const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const { readBody, send } = require('../lib/http');

/* 允许浏览的根目录：默认 Windows 列出项目所在盘符与 C 盘，POSIX 为根目录；
   可用环境变量 FS_ROOTS 覆盖（按 path.delimiter 分隔，如 "C:\;D:\" 或 "/data:/home"）。 */
const FS_ROOTS = (() => {
  const raw = process.env.FS_ROOTS;
  const list = (raw
    ? raw.split(path.delimiter)
    : process.platform === 'win32'
      ? [process.cwd().slice(0, 3), 'C:\\']
      : ['/']
  )
    .map((s) => s.trim())
    .filter(Boolean)
    .map((r) => path.resolve(r));
  const out = [];
  const seen = new Set();
  for (const r of list) {
    const key = process.platform === 'win32' ? r.toLowerCase() : r;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(r);
    }
  }
  return out;
})();

const FS_MAX_TEXT = 2 * 1024 * 1024;    // 文本读取/保存上限 2MB
const FS_MAX_UPLOAD = 50 * 1024 * 1024; // 上传单文件上限 50MB
const FS_FAV_MAX = 100;                 // 收藏夹条目上限
const FS_DATA_DIR = path.join(__dirname, '..', '..', 'data');
const FS_FAV_FILE = path.join(FS_DATA_DIR, 'favorites.json');

/* 图片扩展名：raw 接口唯一允许内联输出的类型（其余一律 attachment 下载，防止内联 HTML/XSS） */
const FS_IMAGE_EXT = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.avif', '.svg'];
/* 视为文本的扩展名（决定前端“可预览/可编辑”提示；read 接口对任何文件都会再做二进制嗅探兜底） */
const FS_TEXT_EXT = new Set([
  '.txt', '.log', '.md', '.markdown', '.json', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf',
  '.xml', '.html', '.htm', '.css', '.scss', '.less', '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx',
  '.py', '.rb', '.go', '.rs', '.java', '.kt', '.c', '.h', '.cpp', '.hpp', '.cs', '.php', '.sh',
  '.bash', '.zsh', '.fish', '.ps1', '.psm1', '.sql', '.properties', '.gradle', '.cmake',
  '.vue', '.svelte', '.astro', '.graphql', '.proto', '.patch', '.diff', '.csv', '.service',
]);
const FS_RAW_MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.bmp': 'image/bmp', '.ico': 'image/x-icon',
  '.avif': 'image/avif',
};

/** 解析用户传入路径为绝对路径（统一 resolve 规范化防穿越），非法返回 null */
function fsResolve(raw) {
  if (raw == null) return null;
  let p;
  try {
    p = decodeURIComponent(String(raw));
  } catch {
    return null;
  }
  p = p.trim().replace(/\u0000/g, '');
  if (!p) return null;
  return path.resolve(p);
}

/** 校验绝对路径位于允许的根之内（Windows 根比较不区分大小写） */
function fsAllowed(abs) {
  const norm = process.platform === 'win32' ? abs.toLowerCase() : abs;
  return FS_ROOTS.some((root) => {
    const r = process.platform === 'win32' ? root.toLowerCase() : root;
    if (r === '/' || r === path.sep) return norm.startsWith('/');
    const rr = r.endsWith(path.sep) ? r : r + path.sep;
    return norm === r || norm.startsWith(rr);
  });
}

/** 判断路径是否为允许根目录本身（根目录不可删除/重命名） */
function fsIsRoot(abs) {
  const norm = process.platform === 'win32' ? abs.toLowerCase() : abs;
  return FS_ROOTS.some((root) => (process.platform === 'win32' ? root.toLowerCase() : root) === norm);
}

/** Unix 风格权限串，如 rwxr-xr-x */
function fsModeString(mode) {
  const s = 'rwxrwxrwx';
  let out = '';
  for (let i = 0; i < 9; i++) out += (mode >> (8 - i)) & 1 ? s[i] : '-';
  return out;
}

/** 前端预览能力标记：image 内联图 / markdown 渲染 / text 编辑器 / none 仅下载 */
function fsPreviewKind(name, isDir) {
  if (isDir) return 'none';
  const base = path.basename(name);
  const ext = path.extname(base).toLowerCase();
  if (FS_IMAGE_EXT.includes(ext)) return 'image';
  if (ext === '.md' || ext === '.markdown') return 'markdown';
  if (FS_TEXT_EXT.has(ext)) return 'text';
  // 无扩展名（Makefile/LICENSE）与点文件（.env/.gitignore）多为文本，read 接口有二进制嗅探兜底
  if (!ext || base.startsWith('.')) return 'text';
  return 'none';
}

function fsEntryFromStat(baseDir, name, st) {
  const isDir = st.isDirectory();
  return {
    name,
    path: path.join(baseDir, name),
    type: isDir ? 'dir' : 'file',
    size: isDir ? 0 : st.size,
    mtime: Math.floor(st.mtimeMs),
    mode: fsModeString(st.mode),
    previewable: fsPreviewKind(name, isDir),
  };
}

/** 目录在前、名称自然排序（数字感知，config10 排在 config2 之后） */
function fsSortEntries(list) {
  list.sort((a, b) =>
    a.type !== b.type
      ? a.type === 'dir' ? -1 : 1
      : a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
  );
}

/** 清洗文件/目录名：仅取 basename，剔除分隔符与控制字符；非法返回 null */
function fsSafeName(raw) {
  const base = path
    .basename(String(raw == null ? '' : raw))
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '')
    .trim();
  if (!base || base === '.' || base === '..') return null;
  return base;
}

/** 读取小体积 JSON body；解析失败返回 null */
async function fsJson(req) {
  try {
    return JSON.parse((await readBody(req, 64 * 1024)) || '{}');
  } catch {
    return null;
  }
}

/** 流式接收请求 body 写入目标文件（限 maxBytes），返回写入字节数；中途失败清理半截文件 */
function fsReceiveFile(req, destAbs, maxBytes) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let settled = false;
    const out = fs.createWriteStream(destAbs, { flags: 'w' });
    const fail = (err) => {
      if (settled) return;
      settled = true;
      out.destroy();
      fsp.unlink(destAbs).catch(() => {});
      req.resume();
      reject(err);
    };
    req.on('data', (c) => {
      if (settled) return;
      size += c.length;
      if (size > maxBytes) return fail(new Error('上传超过大小限制'));
      if (!out.write(c)) {
        req.pause();
        out.once('drain', () => req.resume());
      }
    });
    req.on('end', () => {
      out.end(() => {
        if (settled) return;
        settled = true;
        resolve(size);
      });
    });
    req.on('error', fail);
    out.on('error', fail);
  });
}

/** 读取文本文件：超限（tooLarge）或二进制（含 NUL 字节，binary）时返回标记而不返回内容 */
async function fsReadText(abs) {
  const st = await fsp.stat(abs);
  if (!st.isFile()) throw Object.assign(new Error('不是常规文件'), { code: 'EISDIR' });
  const meta = { size: st.size, mtime: Math.floor(st.mtimeMs) };
  if (st.size > FS_MAX_TEXT) return { ...meta, tooLarge: true };
  const buf = await fsp.readFile(abs);
  if (buf.subarray(0, 8192).includes(0)) return { ...meta, binary: true };
  return { ...meta, content: buf.toString('utf8') };
}

/* 收藏夹：持久化到 data/favorites.json（惰性加载 + 临时文件原子替换写） */
let fsFavorites = null;
async function fsLoadFavorites() {
  if (fsFavorites) return fsFavorites;
  try {
    const j = JSON.parse(await fsp.readFile(FS_FAV_FILE, 'utf8'));
    fsFavorites = Array.isArray(j.favorites) ? j.favorites.filter((x) => typeof x === 'string') : [];
  } catch {
    fsFavorites = [];
  }
  return fsFavorites;
}

async function fsSaveFavorites(list) {
  await fsp.mkdir(FS_DATA_DIR, { recursive: true });
  const tmp = `${FS_FAV_FILE}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify({ favorites: list }, null, 2) + '\n', 'utf8');
  await fsp.rename(tmp, FS_FAV_FILE);
  fsFavorites = list;
}

/** 文件管理 API 分发（进入前已完成 checkAuth，路径均已剥离 BASE 前缀） */
async function fsRoute(req, res, p, url) {
  try {
    const q = url.searchParams;
    const method = req.method || 'GET';

    /* GET /api/fs/list：列目录；不传 path 时返回允许的根列表（供目录树初始化） */
    if (p === '/api/fs/list' && method === 'GET') {
      const raw = q.get('path');
      if (!raw || !raw.trim()) {
        const entries = FS_ROOTS.map((r) => ({
          name: process.platform === 'win32' ? r : '根目录',
          path: r,
          type: 'dir',
          size: 0,
          mtime: 0,
          mode: '',
          previewable: 'none',
        }));
        return send(res, 200, { path: '', roots: FS_ROOTS, entries });
      }
      const abs = fsResolve(raw);
      if (!abs || !fsAllowed(abs)) return send(res, 403, { error: '路径不在允许范围内' });
      const st = await fsp.stat(abs).catch(() => null);
      if (!st) return send(res, 404, { error: '目录不存在' });
      if (!st.isDirectory()) return send(res, 400, { error: '不是目录' });
      const items = await fsp.readdir(abs, { withFileTypes: true }).catch(() => null);
      if (!items) return send(res, 403, { error: '目录不可读（权限不足）' });
      const entries = [];
      for (const it of items) {
        // stat 失败（悬空软链 / 无权限）的条目直接跳过
        const st2 = await fsp.stat(path.join(abs, it.name)).catch(() => null);
        if (st2) entries.push(fsEntryFromStat(abs, it.name, st2));
      }
      fsSortEntries(entries);
      return send(res, 200, { path: abs, roots: FS_ROOTS, entries });
    }

    /* GET /api/fs/read：读文本（2MB 上限 + NUL 二进制嗅探） */
    if (p === '/api/fs/read' && method === 'GET') {
      const abs = fsResolve(q.get('path'));
      if (!abs || !fsAllowed(abs)) return send(res, 403, { error: '路径不在允许范围内' });
      const st = await fsp.stat(abs).catch(() => null);
      if (!st) return send(res, 404, { error: '文件不存在' });
      if (!st.isFile()) return send(res, 400, { error: '不是常规文件' });
      const info = await fsReadText(abs);
      return send(res, 200, { path: abs, name: path.basename(abs), ...info });
    }

    /* GET /api/fs/raw：原始文件流。仅图片允许内联（<img> 预览），其余一律 attachment 下载。
       注意：不设 Content-Length —— ReFS/Dev Drive 上刚写入文件的 stat.size 可能是
       预分配值（元数据延迟），按实际流读取到 EOF 输出（chunked）才不会截断或虚报。 */
    if (p === '/api/fs/raw' && method === 'GET') {
      const abs = fsResolve(q.get('path'));
      if (!abs || !fsAllowed(abs)) return send(res, 403, { error: '路径不在允许范围内' });
      const st = await fsp.stat(abs).catch(() => null);
      if (!st || !st.isFile()) return send(res, 404, { error: '文件不存在' });
      const ext = path.extname(abs).toLowerCase();
      const inline = FS_IMAGE_EXT.includes(ext) && q.get('download') !== '1';
      res.writeHead(200, {
        'Content-Type': inline ? FS_RAW_MIME[ext] || 'application/octet-stream' : 'application/octet-stream',
        'Cache-Control': 'no-store',
        'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(path.basename(abs))}`,
      });
      const stream = fs.createReadStream(abs);
      stream.on('error', () => res.destroy());
      stream.pipe(res);
      return;
    }

    /* PUT /api/fs/write：保存文本内容（body 为 UTF-8 原文）。
       ?create=1 为「新建文件」语义：目标已存在时返回 409，避免误覆盖已有内容。 */
    if (p === '/api/fs/write' && method === 'PUT') {
      const abs = fsResolve(q.get('path'));
      if (!abs || !fsAllowed(abs)) return send(res, 403, { error: '路径不在允许范围内' });
      if (q.get('create') === '1') {
        const exists = await fsp.stat(abs).catch(() => null);
        if (exists) return send(res, 409, { error: '同名文件已存在' });
      }
      let body;
      try {
        body = await readBody(req, FS_MAX_TEXT + 1);
      } catch {
        return send(res, 413, { error: '内容超过大小限制' });
      }
      if (Buffer.byteLength(body, 'utf8') > FS_MAX_TEXT) return send(res, 413, { error: '内容超过大小限制' });
      await fsp.writeFile(abs, body, 'utf8');
      const st = await fsp.stat(abs);
      return send(res, 200, { ok: true, path: abs, size: st.size, mtime: Math.floor(st.mtimeMs) });
    }

    /* POST /api/fs/upload：raw body 流式上传到 path 目录下（?name= 文件名，?overwrite=1 覆盖） */
    if (p === '/api/fs/upload' && method === 'POST') {
      const abs = fsResolve(q.get('path'));
      if (!abs || !fsAllowed(abs)) return send(res, 403, { error: '路径不在允许范围内' });
      const name = fsSafeName(q.get('name') || '');
      if (!name) return send(res, 400, { error: '文件名非法' });
      const dest = path.join(abs, name);
      const st = await fsp.stat(dest).catch(() => null);
      if (st && q.get('overwrite') !== '1') return send(res, 409, { error: '同名文件已存在' });
      if (st && !st.isFile()) return send(res, 400, { error: '同名路径不是文件' });
      const size = await fsReceiveFile(req, dest, FS_MAX_UPLOAD).catch((e) => {
        send(res, 400, { error: (e && e.message) || '上传失败' });
        return null;
      });
      if (size == null) return;
      return send(res, 200, { ok: true, path: dest, name, size });
    }

    /* POST /api/fs/mkdir：递归创建目录 */
    if (p === '/api/fs/mkdir' && method === 'POST') {
      const body = await fsJson(req);
      if (!body) return send(res, 400, { error: 'Invalid request body' });
      const abs = fsResolve(body.path);
      if (!abs || !fsAllowed(abs)) return send(res, 403, { error: '路径不在允许范围内' });
      await fsp.mkdir(abs, { recursive: true });
      return send(res, 200, { ok: true, path: abs });
    }

    /* POST /api/fs/delete：删除文件/目录（递归；根目录禁止删除） */
    if (p === '/api/fs/delete' && method === 'POST') {
      const body = await fsJson(req);
      if (!body) return send(res, 400, { error: 'Invalid request body' });
      const abs = fsResolve(body.path);
      if (!abs || !fsAllowed(abs)) return send(res, 403, { error: '路径不在允许范围内' });
      if (fsIsRoot(abs)) return send(res, 403, { error: '不能删除根目录' });
      await fsp.rm(abs, { recursive: true, force: false });
      return send(res, 200, { ok: true });
    }

    /* POST /api/fs/rename：重命名（仅目录内改名，不做移动） */
    if (p === '/api/fs/rename' && method === 'POST') {
      const body = await fsJson(req);
      if (!body) return send(res, 400, { error: 'Invalid request body' });
      const abs = fsResolve(body.path);
      if (!abs || !fsAllowed(abs)) return send(res, 403, { error: '路径不在允许范围内' });
      if (fsIsRoot(abs)) return send(res, 403, { error: '不能重命名根目录' });
      const name = fsSafeName(body.name);
      if (!name) return send(res, 400, { error: '文件名非法' });
      const dest = path.join(path.dirname(abs), name);
      const exists = await fsp.stat(dest).catch(() => null);
      if (exists) return send(res, 409, { error: '目标名称已存在' });
      await fsp.rename(abs, dest);
      return send(res, 200, { ok: true, path: dest });
    }

    /* GET/PUT /api/fs/favorites：收藏目录列表（服务端持久化，跨浏览器生效） */
    if (p === '/api/fs/favorites' && method === 'GET') {
      return send(res, 200, { favorites: await fsLoadFavorites() });
    }
    if (p === '/api/fs/favorites' && method === 'PUT') {
      const body = await fsJson(req);
      if (!body) return send(res, 400, { error: 'Invalid request body' });
      const list = Array.isArray(body.favorites) ? body.favorites : [];
      const out = [];
      const seen = new Set();
      for (const item of list.slice(0, FS_FAV_MAX)) {
        const abs = fsResolve(item);
        if (!abs || !fsAllowed(abs)) continue;
        const key = process.platform === 'win32' ? abs.toLowerCase() : abs;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(abs);
      }
      await fsSaveFavorites(out);
      return send(res, 200, { ok: true, favorites: out });
    }

    return send(res, 404, { error: 'not found' });
  } catch (e) {
    const code = (e && e.code) || '';
    if (code === 'ENOENT') return send(res, 404, { error: '文件或目录不存在' });
    if (code === 'EACCES' || code === 'EPERM') return send(res, 403, { error: '权限不足' });
    if (code === 'EISDIR') return send(res, 400, { error: '是目录而非文件' });
    if (code === 'ENOTDIR') return send(res, 400, { error: '不是目录' });
    if (code === 'EEXIST') return send(res, 409, { error: '已存在同名文件或目录' });
    if (code === 'ENOSPC') return send(res, 507, { error: '磁盘空间不足' });
    if (code === 'EBUSY' || code === 'EBUSY resource busy or locked') return send(res, 409, { error: '文件被占用' });
    return send(res, 500, { error: (e && e.message) || String(e) });
  }
}

module.exports = { fsRoute, FS_ROOTS };
