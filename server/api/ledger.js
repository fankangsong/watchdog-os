/**
 * /api/ledger/* 子路由：CSV 增量导入、多维流水查询、报表、SQLite 备份与恢复。
 *
 * 由 server/router.js 在静态回退之前以「块内惰性 require」方式加载，
 * 保证 Node<22.5（无 node:sqlite）时服务仍能启动，仅账本功能降级为 503。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { cfg, LEDGER_DB_PATH, LEDGER_BACKUP_DIR } = require('../config');
const { send, readBody } = require('../lib/http');
const ldb = require('../lib/ledger-db');
const csv = require('../lib/ledger-csv');
const rules = require('../lib/ledger-rules');
const query = require('../lib/ledger-query');
const backup = require('../lib/ledger-backup');

const PREFIX = '/api/ledger';

function httpErr(status, message, extra) {
  const e = new Error(message);
  e.status = status;
  if (extra) Object.assign(e, extra);
  return e;
}

async function readJson(req, limit) {
  const text = await readBody(req, limit);
  try {
    const v = JSON.parse(text);
    if (!v || typeof v !== 'object') throw new Error('not an object');
    return v;
  } catch {
    throw httpErr(400, 'Invalid JSON body');
  }
}

function fail(res, status, error, extra) {
  return send(res, status, Object.assign({ error }, extra || {}));
}

function attachmentHeaders(filename, contentType) {
  return {
    'Content-Type': contentType,
    'Content-Disposition': `attachment; filename="${String(filename).replace(/[^A-Za-z0-9._-]/g, '_')}"`,
    'Cache-Control': 'no-store',
  };
}

/** 预览行的去重状态（服务端以 row_hash 为准，绝不信任前端传来的明细字段）。 */
function rowStatus(dbConn, t, hashStmt, slotStmt) {
  if (hashStmt.get(t.rowHash)) return 'exists';
  if (slotStmt.get(t.sourceFile, t.sourceLineNo)) return 'conflict';
  return 'new';
}

/** 只回脱敏字段，memoRaw 永远不出服务端。 */
function previewRow(t, status, categoryGuess) {
  return {
    lineNo: t.sourceLineNo,
    rowHash: t.rowHash,
    txnDate: t.txnDate,
    txnTime: t.txnTime,
    direction: t.direction,
    amountCent: t.amountSignedCent,
    incomeCent: t.incomeCent,
    expenseCent: t.expenseCent,
    balanceCent: t.balanceCent,
    txnType: t.txnType,
    memoClean: t.memoClean,
    counterparty: t.counterparty,
    channel: t.channel,
    categoryGuess,
    status,
  };
}

function makeGuesser(dbConn) {
  let ruleList = [];
  let codes = new Map();
  try {
    ruleList = rules.loadRules(dbConn);
    codes = new Map(
      dbConn.prepare('SELECT category_id, code FROM categories').all()
        .map((r) => [Number(r.category_id), r.code])
    );
  } catch {
    return () => 'unclassified.pending';
  }
  return (t) => {
    const probe = {
      direction: t.direction,
      is_internal_transfer: 0,
      txn_type: t.txnType,
      memo_clean: t.memoClean,
      channel: t.channel,
      counterparty: t.counterparty,
      income_cent: t.incomeCent,
      expense_cent: t.expenseCent,
    };
    const hit = ruleList.find((r) => rules.ruleMatches(r.conditions, probe));
    return hit ? (codes.get(Number(hit.category_id)) || 'unclassified.pending') : 'unclassified.pending';
  };
}

function handleStatus(res) {
  const probe = ldb.probeSqlite();
  const out = {
    enabled: cfg.ledger.enabled,
    available: probe.available,
    engine: 'node:sqlite',
    nodeVersion: process.version,
    experimentalWarning: probe.experimental,
    dbPath: path.basename(LEDGER_DB_PATH),
    stats: null,
    backup: { dir: path.basename(LEDGER_BACKUP_DIR), count: 0, lastAt: null },
    reason: probe.reason || '',
  };
  if (cfg.ledger.enabled && probe.available) {
    try {
      out.stats = backup.dbInfo();
      const list = backup.listBackups(1);
      out.backup.count = list.length ? list.length : 0;
      out.backup.lastAt = list.length ? list[0].createdAt : null;
    } catch (e) {
      out.reason = String((e && e.message) || e);
    }
  }
  return send(res, 200, out);
}

