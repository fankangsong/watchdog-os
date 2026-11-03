/**
 * 编辑器草稿存储（~/.watchdog-os/drafts，零依赖）。
 *
 * 为什么独立于 data.json（lib/userdata）：
 *  草稿正文最大 2MB，而 saveUserData 每次整体重读 + 重写 + 全量常驻内存；
 *  打字期每 2s 一次的自动缓存会把偏好文件反复刷盘，且没有按条淘汰 / 过期的能力。
 *
 * 每个草稿是一个自描述文件（元数据头 + 正文原文），不维护独立索引：
 *  索引与正文双文件在崩溃时会分裂成「有条目没内容 / 有内容没条目」两类孤儿，
 *  单文件配合「临时文件 + rename」原子替换，读端永远只看到完整旧版或完整新版，
 *  崩溃最多残留 .tmp（启动时清空）。
 *
 * 文件格式（第二行 JSON 之后就是正文，一个字节都不改）：
 *  WDDRAFT/1\n
 *  {"path":"D:\\a.ts","name":"a.ts","baseMtime":1730000000000,"updatedAt":...,"size":18342}\n
 *  <正文 UTF-8 原文，长度 = size>
 */
'use strict';

const crypto = require('crypto');
const fsp = require('fs').promises;
const os = require('os');
const path = require('path');

const { cfg } = require('../config');

/* 头部魔数带版本号：格式若变更可据此识别旧文件并做迁移 / 丢弃 */
const MAGIC = 'WDDRAFT/1';
const HDR_MAX = 16 * 1024; // 列表只读这么多：足够容纳 4096 字节路径的 JSON 转义
const MAX_TEXT = 2 * 1024 * 1024; // 与 fs.js 的 FS_MAX_TEXT 对齐（>2MB 的文件本来也打不开）
const MAX_PATH_BYTES = 4096;
const ID_RE = /^[0-9a-f]{40}$/;
const PRUNE_THROTTLE_MS = 10 * 60 * 1000;

/* 写 / 删串行化：前端「保存成功后删草稿」与「await 期间的又一轮自动缓存」会并发到达，
   全局串行保证同一路径按到达顺序落地（单进程单用户，编辑器只有一个文档，per-key 链不值得）。
   读不进链：列表要快，且 rename 原子性已保证读到的必是完整版本。 */
let chain = Promise.resolve();
function enqueue(fn) {
  const run = chain.then(fn);
  chain = run.then(
    () => {},
    () => {}
  );
  return run;
}

let tmpSeq = 0;
let lastPruneAt = 0;
let dirCache = null;

/** 草稿目录：DRAFT_DIR（支持 ~ 前缀）→ 默认 ~/.watchdog-os/drafts */
function draftDir() {
  if (dirCache) return dirCache;
  const raw = String(cfg.drafts.dir || '').trim();
  if (!raw) dirCache = path.join(os.homedir(), '.watchdog-os', 'drafts');
  else if (raw === '~') dirCache = path.join(os.homedir(), 'drafts');
  else if (raw.startsWith('~/')) dirCache = path.join(os.homedir(), raw.slice(2));
  else dirCache = path.resolve(raw);
  return dirCache;
}

/**
 * 把请求里的 path 归一成草稿键。
 * 返回 null 表示非法（调用方按 400 处理）。Windows 大小写不敏感，故只对小写化结果做哈希；
 * 展示用的 path 保留调用方写法。路径**只作为哈希输入**，永远不会拼进磁盘文件名。
 *
 * 入参必须是**已解码**的路径（路由用 url.searchParams.get 取值，本身已完成百分号解码）——
 * 这里再 decodeURIComponent 一次会把文件名里的 `%` 吃掉（`100%.txt` 直接抛 URIError → 400）。
 */
function draftKey(raw) {
  if (raw == null) return null;
  const p = String(raw).replace(/\u0000/g, '').trim();
  if (!p) return null;
  let abs;
  try {
    abs = path.resolve(p);
  } catch {
    return null;
  }
  if (Buffer.byteLength(abs, 'utf8') > MAX_PATH_BYTES) return null;
  const key = process.platform === 'win32' ? abs.toLowerCase() : abs;
  return { path: abs, id: crypto.createHash('sha1').update(key, 'utf8').digest('hex') };
}

function draftFile(id) {
  return path.join(draftDir(), id + '.draft');
}

