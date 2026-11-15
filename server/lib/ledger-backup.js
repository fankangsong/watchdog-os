/**
 * 财务账本 SQLite 备份 / 恢复。
 *
 * 关键安全点：
 *  - 一致性快照走 SQLite Online Backup API（node:sqlite backup()），兜底 VACUUM INTO，
 *    绝不用 fs.copyFileSync 拷主库（WAL 模式下会漏掉 -wal 中的未 checkpoint 数据）。
 *  - 恢复是唯一会整体替换主库的操作：前端二次确认 + 恢复前必生成 pre-restore 安全快照
 *    + 来源文件完整性/表结构校验 + 替换失败自动回滚，四重保护。
 *  - 所有备份文件名白名单 + path.resolve 前缀校验，杜绝 ../ 穿越。
 *  - 上传的 .db 是二进制，必须走 readBinaryBody（lib/http.js 的 readBody 返回 utf8 会损坏）。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { cfg, LEDGER_BACKUP_DIR, LEDGER_DB_PATH } = require('../config');
const ldb = require('./ledger-db');

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.db$/;
const KINDS = ['manual', 'auto-before-import', 'auto-before-restore'];
const REQUIRED_TABLES = [
  'transactions', 'accounts', 'categories',
  'txn_classification', 'internal_transfer_pairs', 'import_batches',
];
const REQUIRED_COLUMNS = ['row_hash', 'amount_signed_cent', 'txn_date', 'direction', 'source_file'];

function ensureDir() {
  fs.mkdirSync(LEDGER_BACKUP_DIR, { recursive: true });
  return LEDGER_BACKUP_DIR;
}

function bad(message, status = 400) {
  const e = new Error(message);
  e.status = status;
  return e;
}

function safeName(name) {
  const s = String(name || '');
  if (!NAME_RE.test(s) || s.includes('..')) throw bad('非法备份文件名');
  const abs = path.resolve(LEDGER_BACKUP_DIR, s);
  if (path.dirname(abs) !== path.resolve(LEDGER_BACKUP_DIR)) throw bad('备份路径越界');
  return s;
}

function absPath(name) {
  return path.join(ensureDir(), safeName(name));
}

function stamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function kindOf(name) {
  for (const k of KINDS) if (name.includes(`-${k}.db`)) return k;
  return 'manual';
}

function isSafety(name) {
  return kindOf(name) === 'auto-before-restore';
}

function fmtTime(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** 校验一个 .db 文件确实是可用的账本库；失败抛错（调用方负责删除半截文件）。 */
function validateDbFile(p) {
  if (!fs.existsSync(p)) throw bad('文件不存在');
  const stat = fs.statSync(p);
  if (!stat.isFile() || stat.size < 100) throw bad('不是有效的 SQLite 文件');
  const fd = fs.openSync(p, 'r');
  const head = Buffer.alloc(16);
  try {
    fs.readSync(fd, head, 0, 16, 0);
  } finally {
    fs.closeSync(fd);
  }
  if (head.toString('latin1', 0, 15) !== 'SQLite format 3') {
    throw bad('不是 SQLite 数据库（文件头不匹配）');
  }
  const probe = ldb.probeSqlite();
  if (!probe.available) throw bad(`node:sqlite unavailable: ${probe.reason}`, 503);
  const sqlite = ldb.getSqliteModule();
  const conn = new sqlite.DatabaseSync(p, { readOnly: true });
  try {
    const ic = conn.prepare('PRAGMA integrity_check').get();
    if (!ic || ic.integrity_check !== 'ok') throw bad('PRAGMA integrity_check 未通过');
    const tables = new Set(
      conn.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name)
    );
    for (const t of REQUIRED_TABLES) if (!tables.has(t)) throw bad(`缺少必需表: ${t}`);
    const cols = new Set(conn.prepare('PRAGMA table_info(transactions)').all().map((r) => r.name));
    for (const c of REQUIRED_COLUMNS) if (!cols.has(c)) throw bad(`transactions 缺少列: ${c}`);
    const n = Number(conn.prepare('SELECT COUNT(*) AS n FROM transactions').get().n);
    if (n <= 0) throw bad('transactions 为空，拒绝恢复');
    return n;
  } finally {
    conn.close();
  }
}

