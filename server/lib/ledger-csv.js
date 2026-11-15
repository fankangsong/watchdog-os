/**
 * 招商银行流水 CSV 解析（纯函数，不碰数据库）。
 *
 * 与 bank-ledger/import_cmb.py 的 parse_file() 严格对齐，尤其是 row_hash：
 *   sha1(accountNoMasked|dateRaw|timeRaw|incomeRaw|expenseRaw|balanceRaw|txnType|memoRaw)
 * 其中 8 个字段都是 csv.reader 解出的原始值经 strip() 后的结果，
 * 不是转分 / 脱敏 / ISO 日期后的派生值。任何偏差都会让同一笔流水被重复导入。
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { LEDGER_DIR } = require('../config');

const HEADER_FIRST_FIELD = '交易日期';
const CHANNEL_PREFIX = new Set([
  '财付通', '微信支付', '支付宝', '美团', '拼多多', '网银在线', '银联在线支付', '京东',
]);
const PERSON_STOP = new Set([
  '转账', '房贷', '汇款', '转入', '转出', '支付', '还款', '提现', '消费', '退款',
  '结息', '代扣', '存款', '取现', '基金', '申购', '赎回', '微信', '财付通', '支付宝',
  '通讯费', '电费', '水费', '燃气', '停车', '加油', '款项', '特约商户',
]);
const PERSON_EXCLUDE_WORDS = ['公司', '支付', '超市', '银行', '基金', '便利', '餐厅', '科技', '服务', '商户'];

function clean(v) {
  return String(v == null ? '' : v).trim();
}

/** 金额（元字符串）→ 整数分；不用浮点，避免 IEEE754 误差。 */
function toCent(text) {
  const s = clean(text);
  if (!s) return 0;
  const m = s.match(/^([+-]?)(\d+)(?:\.(\d{1,2}))?$/);
  if (!m) throw new Error(`非法金额或超过两位小数: ${JSON.stringify(s)}`);
  const frac = (m[3] || '').padEnd(2, '0');
  const v = Number(m[2]) * 100 + Number(frac || 0);
  return m[1] === '-' ? -v : v;
}

/** YYYYMMDD → YYYY-MM-DD */
function toIsoDate(text) {
  const s = clean(text);
  if (!/^\d{8}$/.test(s)) throw new Error(`非法日期: ${JSON.stringify(s)}`);
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}

/** 复刻 import_cmb.py:desensitize()，替换顺序不可调整。 */
function desensitize(memo, piiNames) {
  if (!memo) return '';
  let s = memo.trim();
  s = s.replace(/\d{6,}/g, '<编号>');
  s = s.replace(/\(\s*\d{4}\s*\)/g, '<卡尾号>');
  s = s.replace(/\d{4}\*{4,}\d{4}/g, '<账号>');
  for (const name of piiNames || []) {
    if (name) s = s.split(name).join('<人名>');
  }
  s = s.replace(/(转账|房贷|汇款|转入|转出)\s+([\u4e00-\u9fff]{2,3})\s*$/, '$1 <人名>');
  s = s.replace(/^\s*[\u4e00-\u9fff]{2,3}\s*$/, '<人名>');
  return s;
}

/** 复刻 import_cmb.py:extract_channel()，判断顺序不可调整。 */
function extractChannel(memo, txnType) {
  const s = memo || '';
  const t = txnType || '';
  if (s.includes('财付通') || s.includes('微信')) return '微信支付';
  if (s.includes('支付宝')) return '支付宝';
  if (s.includes('拼多多')) return '拼多多';
  if (s.includes('美团')) return '美团';
  if (s.includes('京东') || s.includes('网银在线')) return '京东';
  if (s.includes('银联') || t.includes('银联')) return '银联';
  if (s.includes('网联') || t.includes('网联')) return '网联';
  if (t.includes('一网通') || s.includes('一网通')) return '网银';
  if (s.includes('招商银行')) return '银行';
  return '其他';
}