/** 解析头部；返回 { meta, bodyOffset } 或 null（损坏一律跳过，不让一个坏文件打挂列表） */
function parseHeader(buf) {
  const first = buf.indexOf(0x0a);
  if (first < 0) return null;
  if (buf.subarray(0, first).toString('utf8') !== MAGIC) return null;
  const second = buf.indexOf(0x0a, first + 1);
  if (second < 0) return null;
  let meta;
  try {
    meta = JSON.parse(buf.subarray(first + 1, second).toString('utf8'));
  } catch {
    return null;
  }
  if (!meta || typeof meta !== 'object' || typeof meta.path !== 'string') return null;
  return { meta, bodyOffset: second + 1 };
}

/** 源文件当前状态（只 stat，不读内容）；超时按不存在处理，避免挂死的网络盘拖垮列表 */
function diskState(p, timeoutMs = 800) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ exists: false, mtime: null }), timeoutMs);
    fsp
      .stat(p)
      .then((st) => resolve({ exists: st.isFile(), mtime: Math.floor(st.mtimeMs) }))
      .catch(() => resolve({ exists: false, mtime: null }))
      .finally(() => clearTimeout(timer));
  });
}

/**
 * 列出全部草稿（不含正文）：每个文件只短读头部。
 * 返回 [{ id, path, name, size, updatedAt, baseMtime, disk }]，按 updatedAt 倒序。
 */