/** 读取备份元数据（笔数 / 日期范围 / sha256），只读打开。 */
function snapshotStats(p) {
  const stat = fs.statSync(p);
  const name = path.basename(p);
  const out = {
    name,
    kind: kindOf(name),
    createdAt: fmtTime(stat.mtimeMs),
    sizeBytes: stat.size,
    txnCount: null,
    dateMin: null,
    dateMax: null,
    lockedCount: null,
    transferPairs: null,
    sha256: null,
    isPreRestoreSafety: isSafety(name),
  };
  try {
    const sqlite = ldb.getSqliteModule();
    const conn = new sqlite.DatabaseSync(p, { readOnly: true });
    try {
      const r = conn
        .prepare('SELECT COUNT(*) AS n, MIN(txn_date) AS dmin, MAX(txn_date) AS dmax FROM transactions')
        .get();
      out.txnCount = Number(r.n);
      out.dateMin = r.dmin;
      out.dateMax = r.dmax;
      try {
        out.lockedCount = Number(
          conn.prepare('SELECT COUNT(*) AS n FROM txn_classification WHERE locked=1').get().n
        );
      } catch { /* 旧版本库无该表字段时忽略 */ }
      try {
        out.transferPairs = Number(
          conn.prepare('SELECT COUNT(*) AS n FROM internal_transfer_pairs').get().n
        );
      } catch { /* 同上 */ }
    } finally {
      conn.close();
    }
    out.sha256 = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
  } catch {
    /* 打不开的备份仍列出，但元数据留空，由 UI 提示不可用 */
  }
  return out;
}