/** 复刻 import_cmb.py:extract_counterparty() */
function extractCounterparty(memo) {
  if (!memo) return null;
  const s = memo.trim();
  const parts = s.split('-').map((p) => p.trim()).filter(Boolean);
  if (parts.length >= 2 && CHANNEL_PREFIX.has(parts[0])) return parts[parts.length - 1].slice(0, 80);
  const m = s.match(/^(?:转账|房贷|汇款|转入|转出|提现)\s+(.+)$/);
  if (m) return m[1].trim().slice(0, 80);
  return s.slice(0, 80);
}

/** 复刻 import_cmb.py:extract_person()，用于跨卡划转配对。 */
function extractPerson(memo) {
  if (!memo) return null;
  const m = memo.trim().match(/([\u4e00-\u9fff]{2,3})\s*$/);
  if (!m) return null;
  const name = m[1];
  if (PERSON_STOP.has(name)) return null;
  if (PERSON_EXCLUDE_WORDS.some((w) => name.includes(w))) return null;
  return name;
}

/**
 * CSV 行解析：带引号状态机，支持 "" 转义与字段内逗号 / 换行。
 * 返回 [{ lineNo, row: string[] }]，lineNo 是物理起始行号（与 Python enumerate 一致）。
 */
function parseCsvRows(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let lineNo = 1;
  let rowStartLine = 1;
  let hasContent = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else if (ch === '\n') {
        lineNo += 1;
        field += '\n';
      } else if (ch !== '\r') {
        field += ch;
      }
      hasContent = true;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      hasContent = true;
      continue;
    }
    if (ch === ',') {
      row.push(field);
      field = '';
      hasContent = true;
      continue;
    }
    if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      row.push(field);
      rows.push({ lineNo: rowStartLine, row });
      row = [];
      field = '';
      hasContent = false;
      lineNo += 1;
      rowStartLine = lineNo;
      continue;
    }
    field += ch;
    hasContent = true;
  }
  if (hasContent || row.length > 0 || field !== '') {
    row.push(field);
    rows.push({ lineNo: rowStartLine, row });
  }
  return rows;
}

/** 读取 Python 工具链的 pii_names（config.example.json + 可选 config.json 叠加）。 */
function readPiiNames() {
  let names = [];
  for (const f of ['config.example.json', 'config.json']) {
    const p = path.join(LEDGER_DIR, f);
    try {
      const obj = JSON.parse(fs.readFileSync(p, 'utf8'));
      const v = obj && obj.privacy && obj.privacy.pii_names;
      if (Array.isArray(v)) names = v.map(String).filter(Boolean);
    } catch {
      /* 配置文件缺失或非法时沿用已有值，不阻断解析 */
    }
  }
  return names;
}