async function handlePreview(req, res) {
  if (req.method !== 'POST') return fail(res, 404, 'not found');
  const body = await readJson(req, cfg.ledger.maxImportBytes);
  if (!body.filename || typeof body.text !== 'string') throw httpErr(400, '缺少 filename / text');
  const parsed = csv.parseCsv(body.text, { filename: String(body.filename) });
  if (parsed.declaredErrors.length) {
    return fail(res, 400, 'CSV 合计行核对失败', { errors: parsed.declaredErrors });
  }
  if (parsed.chainErrors.length) {
    return fail(res, 400, '文件内余额链断裂', { errors: parsed.chainErrors.slice(0, 20) });
  }

  const dbConn = ldb.getDb();
  const hashStmt = dbConn.prepare('SELECT txn_id FROM transactions WHERE row_hash=?');
  const slotStmt = dbConn.prepare('SELECT txn_id FROM transactions WHERE source_file=? AND source_line_no=?');
  const guess = makeGuesser(dbConn);
  const counts = { new: 0, exists: 0, conflict: 0 };
  const rows = parsed.txns.map((t) => {
    const status = rowStatus(dbConn, t, hashStmt, slotStmt);
    counts[status] += 1;
    return previewRow(t, status, guess(t));
  });

  const boundary = csv.checkBoundaryWithDb(dbConn, parsed);
  const warnings = [];
  if (boundary) warnings.push(boundary);
  warnings.push('增量区间文件：跨库衔接余额链仅作提示，不阻断导入');
  warnings.push('合计行核对基于全量解析行，与勾选子集无关');

  return send(res, 200, {
    filename: parsed.filename,
    account: parsed.account,
    declared: parsed.declared,
    actual: parsed.actual,
    checked: {
      declaredMatch: parsed.declaredErrors.length === 0,
      balanceChainWithinFile: parsed.chainErrors.length === 0,
      chainErrors: parsed.chainErrors.slice(0, 20),
    },
    warnings,
    rowCount: parsed.txns.length,
    counts,
    rows,
  });
}

const INSERT_TXN_SQL = `INSERT OR IGNORE INTO transactions(
    account_id,txn_date,txn_time,txn_ts,direction,income_cent,expense_cent,
    amount_signed_cent,balance_cent,txn_type,memo_raw,memo_clean,counterparty,channel,
    is_internal_transfer,transfer_pair_id,source_file,source_line_no,row_hash)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,NULL,?,?,?)`;

const INSERT_BATCH_SQL = `INSERT INTO import_batches(
    source_file,file_sha256,account_id,exported_at,period_start,period_end,
    row_count,income_count,expense_count,income_cent,expense_cent,
    declared_income_count,declared_expense_count,declared_income_cent,declared_expense_cent,
    status,message) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`;