/** 生成一致性快照到指定绝对路径。backup() 不可用时降级 VACUUM INTO。 */
async function writeSnapshot(dest) {
  const probe = ldb.probeSqlite();
  const db = ldb.getDb();
  let done = false;
  if (probe.backup) {
    try {
      await ldb.getSqliteModule().backup(db, dest);
      done = fs.existsSync(dest) && fs.statSync(dest).size > 0;
    } catch (e) {
      console.warn(`[ledger] backup() 失败，降级 VACUUM INTO: ${e.message}`);
    }
  }
  if (!done) {
    try {
      if (fs.existsSync(dest)) fs.rmSync(dest, { force: true });
    } catch { /* VACUUM INTO 会因为目标已存在而失败，删除失败也要继续报错 */ }
    const escaped = dest.replace(/'/g, "''");
    db.exec(`VACUUM INTO '${escaped}'`);
  }
  try {
    validateDbFile(dest);
  } catch (e) {
    try {
      fs.rmSync(dest, { force: true });
    } catch { /* 清理失败不影响抛错 */ }
    throw new Error(`备份文件校验失败: ${e.message}`);
  }
}

/** 创建一份备份并落盘到备份目录，返回元数据。 */
async function createBackup(kind = 'manual') {
  const k = KINDS.includes(kind) ? kind : 'manual';
  const dir = ensureDir();
  let name = `ledger-${stamp()}-${k}.db`;
  let dest = path.join(dir, name);
  let seq = 1;
  while (fs.existsSync(dest)) {
    name = `ledger-${stamp()}-${k}-${seq}.db`;
    dest = path.join(dir, name);
    seq += 1;
  }
  await writeSnapshot(dest);
  const meta = snapshotStats(dest);
  pruneBackups(cfg.ledger.backupKeep);
  return meta;
}

/** 生成一份「当前库」的临时快照用于直接下载，不落服务端备份目录。 */
async function currentDbSnapshot() {
  const tmp = path.join(os.tmpdir(), `wd-ledger-current-${process.pid}-${Date.now()}.db`);
  try {
    await writeSnapshot(tmp);
    const buffer = fs.readFileSync(tmp);
    return {
      buffer,
      name: `ledger-${stamp()}-current.db`,
      stats: { sizeBytes: buffer.length },
    };
  } finally {
    try {
      fs.rmSync(tmp, { force: true });
    } catch { /* 临时文件清理失败不影响下载 */ }
  }
}

function listBackups(limit = 50) {
  const dir = ensureDir();
  const names = fs
    .readdirSync(dir)
    .filter((n) => {
      try {
        safeName(n);
        return fs.statSync(path.join(dir, n)).isFile();
      } catch {
        return false;
      }
    });
  const out = names.map((n) => snapshotStats(path.join(dir, n)));
  out.sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
  return out.slice(0, Math.max(1, Math.min(limit, 200)));
}

function readBackup(name) {
  const p = absPath(name);
  if (!fs.existsSync(p)) throw bad('备份不存在', 404);
  return { path: p, name: safeName(name), buffer: fs.readFileSync(p) };
}

function deleteBackup(name) {
  const n = safeName(name);
  if (isSafety(n)) throw bad('恢复前安全快照禁止删除（可用它撤销本次恢复）', 403);
  const p = path.join(ensureDir(), n);
  if (!fs.existsSync(p)) throw bad('备份不存在', 404);
  fs.rmSync(p, { force: true });
  return n;
}

/** 保留策略：安全快照永不淘汰，其余按数量与总大小淘汰最旧的。 */
function pruneBackups(keep) {
  const dir = ensureDir();
  const all = listBackups(200);
  const normal = all.filter((b) => !b.isPreRestoreSafety);
  let excess = normal.slice(Math.max(1, keep));
  const maxTotal = Math.max(cfg.ledger.maxBackupBytes * 4, 50 * 1024 * 1024);
  let total = all.reduce((s, b) => s + b.sizeBytes, 0);
  const doomed = new Set(excess.map((b) => b.name));
  if (total > maxTotal) {
    for (const b of normal.slice().reverse()) {
      if (total <= maxTotal) break;
      if (doomed.has(b.name)) continue;
      doomed.add(b.name);
      total -= b.sizeBytes;
    }
  }
  for (const n of doomed) {
    try {
      fs.rmSync(path.join(dir, n), { force: true });
    } catch { /* 淘汰失败不阻断备份主流程 */ }
  }
  return doomed.size;
}

function dbInfo(db) {
  const conn = db || ldb.getDb();
  const r = conn
    .prepare(
      `SELECT COUNT(*) AS n, MIN(txn_date) AS dmin, MAX(txn_date) AS dmax,
              SUM(CASE WHEN direction='IN' THEN 1 ELSE 0 END) AS inCount,
              SUM(CASE WHEN direction='OUT' THEN 1 ELSE 0 END) AS outCount
         FROM transactions`
    )
    .get();
  const count = (sql) => {
    try {
      return Number(conn.prepare(sql).get().n);
    } catch {
      return 0;
    }
  };
  let journalMode = 'unknown';
  try {
    journalMode = conn.prepare('PRAGMA journal_mode').get().journal_mode;
  } catch { /* 忽略 */ }
  const stat = fs.existsSync(LEDGER_DB_PATH) ? fs.statSync(LEDGER_DB_PATH) : null;
  return {
    fileName: path.basename(LEDGER_DB_PATH),
    sizeBytes: stat ? stat.size : 0,
    mtime: stat ? fmtTime(stat.mtimeMs) : null,
    txnCount: Number(r.n),
    incomeCount: Number(r.inCount || 0),
    expenseCount: Number(r.outCount || 0),
    dateMin: r.dmin,
    dateMax: r.dmax,
    lockedCount: count('SELECT COUNT(*) AS n FROM txn_classification WHERE locked=1'),
    transferPairs: count('SELECT COUNT(*) AS n FROM internal_transfer_pairs'),
    categoryCount: count('SELECT COUNT(*) AS n FROM categories'),
    ruleCount: count('SELECT COUNT(*) AS n FROM category_rules'),
    accountCount: count('SELECT COUNT(*) AS n FROM accounts'),
    journalMode,
  };
}

/** 二进制请求体（.db 上传用），超限 reject → 调用方转 413。 */
function readBinaryBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let settled = false;
    const chunks = [];
    const fail = (e) => {
      if (settled) return;
      settled = true;
      reject(e);
    };
    req.on('data', (c) => {
      if (settled) return;
      size += c.length;
      if (size > limit) {
        fail(new Error('body too large'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });
    req.on('error', fail);
  });
}

/** 上传文件落临时区并校验；调用方必须在 finally 里清理返回路径。 */
function stageUploadedDb(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 100) throw bad('上传内容为空或不是有效的 .db 文件');
  const tmp = path.join(os.tmpdir(), `wd-ledger-upload-${process.pid}-${Date.now()}.db`);
  fs.writeFileSync(tmp, buffer);
  try {
    validateDbFile(tmp);
    return tmp;
  } catch (e) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch { /* 清理失败不影响抛错 */ }
    throw e;
  }
}