function sha256Text(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function rowHash(accountNoMasked, r) {
  return crypto
    .createHash('sha1')
    .update(
      [
        accountNoMasked,
        r.dateRaw,
        r.timeRaw,
        r.incomeRaw,
        r.expenseRaw,
        r.balanceRaw,
        r.txnType,
        r.memoRaw,
      ].join('|'),
      'utf8'
    )
    .digest('hex');
}

/**
 * 解析整份 CSV 文本（不做任何数据库写入）。
 * @param {string} rawText UTF-8 文本（可能带 BOM，也可能已被浏览器吞掉）
 * @param {{filename?:string, piiNames?:string[]}} opts
 * @returns ParsedFile
 */
function parseCsv(rawText, opts = {}) {
  if (typeof rawText !== 'string' || !rawText.trim()) {
    throw new Error('CSV 内容为空');
  }
  // utf-8-sig 是「文件级」去 BOM：只在整段开头去一次，不能逐字段处理。
  const text = rawText.replace(/^\uFEFF/, '');
  const filename = clean(opts.filename) || 'upload.csv';
  const piiNames = opts.piiNames || readPiiNames();
  const rows = parseCsvRows(text);

  const metaText = rows
    .slice(0, 7)
    .filter((r) => r.row.length && String(r.row[0]).startsWith('#'))
    .map((r) => String(r.row[0] || ''))
    .join('\n');
  const allText = rows
    .filter((r) => r.row.length)
    .map((r) => String(r.row[0] || ''))
    .join('\n');

  const mExported = metaText.match(/导出时间:\s*\[?\s*(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})/);
  const mAccount = metaText.match(/(\d{4})\*{8}(\d{4})/);
  if (!mAccount) throw new Error(`${filename}: 未能从元数据解析脱敏账号`);
  const cardBin = mAccount[1];
  const cardTail = mAccount[2];
  const accountNoMasked = `${cardBin}********${cardTail}`;

  const mCardType = metaText.match(/账\s*号:\s*\[\s*([^:：\[\]]+)[:：]/);
  const accountLine = metaText.split('\n').find((l) => l.includes('账') && l.includes('号:')) || '';
  const mBank = accountLine.match(/\s+([^\s\]]+)\s*\]\s*$/);
  const mCurrency = metaText.match(/币\s*种:\s*\[\s*([^\]\s]+)\s*\]/);
  const mPeriod = metaText.match(/起始日期:\s*\[\s*(\d{8})\s*\].*?终止日期:\s*\[\s*(\d{8})\s*\]/);

  const account = {
    accountNoMasked,
    cardBin,
    cardTail,
    cardType: mCardType ? mCardType[1].trim() : null,
    bankName: mBank ? mBank[1] : '招商银行',
    currency: mCurrency && mCurrency[1].includes('人民币') ? 'CNY' : mCurrency ? mCurrency[1] : 'CNY',
    sourceFile: filename,
    exportedAt: mExported ? mExported[1] : null,
    periodStart: mPeriod ? toIsoDate(mPeriod[1]) : null,
    periodEnd: mPeriod ? toIsoDate(mPeriod[2]) : null,
  };

  const mIn = allText.match(/收入合计:\s*(\d+)\s*笔[，,]\s*共\s*([\d.]+)\s*元/);
  const mOut = allText.match(/支出合计:\s*(\d+)\s*笔[，,]\s*共\s*([\d.]+)\s*元/);
  const declared = {
    incomeCount: mIn ? Number(mIn[1]) : null,
    incomeCent: mIn ? toCent(mIn[2]) : null,
    expenseCount: mOut ? Number(mOut[1]) : null,
    expenseCent: mOut ? toCent(mOut[2]) : null,
  };

  const txns = [];
  let skippedLines = 0;
  for (const { lineNo, row } of rows) {
    if (!row.length || (row.length === 1 && !clean(row[0]))) {
      skippedLines += 1;
      continue;
    }
    if (row.length === 1 && String(row[0]).replace(/^\s+/, '').startsWith('#')) {
      skippedLines += 1;
      continue;
    }
    const first = clean(row[0]);
    if (first === HEADER_FIRST_FIELD) {
      skippedLines += 1;
      continue;
    }
    if (row.length !== 7) {
      throw new Error(`${filename}:${lineNo} 字段数 ${row.length} != 7`);
    }
    if (!/^\d{8}$/.test(first)) {
      skippedLines += 1;
      continue;
    }

    const [dateRaw, timeRaw, incomeRaw, expenseRaw, balanceRaw, txnType, memoRaw] = row.map(clean);
    if (!/^\d{2}:\d{2}:\d{2}$/.test(timeRaw)) {
      throw new Error(`${filename}:${lineNo} 非法时间 ${JSON.stringify(timeRaw)}`);
    }
    const incomeCent = toCent(incomeRaw);
    const expenseCent = toCent(expenseRaw);
    if ((incomeCent > 0) === (expenseCent > 0)) {
      throw new Error(`${filename}:${lineNo} 收入/支出列未恰好一列非空`);
    }
    const direction = incomeCent > 0 ? 'IN' : 'OUT';
    const txnDate = toIsoDate(dateRaw);
    const memoClean = desensitize(memoRaw, piiNames);
    const channel = extractChannel(memoRaw, txnType);
    const counterparty = extractCounterparty(memoRaw);

    txns.push({
      accountNoMasked,
      txnDate,
      txnTime: timeRaw,
      txnTs: `${txnDate} ${timeRaw}`,
      direction,
      incomeCent,
      expenseCent,
      amountSignedCent: direction === 'IN' ? incomeCent : -expenseCent,
      balanceCent: toCent(balanceRaw),
      txnType,
      memoRaw: memoRaw || null,
      memoClean,
      counterparty,
      channel,
      sourceFile: filename,
      sourceLineNo: lineNo,
      rowHash: rowHash(accountNoMasked, {
        dateRaw, timeRaw, incomeRaw, expenseRaw, balanceRaw, txnType, memoRaw,
      }),
      person: extractPerson(memoRaw),
    });
  }

  const actual = {
    incomeCount: txns.filter((t) => t.direction === 'IN').length,
    expenseCount: txns.filter((t) => t.direction === 'OUT').length,
    incomeCent: txns.reduce((s, t) => s + t.incomeCent, 0),
    expenseCent: txns.reduce((s, t) => s + t.expenseCent, 0),
  };

  // 合计行核对（对全量解析行，不对用户勾选的子集）
  const declaredErrors = [];
  const pairs = [
    ['incomeCount', '收入笔数'], ['expenseCount', '支出笔数'],
    ['incomeCent', '收入金额'], ['expenseCent', '支出金额'],
  ];
  for (const [key, label] of pairs) {
    if (declared[key] != null && declared[key] !== actual[key]) {
      declaredErrors.push(`${label}不符: CSV合计=${declared[key]} / 解析=${actual[key]}`);
    }
  }

  // 文件内余额链：按 (txn_ts, -source_line_no) 排序后逐笔核对
  const ordered = txns.slice().sort((a, b) => {
    if (a.txnTs !== b.txnTs) return a.txnTs < b.txnTs ? -1 : 1;
    return b.sourceLineNo - a.sourceLineNo;
  });
  const chainErrors = [];
  for (let i = 1; i < ordered.length; i += 1) {
    const expected = ordered[i - 1].balanceCent + ordered[i].amountSignedCent;
    if (expected !== ordered[i].balanceCent) {
      chainErrors.push(
        `${filename} L${ordered[i].sourceLineNo}: 余额链断裂 期望 ${expected} / 实际 ${ordered[i].balanceCent}`
      );
    }
  }

  return {
    filename,
    fileSha256: sha256Text(text),
    account,
    declared,
    actual,
    declaredErrors,
    chainErrors,
    warnings: [],
    txns,
    skippedLines,
  };
}