async function handleCommit(req, res) {
  if (req.method !== 'POST') return fail(res, 404, 'not found');
  const body = await readJson(req, cfg.ledger.maxImportBytes);
  if (!body.filename || typeof body.text !== 'string') throw httpErr(400, '缺少 filename / text');
  const selected = new Set(
    Array.isArray(body.selected) ? body.selected.filter((s) => typeof s === 'string') : []
  );
  // 服务端重新解析，前端只能提供本次解析产生的 row_hash
  const parsed = csv.parseCsv(body.text, { filename: String(body.filename) });
  if (parsed.declaredErrors.length) {
    return fail(res, 422, 'CSV 合计行核对失败', { errors: parsed.declaredErrors });
  }
  if (parsed.chainErrors.length) {
    return fail(res, 422, '文件内余额链断裂', { errors: parsed.chainErrors.slice(0, 20) });
  }

  const dbConn = ldb.getDb();
  const hashStmt = dbConn.prepare('SELECT txn_id FROM transactions WHERE row_hash=?');
  const slotStmt = dbConn.prepare('SELECT txn_id FROM transactions WHERE source_file=? AND source_line_no=?');
  const chosen = [];
  let skipped = 0;
  let conflicts = 0;
  for (const t of parsed.txns) {
    if (hashStmt.get(t.rowHash)) {
      skipped += 1;
      continue;
    }
    if (slotStmt.get(t.sourceFile, t.sourceLineNo)) {
      if (selected.has(t.rowHash)) conflicts += 1;
      continue;
    }
    if (selected.has(t.rowHash)) chosen.push(t);
  }
  if (conflicts > 0) {
    return fail(res, 422, `有 ${conflicts} 行与库内 (source_file, source_line_no) 冲突，已拒绝导入`);
  }

  const boundary = csv.checkBoundaryWithDb(dbConn, parsed);
  const warnings = [];
  if (boundary) warnings.push(boundary);

  const result = await ldb.withWrite(async (conn) => {
    // 自动快照放在串行链内，避免与并发导入交错
    const autoBackup = cfg.ledger.autoBackupOnImport && chosen.length
      ? await backup.createBackup('auto-before-import')
      : null;

    return ldb.withTransaction(conn, (c) => {
      c.prepare(
        `INSERT OR IGNORE INTO accounts(
           account_no_masked,card_bin,card_tail,card_type,bank_name,currency,
           source_file,exported_at,period_start,period_end)
         VALUES(?,?,?,?,?,?,?,?,?,?)`
      ).run(
        parsed.account.accountNoMasked, parsed.account.cardBin, parsed.account.cardTail,
        parsed.account.cardType, parsed.account.bankName, parsed.account.currency,
        parsed.account.sourceFile, parsed.account.exportedAt,
        parsed.account.periodStart, parsed.account.periodEnd
      );
      const aid = c.prepare('SELECT account_id FROM accounts WHERE account_no_masked=?')
        .get(parsed.account.accountNoMasked).account_id;

      const ins = c.prepare(INSERT_TXN_SQL);
      let inserted = 0;
      for (const t of chosen) {
        const r = ins.run(
          aid, t.txnDate, t.txnTime, t.txnTs, t.direction, t.incomeCent, t.expenseCent,
          t.amountSignedCent, t.balanceCent, t.txnType, t.memoRaw, t.memoClean,
          t.counterparty, t.channel, t.sourceFile, t.sourceLineNo, t.rowHash
        );
        inserted += Number(r.changes || 0);
      }

      const chosenActual = {
        incomeCount: chosen.filter((t) => t.direction === 'IN').length,
        expenseCount: chosen.filter((t) => t.direction === 'OUT').length,
        incomeCent: chosen.reduce((s, t) => s + t.incomeCent, 0),
        expenseCent: chosen.reduce((s, t) => s + t.expenseCent, 0),
      };
      c.prepare(INSERT_BATCH_SQL).run(
        parsed.filename, parsed.fileSha256, aid, parsed.account.exportedAt,
        parsed.account.periodStart, parsed.account.periodEnd,
        chosen.length, chosenActual.incomeCount, chosenActual.expenseCount,
        chosenActual.incomeCent, chosenActual.expenseCent,
        parsed.declared.incomeCount, parsed.declared.expenseCount,
        parsed.declared.incomeCent, parsed.declared.expenseCent,
        warnings.length ? 'WARN' : 'OK',
        [`partial-import: selected ${chosen.length} of ${parsed.txns.length} parsed rows`,
          ...warnings].join('; ')
      );

      // 顺序不可调整：先划转配对，后规则分类（priority=1 规则依赖 is_internal_transfer）
      const transferPairs = rules.pairInternalTransfers(c, { transaction: false });
      const cls = rules.classifyAll(c, { transaction: false });
      const txnCount = Number(c.prepare('SELECT COUNT(*) AS n FROM transactions').get().n);
      return {
        batchId: Number(c.prepare('SELECT MAX(batch_id) AS n FROM import_batches').get().n),
        inserted, skipped, conflicts,
        classified: cls.processed,
        lowConfidence: cls.lowConfidence,
        transferPairs,
        autoBackup,
        stats: { txnCount },
      };
    });
  });

  return send(res, 200, { ...result, warnings });
}