async function listDrafts() {
  const dir = draftDir();
  let names;
  try {
    names = await fsp.readdir(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    if (!name.endsWith('.draft')) continue;
    const id = name.slice(0, -'.draft'.length);
    if (!ID_RE.test(id)) continue;
    let buf;
    try {
      const fh = await fsp.open(path.join(dir, name), 'r');
      try {
        buf = Buffer.alloc(HDR_MAX);
        const { bytesRead } = await fh.read(buf, 0, HDR_MAX, 0);
        buf = buf.subarray(0, bytesRead);
      } finally {
        await fh.close();
      }
    } catch {
      continue;
    }
    const parsed = parseHeader(buf);
    if (!parsed) continue;
    const m = parsed.meta;
    out.push({
      id,
      path: m.path,
      name: typeof m.name === 'string' && m.name ? m.name : path.basename(m.path),
      size: Number.isFinite(m.size) ? m.size : 0,
      updatedAt: Number.isFinite(m.updatedAt) ? m.updatedAt : 0,
      baseMtime: Number.isFinite(m.baseMtime) ? m.baseMtime : null,
    });
  }
  out.sort((a, b) => b.updatedAt - a.updatedAt);
  const withDisk = await Promise.all(
    out.map(async (d) => ({ ...d, disk: await diskState(d.path) }))
  );
  return withDisk;
}

/** 读取单条草稿全文；不存在 / 损坏返回 null */
async function readDraft(id) {
  if (!ID_RE.test(String(id || ''))) return null;
  let buf;
  try {
    buf = await fsp.readFile(draftFile(id));
  } catch {
    return null;
  }
  const parsed = parseHeader(buf);
  if (!parsed) return null;
  const m = parsed.meta;
  return {
    id,
    path: m.path,
    name: typeof m.name === 'string' && m.name ? m.name : path.basename(m.path),
    size: Number.isFinite(m.size) ? m.size : buf.length - parsed.bodyOffset,
    updatedAt: Number.isFinite(m.updatedAt) ? m.updatedAt : 0,
    baseMtime: Number.isFinite(m.baseMtime) ? m.baseMtime : null,
    content: buf.subarray(parsed.bodyOffset).toString('utf8'),
  };
}

/** 原子写：同目录临时文件 + rename（POSIX / Windows 同卷均无中间态） */
async function writeAtomic(target, buf) {
  tmpSeq += 1;
  const tmp = `${target}.${process.pid}.${tmpSeq}.tmp`;
  await fsp.writeFile(tmp, buf);
  await fsp.rename(tmp, target);
}

/**
 * 写入草稿。content 必须是字符串；超限由调用方（api 层）先判 413。
 * 返回 { id, path, name, size, updatedAt, baseMtime }。
 */
function writeDraft({ path: rawPath, content, baseMtime }) {
  const key = draftKey(rawPath);
  if (!key) return Promise.reject(Object.assign(new Error('Invalid path'), { code: 'EBADPATH' }));
  const text = String(content ?? '');
  return enqueue(async () => {
    const dir = draftDir();
    await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
    const meta = {
      path: key.path,
      name: path.basename(key.path),
      baseMtime: Number.isFinite(baseMtime) ? baseMtime : null,
      updatedAt: Date.now(),
      size: Buffer.byteLength(text, 'utf8'),
    };
    const buf = Buffer.concat([
      Buffer.from(MAGIC + '\n' + JSON.stringify(meta) + '\n', 'utf8'),
      Buffer.from(text, 'utf8'),
    ]);
    await writeAtomic(draftFile(key.id), buf);
    /* 写后节流清理：打字期每 2s 一次写，不能每次都扫全目录 */
    await prune(false).catch(() => {});
    return { id: key.id, ...meta };
  });
}

/** 按路径删除（幂等）：返回是否真的删掉了文件 */
function deleteDraftByPath(rawPath) {
  const key = draftKey(rawPath);
  if (!key) return Promise.reject(Object.assign(new Error('Invalid path'), { code: 'EBADPATH' }));
  return enqueue(async () => {
    try {
      await fsp.unlink(draftFile(key.id));
      return true;
    } catch (e) {
      if (e && e.code === 'ENOENT') return false;
      throw e;
    }
  });
}

/** 按 id 删除（幂等）：id 非法或文件不存在都返回 false */
function deleteDraftById(id) {
  if (!ID_RE.test(String(id || ''))) return Promise.resolve(false);
  return enqueue(async () => {
    try {
      await fsp.unlink(draftFile(id));
      return true;
    } catch (e) {
      if (e && e.code === 'ENOENT') return false;
      throw e;
    }
  });
}

/** 清空全部草稿（「全部丢弃」） */
function deleteAllDrafts() {
  return enqueue(async () => {
    const dir = draftDir();
    let names;
    try {
      names = await fsp.readdir(dir);
    } catch {
      return 0;
    }
    let n = 0;
    for (const name of names) {
      if (!name.endsWith('.draft')) continue;
      try {
        await fsp.unlink(path.join(dir, name));
        n += 1;
      } catch {
        /* 单个文件删不掉不影响其它 */
      }
    }
    return n;
  });
}

/**
 * 清理：残留 .tmp + 过期（按头部 updatedAt，读不到头部退化为文件 mtime）+ 超条数（最旧先删）。
 * force=false 时按 PRUNE_THROTTLE_MS 节流。
 */
async function prune(force) {
  const now = Date.now();
  if (!force && now - lastPruneAt < PRUNE_THROTTLE_MS) return;
  lastPruneAt = now;
  const dir = draftDir();
  const retentionMs = cfg.drafts.retentionDays * 24 * 60 * 60 * 1000;
  const maxEntries = cfg.drafts.maxEntries;

  let names;
  try {
    names = await fsp.readdir(dir);
  } catch {
    return;
  }

  const live = [];
  for (const name of names) {
    const full = path.join(dir, name);
    if (name.endsWith('.tmp')) {
      await fsp.unlink(full).catch(() => {});
      continue;
    }
    if (!name.endsWith('.draft')) continue;
    let updatedAt = 0;
    try {
      const fh = await fsp.open(full, 'r');
      try {
        const buf = Buffer.alloc(HDR_MAX);
        const { bytesRead } = await fh.read(buf, 0, HDR_MAX, 0);
        const parsed = parseHeader(buf.subarray(0, bytesRead));
        updatedAt = parsed && Number.isFinite(parsed.meta.updatedAt) ? parsed.meta.updatedAt : 0;
      } finally {
        await fh.close();
      }
      if (!updatedAt) updatedAt = Math.floor((await fsp.stat(full)).mtimeMs);
    } catch {
      continue;
    }
    if (retentionMs > 0 && now - updatedAt > retentionMs) {
      await fsp.unlink(full).catch(() => {});
      continue;
    }
    live.push({ full, updatedAt });
  }

  if (live.length > maxEntries) {
    live.sort((a, b) => a.updatedAt - b.updatedAt);
    for (const item of live.slice(0, live.length - maxEntries)) {
      await fsp.unlink(item.full).catch(() => {});
    }
  }
}

/** 启动初始化：建目录 + 强制清理（此时不可能有在途写，残留 .tmp 一定是崩溃留下的） */
async function startDrafts() {
  const dir = draftDir();
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  lastPruneAt = 0;
  await prune(true);
}

module.exports = {
  MAGIC,
  MAX_TEXT,
  draftDir,
  draftKey,
  diskState,
  listDrafts,
  readDraft,
  writeDraft,
  deleteDraftByPath,
  deleteDraftById,
  deleteAllDrafts,
  startDrafts,
};
