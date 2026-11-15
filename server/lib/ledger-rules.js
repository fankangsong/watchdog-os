/**
 * 财务账本分类引擎（Node 侧移植 bank-ledger/classify.py + import_cmb.py 的配对逻辑）。
 *
 * 约定：
 *  - categories.json / rules.json 是唯一事实来源；规则本体从 db 的 category_rules 读取
 *    （与 Python classify.py 完全一致，保证 rule_id 与既有标注不悬空），表为空时才播种。
 *  - 绝对不 DELETE FROM category_rules 再重灌：Python init_db() 会重置 rule_id，
 *    使既有 txn_classification.rule_id 悬空。
 *  - locked=1 的人工标注永不覆盖。
 *  - 顺序必须是「入库 → 划转配对 → 规则分类」，因为 priority=1 规则依赖 is_internal_transfer。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { LEDGER_DIR } = require('../config');
const { extractPerson } = require('./ledger-csv');
const { withTransaction } = require('./ledger-db');

const TRANSFER_TYPES = ['转账汇款', '行内转入', '汇入汇款', '网联付款交易', '银联代付'];

function nowStr() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function loadCategories() {
  const raw = fs.readFileSync(path.join(LEDGER_DIR, 'categories.json'), 'utf8').replace(/^\uFEFF/, '');
  return JSON.parse(raw);
}

function loadRulesFile() {
  const raw = fs.readFileSync(path.join(LEDGER_DIR, 'rules.json'), 'utf8').replace(/^\uFEFF/, '');
  return JSON.parse(raw);
}

/** 只在 category_rules 为空时播种（新库 / 测试 fixture），保持 rule_id 稳定。 */
function seedRulesIfEmpty(db) {
  const n = db.prepare('SELECT COUNT(*) AS n FROM category_rules').get().n;
  if (Number(n) > 0) return;
  const codeToId = new Map(
    db.prepare('SELECT code, category_id FROM categories').all().map((r) => [r.code, Number(r.category_id)])
  );
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO category_rules(priority,category_id,conditions_json,confidence,note)
     VALUES(?,?,?,?,?)`
  );
  for (const r of loadRulesFile()) {
    const cid = codeToId.get(r.category);
    if (cid == null) throw new Error(`rules.json 引用了不存在的类别 ${r.category}`);
    stmt.run(r.priority, cid, JSON.stringify(r.when || {}), r.confidence == null ? 1.0 : r.confidence, r.note || null);
  }
}

/** 复刻 classify.py:load_rules()，按 priority, rule_id 升序。 */
function loadRules(db) {
  seedRulesIfEmpty(db);
  return db
    .prepare(
      `SELECT rule_id, priority, category_id, conditions_json, confidence, note
         FROM category_rules ORDER BY priority, rule_id`
    )
    .all()
    .map((r) => ({ ...r, conditions: JSON.parse(r.conditions_json || '{}') }));
}

/** 复刻 classify.py:rule_matches() 的 10 个条件键（全部需满足）。 */
function ruleMatches(cond, t) {
  if (cond.direction !== undefined && cond.direction !== t.direction) return false;
  if (cond.is_internal_transfer !== undefined &&
      Number(cond.is_internal_transfer) !== Number(t.is_internal_transfer)) return false;
  if (cond.txn_type_in && !cond.txn_type_in.includes(t.txn_type)) return false;
  const memo = t.memo_clean || '';
  if (cond.memo_contains_any && !cond.memo_contains_any.some((k) => memo.includes(k))) return false;
  if (cond.memo_not_contains_any && cond.memo_not_contains_any.some((k) => memo.includes(k))) return false;
  if (cond.memo_regex && !new RegExp(cond.memo_regex).test(memo)) return false;
  if (cond.channel_in && !cond.channel_in.includes(t.channel)) return false;
  const cp = t.counterparty || '';
  if (cond.counterparty_contains_any &&
      !cond.counterparty_contains_any.some((k) => cp.includes(k))) return false;
  const amount = t.direction === 'IN' ? Number(t.income_cent) : Number(t.expense_cent);
  if (cond.amount_min_cent !== undefined && amount < cond.amount_min_cent) return false;
  if (cond.amount_max_cent !== undefined && amount > cond.amount_max_cent) return false;
  return true;
}

/**
 * 全量重算跨卡内部划转（复刻 import_cmb.py:pair_internal_transfers）。
 * 先清零再配对；pair_id 由稳定的 txn_id 派生，既有 71 组 ID 不变。
 */
function pairInternalTransfers(db, opts = {}) {
  const work = (conn) => {
    conn.exec('UPDATE transactions SET is_internal_transfer=0, transfer_pair_id=NULL WHERE is_internal_transfer=1');
    conn.exec('DELETE FROM internal_transfer_pairs');
    const ph = TRANSFER_TYPES.map(() => '?').join(',');
    const rows = conn
      .prepare(
        `SELECT txn_id,account_id,txn_date,txn_ts,direction,income_cent,expense_cent,
                txn_type,memo_raw,source_file FROM transactions WHERE txn_type IN (${ph})`
      )
      .all(...TRANSFER_TYPES);

    const groups = new Map();
    for (const r of rows) {
      const amount = r.direction === 'IN' ? Number(r.income_cent) : Number(r.expense_cent);
      const key = `${r.txn_date}|${amount}`;
      if (!groups.has(key)) groups.set(key, { OUT: [], IN: [] });
      groups.get(key)[r.direction].push(r);
    }

    const seconds = (ts) => {
      const [h, m, s] = String(ts).slice(11).split(':').map(Number);
      return h * 3600 + m * 60 + s;
    };

    const insertPair = conn.prepare(
      `INSERT OR REPLACE INTO internal_transfer_pairs
        (pair_id,out_txn_id,in_txn_id,amount_cent,txn_date,match_method,confidence)
       VALUES(?,?,?,?,?,?,?)`
    );
    const markTxn = conn.prepare(
      'UPDATE transactions SET is_internal_transfer=1, transfer_pair_id=? WHERE txn_id IN (?,?)'
    );

    let pairs = 0;
    for (const [key, g] of groups) {
      const [date, amountStr] = key.split('|');
      const amount = Number(amountStr);
      const candidates = [];
      for (const out of g.OUT) {
        for (const inc of g.IN) {
          if (out.account_id === inc.account_id) continue;
          const po = extractPerson(out.memo_raw || '');
          const pi = extractPerson(inc.memo_raw || '');
          if (po && pi && po !== pi) continue;
          const gap = Math.abs(seconds(out.txn_ts) - seconds(inc.txn_ts));
          const nameMatch = Boolean(po && pi && po === pi);
          if (!nameMatch && gap > 300) continue;
          const conf = nameMatch ? 0.98 : 0.85;
          candidates.push({ conf, gap, out, inc, nameMatch });
        }
      }
      candidates.sort((a, b) => (b.conf - a.conf) || (a.gap - b.gap));
      const usedOut = new Set();
      const usedIn = new Set();
      for (const c of candidates) {
        if (usedOut.has(c.out.txn_id) || usedIn.has(c.inc.txn_id)) continue;
        usedOut.add(c.out.txn_id);
        usedIn.add(c.inc.txn_id);
        const crypto = require('crypto');
        const pairId = 'IT-' + crypto.createHash('sha1')
          .update(`${c.out.txn_id}:${c.inc.txn_id}`).digest('hex').slice(0, 12);
        insertPair.run(
          pairId, c.out.txn_id, c.inc.txn_id, amount, date,
          c.nameMatch ? '同日同额+反向+人名一致' : '同日同额+反向+5分钟内', c.conf
        );
        markTxn.run(pairId, c.out.txn_id, c.inc.txn_id);
        pairs += 1;
      }
    }
    return pairs;
  };
  // 增量导入时外层已有事务，opts.transaction=false 可避免嵌套 BEGIN
  return opts.transaction === false ? work(db) : withTransaction(db, work);
}

/**
 * 规则分类（复刻 classify.py:run_rules()）：跳过 locked=1，其余 REPLACE。
 * 返回 { processed, lowConfidence }。
 */
function classifyAll(db, opts = {}) {
  const rules = loadRules(db);
  if (!rules.length) throw new Error('category_rules 为空，无法分类');
  const work = (conn) => {
    const txns = conn
      .prepare(
        `SELECT txn_id,direction,txn_type,memo_clean,channel,counterparty,
                income_cent,expense_cent,is_internal_transfer FROM transactions`
      )
      .all();
    const locked = new Set(
      conn.prepare('SELECT txn_id FROM txn_classification WHERE locked=1').all().map((r) => Number(r.txn_id))
    );
    const stmt = conn.prepare(
      `INSERT OR REPLACE INTO txn_classification
        (txn_id,category_id,counterparty,channel,tags,source,confidence,rule_id,reason,locked,classified_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?)`
    );
    const stamp = nowStr();
    let processed = 0;
    for (const t of txns) {
      if (locked.has(Number(t.txn_id))) continue;
      const rule = rules.find((r) => ruleMatches(r.conditions, t)) || {
        rule_id: null, category_id: null, confidence: 0.0, note: '无规则命中',
      };
      stmt.run(
        t.txn_id, rule.category_id, t.counterparty, t.channel,
        t.channel ? JSON.stringify([t.channel]) : null,
        'rule', rule.confidence, rule.rule_id, rule.note || null, 0, stamp
      );
      processed += 1;
    }
    const low = conn
      .prepare('SELECT COUNT(*) AS n FROM txn_classification WHERE locked=0 AND (confidence IS NULL OR confidence < 0.7)')
      .get().n;
    return { processed, lowConfidence: Number(low) };
  };
  return opts.transaction === false ? work(db) : withTransaction(db, work);
}

/** 人工改类别：写 source='manual', confidence=1.0, locked=1；unlock 时解除锁定。 */
function applyManual(db, txnIds, categoryCode, unlock = false) {
  const ids = [...new Set((txnIds || []).map(Number).filter((n) => Number.isFinite(n) && n > 0))];
  if (!ids.length) return 0;
  return withTransaction(db, (conn) => {
    const cat = conn.prepare('SELECT category_id FROM categories WHERE code=?').get(categoryCode);
    if (!cat && !unlock) throw new Error(`未知类别: ${categoryCode}`);
    const stmt = conn.prepare(
      `INSERT INTO txn_classification
        (txn_id,category_id,counterparty,channel,tags,source,confidence,rule_id,reason,locked,classified_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(txn_id) DO UPDATE SET
         category_id=excluded.category_id, source=excluded.source,
         confidence=excluded.confidence, rule_id=excluded.rule_id,
         reason=excluded.reason, locked=excluded.locked, classified_at=excluded.classified_at`
    );
    const stamp = nowStr();
    for (const id of ids) {
      const t = conn
        .prepare('SELECT channel,counterparty FROM transactions WHERE txn_id=?')
        .get(id);
      if (!t) continue;
      if (unlock) {
        conn.prepare('UPDATE txn_classification SET locked=0, source=\'rule\' WHERE txn_id=?').run(id);
      } else {
        stmt.run(
          id, cat.category_id, t.counterparty, t.channel,
          t.channel ? JSON.stringify([t.channel]) : null,
          'manual', 1.0, null, '人工指定', 1, stamp
        );
      }
    }
    return ids.length;
  });
}

module.exports = {
  loadCategories,
  loadRulesFile,
  loadRules,
  ruleMatches,
  pairInternalTransfers,
  classifyAll,
  applyManual,
  nowStr,
};