async function handleBatches(req, res, url) {
  const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '20', 10) || 20, 1), 200);
  const batches = ldb.getDb()
    .prepare('SELECT * FROM import_batches ORDER BY imported_at DESC, batch_id DESC LIMIT ?')
    .all(limit);
  return send(res, 200, { batches });
}

async function handleClassification(req, res) {
  if (req.method !== 'PATCH') return fail(res, 404, 'not found');
  const body = await readJson(req, 64 * 1024);
  const ids = Array.isArray(body.txnIds) ? body.txnIds : [];
  const unlock = body.unlock === true;
  if (!ids.length) throw httpErr(400, 'txnIds 为空');
  if (!unlock && typeof body.categoryCode !== 'string') throw httpErr(400, '缺少 categoryCode');
  const dbConn = ldb.getDb();
  const updated = ldb.withWrite((c) => {
    const n = rules.applyManual(c, ids, body.categoryCode, unlock);
    if (unlock) rules.classifyAll(c, { transaction: false });
    return n;
  });
  return send(res, 200, { updated: await updated, locked: !unlock });
}

async function handleDbInfo(res) {
  const info = backup.dbInfo();
  const list = backup.listBackups(200);
  return send(res, 200, {
    ...info,
    backupDir: path.basename(LEDGER_BACKUP_DIR),
    backupCount: list.length,
    backupKeep: cfg.ledger.backupKeep,
  });
}

async function handleDbBackups(res, url) {
  const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '50', 10) || 50, 1), 200);
  return send(res, 200, {
    backups: backup.listBackups(limit),
    dir: path.basename(LEDGER_BACKUP_DIR),
    keep: cfg.ledger.backupKeep,
  });
}

async function handleCreateBackup(req, res) {
  if (req.method !== 'POST') return fail(res, 404, 'not found');
  const body = await readJson(req, 4096);
  if (body.download === true) {
    const snap = await backup.currentDbSnapshot();
    return send(res, 200, snap.buffer, attachmentHeaders(snap.name, 'application/octet-stream'));
  }
  const meta = await backup.createBackup('manual');
  return send(res, 200, { backup: meta });
}

async function handleDownloadBackup(res, url) {
  const name = url.searchParams.get('name');
  if (!name) throw httpErr(400, '缺少 name');
  const f = backup.readBackup(name);
  return send(res, 200, f.buffer, attachmentHeaders(f.name, 'application/octet-stream'));
}

async function handleDownloadCurrent(res) {
  const snap = await backup.currentDbSnapshot();
  return send(res, 200, snap.buffer, attachmentHeaders(snap.name, 'application/octet-stream'));
}

async function handleDeleteBackup(req, res, url) {
  if (req.method !== 'DELETE') return fail(res, 404, 'not found');
  const name = url.searchParams.get('name');
  if (!name) throw httpErr(400, '缺少 name');
  const deleted = backup.deleteBackup(name);
  return send(res, 200, { deleted });
}

async function handleRestore(req, res, url) {
  if (req.method !== 'POST') return fail(res, 404, 'not found');
  const isUpload = url.searchParams.get('upload') === '1';
  let sourcePath = null;
  let staged = null;
  try {
    if (isUpload) {
      const buffer = await backup.readBinaryBody(req, cfg.ledger.maxBackupBytes);
      sourcePath = backup.stageUploadedDb(buffer);
    } else {
      const body = await readJson(req, 64 * 1024);
      if (body.confirm !== true) throw httpErr(400, '恢复需要显式 confirm:true');
      if (!body.name) throw httpErr(400, '缺少 name');
      const src = backup.absPath(body.name);
      if (!fs.existsSync(src)) throw httpErr(404, '备份不存在');
      // 先复制到系统临时区：随后的自动快照会做淘汰，不能让来源文件被删掉
      staged = path.join(os.tmpdir(), `wd-ledger-restore-${process.pid}-${Date.now()}.db`);
      fs.copyFileSync(src, staged);
      sourcePath = staged;
    }
    const result = await backup.restoreFrom(sourcePath);
    return send(res, 200, { ...result, warnings: ['已恢复；恢复前状态保存在安全快照中，可再次恢复以撤销'] });
  } finally {
    if (sourcePath && (isUpload || staged)) {
      try {
        fs.rmSync(sourcePath, { force: true });
      } catch { /* 临时文件清理失败不影响响应 */ }
    }
  }
}