/**
 * 把一个已校验的 .db 文件原子替换为主库。
 * 必须独占 ldb.withWrite() 串行链，且调用前已 close 掉所有读连接（本项目共用单例）。
 */
function swapIn(sourcePath) {
  const tmp = path.join(ldb.dbDir(), `.ledger-restore-${process.pid}.tmp`);
  ldb.closeDb();
  try {
    for (const f of [`${LEDGER_DB_PATH}-wal`, `${LEDGER_DB_PATH}-shm`, tmp]) {
      try {
        fs.rmSync(f, { force: true });
      } catch { /* 文件不存在 */ }
    }
    fs.copyFileSync(sourcePath, tmp);
    fs.renameSync(tmp, LEDGER_DB_PATH);
    for (const f of [`${LEDGER_DB_PATH}-wal`, `${LEDGER_DB_PATH}-shm`]) {
      try {
        fs.rmSync(f, { force: true });
      } catch { /* 文件不存在 */ }
    }
    const conn = ldb.reopenDb();
    const ic = conn.prepare('PRAGMA integrity_check').get();
    if (!ic || ic.integrity_check !== 'ok') throw new Error('恢复后 integrity_check 未通过');
  } catch (e) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch { /* 清理失败不影响抛错 */ }
    // 尽量把连接恢复成可用状态
    try {
      ldb.reopenDb();
    } catch { /* 原库可能已被破坏，交给外层回滚 */ }
    throw e;
  }
}

/**
 * 恢复主库。返回 { restored, preRestoreBackup, ...dbInfo }。
 * 失败时自动用 pre-restore 快照回滚，再抛错。
 */
async function restoreFrom(sourcePath) {
  if (ldb.isRestoring()) {
    const e = new Error('restore in progress');
    e.code = 'RESTORE_IN_PROGRESS';
    throw e;
  }
  ldb.setRestoring(true);
  try {
    return await ldb.withWrite(async () => {
      validateDbFile(sourcePath);
      const safety = await createBackup('auto-before-restore');
      try {
        swapIn(sourcePath);
      } catch (e) {
        let rolledBack = false;
        try {
          swapIn(path.join(ensureDir(), safety.name));
          rolledBack = true;
        } catch (e2) {
          console.error(`[ledger] 恢复失败且回滚失败: ${e2.message}`);
        }
        const err = new Error(`恢复失败${rolledBack ? '（已自动回滚到恢复前状态）' : '（回滚失败，请用安全快照手动恢复）'}: ${e.message}`);
        err.rolledBack = rolledBack;
        err.preRestoreBackup = safety;
        throw err;
      }
      // 快照本身已含完整分类与 locked 标注，不重跑分类 / 划转配对
      return {
        restored: true,
        preRestoreBackup: safety,
        ...dbInfo(ldb.getDb()),
      };
    });
  } finally {
    ldb.setRestoring(false);
  }
}

module.exports = {
  ensureDir,
  safeName,
  absPath,
  validateDbFile,
  snapshotStats,
  createBackup,
  currentDbSnapshot,
  listBackups,
  readBackup,
  deleteBackup,
  pruneBackups,
  dbInfo,
  readBinaryBody,
  stageUploadedDb,
  restoreFrom,
  LEDGER_BACKUP_DIR,
};
