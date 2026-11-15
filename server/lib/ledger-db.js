/**
 * 财务账本 SQLite 连接层（唯一接触 node:sqlite 的地方）。
 *
 * 设计要点：
 *  - node:sqlite 是 Node >=22.5 的内置实验模块，require 失败时只允许账本功能降级，
 *    绝不拖垮整个服务（调用方通过 probeSqlite() 判断）。
 *  - DatabaseSync 是同步 API；写操作统一经 withWrite() 的 Promise 串行链，
 *    避免两个异步 handler（导入 / 恢复）交错执行。
 *  - WAL 模式下读不阻塞写；恢复需要 close/reopen 连接，必须独占串行链。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { cfg, LEDGER_DB_PATH } = require('../config');

let sqliteMod = null;
let availability = null;
let db = null;
let writeChain = Promise.resolve();
let restoring = false;

/** 探测 node:sqlite 可用性；模块加载期不抛异常，结果缓存。 */
function probeSqlite() {
  if (availability) return availability;
  try {
    // eslint-disable-next-line global-require
    sqliteMod = require('node:sqlite');
    if (!sqliteMod || typeof sqliteMod.DatabaseSync !== 'function') {
      throw new Error('node:sqlite 未导出 DatabaseSync');
    }
    availability = {
      available: true,
      reason: '',
      backup: typeof sqliteMod.backup === 'function',
      experimental: true,
    };
  } catch (e) {
    availability = {
      available: false,
      reason: String((e && e.message) || e),
      backup: false,
      experimental: false,
    };
  }
  return availability;
}

function openDb() {
  const p = probeSqlite();
  if (!p.available) throw new Error(`node:sqlite unavailable: ${p.reason}`);
  if (!fs.existsSync(LEDGER_DB_PATH)) {
    throw new Error(`账本数据库不存在: ${LEDGER_DB_PATH}`);
  }
  const conn = new sqliteMod.DatabaseSync(LEDGER_DB_PATH);
  conn.exec('PRAGMA journal_mode=WAL');
  conn.exec(`PRAGMA busy_timeout=${Math.max(100, cfg.ledger.busyTimeoutMs || 5000)}`);
  conn.exec('PRAGMA foreign_keys=ON');
  conn.exec('PRAGMA synchronous=NORMAL');
  return conn;
}

function getDb() {
  if (!db) db = openDb();
  return db;
}

function closeDb() {
  if (!db) return;
  try {
    db.close();
  } finally {
    db = null;
  }
}

function reopenDb() {
  closeDb();
  return getDb();
}

/** 串行执行写操作；fn 可以同步也可以 async，返回值原样透传。 */
function withWrite(fn) {
  const task = writeChain.then(() => fn(getDb()));
  // 任一任务失败不应打断后续串行链，但错误仍要抛给调用方
  writeChain = task.catch(() => {});
  return task;
}

/** 在单个 IMMEDIATE 事务内执行 fn，异常自动回滚。 */
function withTransaction(dbConn, fn) {
  dbConn.exec('BEGIN IMMEDIATE');
  try {
    const out = fn(dbConn);
    dbConn.exec('COMMIT');
    return out;
  } catch (e) {
    try {
      dbConn.exec('ROLLBACK');
    } catch {
      /* 回滚失败不覆盖原始异常 */
    }
    throw e;
  }
}

function all(sql, ...params) {
  return getDb().prepare(sql).all(...params);
}

function get(sql, ...params) {
  return getDb().prepare(sql).get(...params);
}

function run(sql, ...params) {
  return getDb().prepare(sql).run(...params);
}

function isRestoring() {
  return restoring;
}

function setRestoring(v) {
  restoring = Boolean(v);
}

/** 主库路径与伴生 WAL/SHM 文件（恢复换库前需要清理）。 */
function dbSideFiles() {
  return [LEDGER_DB_PATH, `${LEDGER_DB_PATH}-wal`, `${LEDGER_DB_PATH}-shm`];
}

function dbDir() {
  return path.dirname(LEDGER_DB_PATH);
}

module.exports = {
  probeSqlite,
  getSqliteModule: () => {
    probeSqlite();
    return sqliteMod;
  },
  openDb,
  getDb,
  closeDb,
  reopenDb,
  withWrite,
  withTransaction,
  all,
  get,
  run,
  isRestoring,
  setRestoring,
  dbSideFiles,
  dbDir,
  LEDGER_DB_PATH,
};