/** 主分发：p 是剥离 basePath 后的裸路径，形如 /api/ledger/xxx。 */
async function ledgerRoute(req, res, p, url) {
  const sub = p.slice(PREFIX.length) || '/';
  if (sub === '/' || sub === '/status') {
    if (req.method !== 'GET') return fail(res, 404, 'not found');
    return handleStatus(res);
  }
  if (!cfg.ledger.enabled) return fail(res, 503, 'Ledger disabled');
  const probe = ldb.probeSqlite();
  if (!probe.available) {
    return fail(res, 503, 'node:sqlite unavailable', { detail: probe.reason, nodeVersion: process.version });
  }
  if (ldb.isRestoring()) return fail(res, 409, 'restore in progress');

  try {
    switch (sub) {
      case '/meta':
        if (req.method !== 'GET') break;
        return send(res, 200, query.queryMeta(ldb.getDb()));
      case '/import/preview':
        return await handlePreview(req, res);
      case '/import/commit':
        return await handleCommit(req, res);
      case '/import/batches':
        if (req.method !== 'GET') break;
        return await handleBatches(req, res, url);
      case '/transactions':
        if (req.method !== 'GET') break;
        return send(res, 200, query.queryTransactions(ldb.getDb(), query.parseFilters(url)));
      case '/transactions.csv':
        if (req.method !== 'GET') break;
        return send(
          res, 200,
          query.transactionsCsv({ rows: query.queryAllTransactions(ldb.getDb(), query.parseFilters(url)) }),
          attachmentHeaders('ledger-transactions.csv', 'text/csv; charset=utf-8')
        );
      case '/classification':
        return await handleClassification(req, res);
      case '/report': {
        if (req.method !== 'GET') break;
        const r = query.queryReport(ldb.getDb(), query.parseFilters(url));
        return send(res, 200, r);
      }
      case '/report.csv': {
        if (req.method !== 'GET') break;
        const r = query.queryReport(ldb.getDb(), query.parseFilters(url));
        return send(res, 200, query.reportCsv(r), attachmentHeaders('ledger-report.csv', 'text/csv; charset=utf-8'));
      }
      case '/db/info':
        if (req.method !== 'GET') break;
        return await handleDbInfo(res);
      case '/db/backups':
        if (req.method !== 'GET') break;
        return await handleDbBackups(res, url);
      case '/db/backup':
        if (req.method === 'POST') return await handleCreateBackup(req, res);
        if (req.method === 'GET') return await handleDownloadBackup(res, url);
        if (req.method === 'DELETE') return await handleDeleteBackup(req, res, url);
        break;
      case '/db/current.db':
        if (req.method !== 'GET') break;
        return await handleDownloadCurrent(res);
      case '/db/restore':
        return await handleRestore(req, res, url);
      default:
        break;
    }
    return fail(res, 404, 'not found');
  } catch (e) {
    if (e && e.message === 'body too large') return fail(res, 413, 'body too large');
    if (e && e.code === 'RESTORE_IN_PROGRESS') return fail(res, 409, 'restore in progress');
    const status = e && e.status ? e.status : 500;
    if (status === 500) console.error('[ledger] 接口异常:', e);
    return fail(res, status, String((e && e.message) || e), {
      ...(e && e.errors ? { errors: e.errors } : {}),
      ...(e && e.rolledBack !== undefined ? { rolledBack: e.rolledBack } : {}),
      ...(e && e.preRestoreBackup ? { preRestoreBackup: e.preRestoreBackup } : {}),
    });
  }
}

module.exports = { ledgerRoute };