/**
 * 与库内历史的边界余额链校验：增量区间文件通常不从账户首笔开始，
 * 断裂只记 warning，不阻断导入。
 */
function checkBoundaryWithDb(db, parsed) {
  if (!parsed.txns.length || !parsed.account.accountNoMasked) return null;
  const first = parsed.txns.slice().sort((a, b) => {
    if (a.txnTs !== b.txnTs) return a.txnTs < b.txnTs ? -1 : 1;
    return b.sourceLineNo - a.sourceLineNo;
  })[0];
  try {
    const r = db
      .prepare(
        `SELECT balance_cent, amount_signed_cent FROM transactions t
           JOIN accounts a ON a.account_id=t.account_id
          WHERE a.account_no_masked=? AND t.txn_ts < ?
          ORDER BY t.txn_ts DESC, t.txn_id DESC LIMIT 1`
      )
      .get(parsed.account.accountNoMasked, first.txnTs);
    if (!r) return null;
    const expected = Number(r.balance_cent) + Number(first.amountSignedCent);
    if (expected !== first.balanceCent) {
      return `与库内历史衔接处余额不连续（增量区间文件，已降级为警告）：期望 ${expected} / 实际 ${first.balanceCent}`;
    }
  } catch {
    /* 表结构不符时不影响导入主流程 */
  }
  return null;
}

module.exports = {
  parseCsv,
  checkBoundaryWithDb,
  clean,
  toCent,
  toIsoDate,
  desensitize,
  extractChannel,
  extractCounterparty,
  extractPerson,
  readPiiNames,
  parseCsvRows,
};
