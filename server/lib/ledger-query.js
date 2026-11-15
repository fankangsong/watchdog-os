/**
 * 财务账本查询层：参数白名单收敛、明细查询、报表实时聚合、CSV 导出。
 *
 * 报表不写 stats_period / stats_category_period 物化表：那两张表只有
 * (grain, period, scope, account_id=0) 与 (grain, period, scope, category_id)，
 * 不支持日期区间 / 分账户×类别 / domain 过滤，且增量导入后需显式 refresh 才更新。
 * 数据量仅 ~2000 行，直接对原表 JOIN + GROUP BY 更快也更准。
 */
'use strict';

const { loadCategories } = require('./ledger-rules');

const SORT_COLUMNS = {
  txn_ts: 't.txn_ts',
  txn_date: 't.txn_date',
  amount: 't.amount_signed_cent',
};
const DOMAINS = ['EXPENSE', 'INCOME', 'TRANSFER', 'INVESTMENT'];

function str(v, def = '') {
  return v == null ? def : String(v);
}

function intIn(v, def, min, max) {
  const n = parseInt(str(v), 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(Math.max(n, min), max);
}

function dateOk(v) {
  return /^\d{4}-\d{2}-\d{2}$/.test(str(v)) ? str(v) : '';
}

/** 所有 query 参数在此收敛；未知值一律回落，避免拼接注入。
 *  业务筛选条件（account/year/month/day/...）若传了无法识别的值，直接 400：
 *  绝不静默丢掉筛选条件，否则接口会返回「看起来筛过、其实没筛」的错误数据。 */
function parseFilters(url) {
  const q = url.searchParams;
  const f = {
    account: 'all',
    year: 'all',
    month: 'all',
    day: '',
    from: '',
    to: '',
    category: 'all',
    domain: 'all',
    direction: 'all',
    scope: 'all',
    q: '',
    sort: 'txn_ts',
    order: 'desc',
    limit: 200,
    offset: 0,
    dim: 'period',
    grain: 'month',
    topN: 10,
  };

  const rejected = [];
  const reject = (name, value) => rejected.push(`${name}=${String(value).slice(0, 60)}`);
  // 前端 ledgerQs 会跳过 'all' / 空值；这里仍兼容显式传 all（含大小写）的旧调用方
  const blank = (v) => v == null || v === '' || String(v).toLowerCase() === 'all';

  const acc = str(q.get('account'));
  if (!blank(acc)) {
    if (/^\d+$/.test(acc)) f.account = Number(acc);
    else reject('account', acc);
  }

  const year = str(q.get('year'));
  if (!blank(year)) {
    if (/^\d{4}$/.test(year)) f.year = year;
    else reject('year', year);
  }

  // meta.months 给出的是 YYYY-MM（跨年时同月不同年必须能区分），
  // 同时保留旧的 1~2 位月份写法（API / 既有测试在用）。
  const month = str(q.get('month'));
  if (!blank(month)) {
    if (/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
      f.month = month;
    } else if (/^\d{1,2}$/.test(month) && Number(month) >= 1 && Number(month) <= 12) {
      f.month = String(Number(month)).padStart(2, '0');
    } else {
      reject('month', month);
    }
  }

  for (const key of ['day', 'from', 'to']) {
    const v = str(q.get(key));
    if (!blank(v)) {
      if (dateOk(v)) f[key] = v;
      else reject(key, v);
    }
  }

  const cat = str(q.get('category'));
  if (!blank(cat)) {
    if (/^[A-Za-z0-9._-]{1,80}$/.test(cat)) f.category = cat;
    else reject('category', cat);
  }

  const domain = str(q.get('domain'));
  if (!blank(domain)) {
    if (DOMAINS.includes(domain.toUpperCase())) f.domain = domain.toUpperCase();
    else reject('domain', domain);
  }

  const dir = str(q.get('direction'));
  if (!blank(dir)) {
    const d = dir.toUpperCase();
    if (d === 'IN' || d === 'OUT') f.direction = d;
    else reject('direction', dir);
  }

  const scope = str(q.get('scope'));
  if (!blank(scope)) {
    const s = scope.toLowerCase();
    if (s === 'net') f.scope = 'net';
    else if (s !== 'all') reject('scope', scope);
  }

  const kw = str(q.get('q')).trim().slice(0, 100);
  if (kw) f.q = kw;

  const sort = str(q.get('sort'));
  if (SORT_COLUMNS[sort]) f.sort = sort;
  if (str(q.get('order')).toLowerCase() === 'asc') f.order = 'asc';

  f.limit = intIn(q.get('limit'), 200, 1, 2000);
  f.offset = intIn(q.get('offset'), 0, 0, 1000000);

  const dim = str(q.get('dim')).toLowerCase();
  if (['period', 'category', 'share'].includes(dim)) f.dim = dim;
  const grain = str(q.get('grain')).toLowerCase();
  if (grain === 'year' || grain === 'month') f.grain = grain;
  f.topN = intIn(q.get('topN'), 10, 1, 100);

  if (rejected.length) {
    const e = new Error(`无效筛选参数: ${rejected.join(', ')}`);
    e.status = 400;
    e.errors = rejected;
    throw e;
  }
  return f;
}

/** 回显实际生效的筛选条件，便于用 curl 直接核对「条件有没有被应用」。 */
function appliedFilters(f) {
  return {
    account: f.account, year: f.year, month: f.month, day: f.day,
    from: f.from, to: f.to, category: f.category, domain: f.domain,
    direction: f.direction, scope: f.scope, q: f.q,
  };
}

const BASE_FROM =
  ' FROM transactions t' +
  ' LEFT JOIN accounts a ON a.account_id=t.account_id' +
  ' LEFT JOIN txn_classification x ON x.txn_id=t.txn_id' +
  ' LEFT JOIN categories c ON c.category_id=x.category_id';

/** 构造 WHERE 子句（参数化，白名单排序字段）。 */
function buildWhere(f) {
  const parts = [];
  const params = [];
  if (f.account !== 'all') {
    parts.push('t.account_id = ?');
    params.push(f.account);
  }
  if (f.year !== 'all') {
    parts.push('substr(t.txn_date,1,4) = ?');
    params.push(f.year);
  }
  if (f.month !== 'all') {
    // YYYY-MM 精确匹配年月；两位 MM 匹配任意年份的同月
    parts.push(/^\d{4}-\d{2}$/.test(f.month)
      ? 'substr(t.txn_date,1,7) = ?'
      : 'substr(t.txn_date,6,2) = ?');
    params.push(f.month);
  }
  if (f.day) {
    parts.push('t.txn_date = ?');
    params.push(f.day);
  }
  if (f.from) {
    parts.push('t.txn_date >= ?');
    params.push(f.from);
  }
  if (f.to) {
    parts.push('t.txn_date <= ?');
    params.push(f.to);
  }
  if (f.category !== 'all') {
    parts.push('c.code = ?');
    params.push(f.category);
  }
  if (f.domain !== 'all') {
    parts.push('c.domain = ?');
    params.push(f.domain);
  }
  if (f.direction !== 'all') {
    parts.push('t.direction = ?');
    params.push(f.direction);
  }
  if (f.scope === 'net') parts.push('t.is_internal_transfer = 0');
  if (f.q) {
    // 只检索脱敏摘要 / 对手方 / 交易类型，绝不触碰 memo_raw
    parts.push('(instr(t.memo_clean, ?) > 0 OR instr(COALESCE(t.counterparty,\'\'), ?) > 0 OR instr(t.txn_type, ?) > 0)');
    params.push(f.q, f.q, f.q);
  }
  return { sql: parts.length ? ' WHERE ' + parts.join(' AND ') : '', params };
}

const TXN_SELECT =
  'SELECT t.txn_id AS txnId, t.txn_date AS txnDate, t.txn_time AS txnTime, t.txn_ts AS txnTs,' +
  ' a.account_no_masked AS accountNoMasked, t.direction AS direction,' +
  ' t.income_cent AS incomeCent, t.expense_cent AS expenseCent,' +
  ' t.amount_signed_cent AS amountSignedCent, t.balance_cent AS balanceCent,' +
  ' t.txn_type AS txnType, t.memo_clean AS memoClean, t.counterparty AS counterparty,' +
  ' t.channel AS channel, c.code AS categoryCode, c.label AS categoryLabel, c.domain AS domain,' +
  ' x.source AS source, x.confidence AS confidence, COALESCE(x.locked,0) AS locked,' +
  ' t.is_internal_transfer AS isInternalTransfer';

function queryTransactions(db, f) {
  const w = buildWhere(f);
  const total = Number(
    db.prepare(`SELECT COUNT(*) AS n${BASE_FROM}${w.sql}`).get(...w.params).n
  );
  const summary = db
    .prepare(
      `SELECT COALESCE(SUM(t.income_cent),0) AS incomeCent,
              COALESCE(SUM(t.expense_cent),0) AS expenseCent,
              COALESCE(SUM(t.amount_signed_cent),0) AS netCent,
              SUM(CASE WHEN t.direction='IN' THEN 1 ELSE 0 END) AS incomeCount,
              SUM(CASE WHEN t.direction='OUT' THEN 1 ELSE 0 END) AS expenseCount
       ${BASE_FROM}${w.sql}`
    )
    .get(...w.params);
  const rows = db
    .prepare(
      `${TXN_SELECT}${BASE_FROM}${w.sql}` +
        ` ORDER BY ${SORT_COLUMNS[f.sort]} ${f.order.toUpperCase()}, t.txn_id ${f.order.toUpperCase()}` +
        ' LIMIT ? OFFSET ?'
    )
    .all(...w.params, f.limit, f.offset);
  return {
    rows,
    total,
    limit: f.limit,
    offset: f.offset,
    filters: appliedFilters(f),
    summary: {
      incomeCent: Number(summary.incomeCent),
      expenseCent: Number(summary.expenseCent),
      netCent: Number(summary.netCent),
      incomeCount: Number(summary.incomeCount || 0),
      expenseCount: Number(summary.expenseCount || 0),
    },
  };
}

/** 导出用：取全部筛选结果（不受 limit/offset 限制，内部分批避免单次查询过大）。 */
function queryAllTransactions(db, f) {
  const w = buildWhere(f);
  const total = Number(db.prepare(`SELECT COUNT(*) AS n${BASE_FROM}${w.sql}`).get(...w.params).n);
  const order = f.order.toUpperCase();
  const stmt = db.prepare(
    `${TXN_SELECT}${BASE_FROM}${w.sql}` +
      ` ORDER BY ${SORT_COLUMNS[f.sort]} ${order}, t.txn_id ${order} LIMIT 1000 OFFSET ?`
  );
  const out = [];
  for (let offset = 0; offset < total; offset += 1000) {
    out.push(...stmt.all(...w.params, offset));
  }
  return out;
}

/** 下拉选项与统计基线；categories 以 db 为准（含 category_id），缺表时回退 JSON。 */
function queryMeta(db) {
  const accounts = db
    .prepare(
      `SELECT account_id AS accountId, account_no_masked AS accountNoMasked,
              bank_name AS bankName, card_type AS cardType, currency
         FROM accounts ORDER BY account_id`
    )
    .all();
  let categories = [];
  try {
    categories = db
      .prepare(
        `SELECT category_id AS categoryId, code, domain, level1, level2, label,
                include_in_stats AS includeInStats, sort_no AS sortNo
           FROM categories ORDER BY sort_no, category_id`
      )
      .all();
  } catch {
    categories = loadCategories().map((c, i) => ({ ...c, categoryId: i + 1 }));
  }
  if (!categories.length) categories = loadCategories().map((c, i) => ({ ...c, categoryId: i + 1 }));

  const distinct = (sql) => db.prepare(sql).all().map((r) => Object.values(r)[0]).filter(Boolean);
  return {
    accounts,
    categories,
    years: distinct('SELECT DISTINCT substr(txn_date,1,4) FROM transactions ORDER BY 1 DESC'),
    months: distinct('SELECT DISTINCT substr(txn_date,1,7) FROM transactions ORDER BY 1 DESC'),
    channels: distinct('SELECT DISTINCT channel FROM transactions WHERE channel IS NOT NULL ORDER BY 1'),
    txnTypes: distinct('SELECT DISTINCT txn_type FROM transactions ORDER BY 1'),
    domains: DOMAINS,
  };
}

function periodExpr(grain) {
  return grain === 'year' ? 'substr(t.txn_date,1,4)' : 'substr(t.txn_date,1,7)';
}

function queryReport(db, f) {
  const w = buildWhere(f);
  const pe = periodExpr(f.grain);
  const totals = db
    .prepare(
      `SELECT COALESCE(SUM(t.income_cent),0) AS incomeCent,
              COALESCE(SUM(t.expense_cent),0) AS expenseCent,
              COALESCE(SUM(t.amount_signed_cent),0) AS netCent,
              COUNT(*) AS txnCount,
              SUM(CASE WHEN t.direction='IN' THEN 1 ELSE 0 END) AS incomeCount,
              SUM(CASE WHEN t.direction='OUT' THEN 1 ELSE 0 END) AS expenseCount
       ${BASE_FROM}${w.sql}`
    )
    .get(...w.params);

  let rows = [];
  if (f.dim === 'period') {
    rows = db
      .prepare(
        `SELECT ${pe} AS period,
                COALESCE(SUM(t.income_cent),0) AS incomeCent,
                COALESCE(SUM(t.expense_cent),0) AS expenseCent,
                COALESCE(SUM(t.amount_signed_cent),0) AS netCent,
                SUM(CASE WHEN t.direction='IN' THEN 1 ELSE 0 END) AS incomeCount,
                SUM(CASE WHEN t.direction='OUT' THEN 1 ELSE 0 END) AS expenseCount,
                COUNT(*) AS txnCount
         ${BASE_FROM}${w.sql}
         GROUP BY ${pe} ORDER BY ${pe} ASC`
      )
      .all(...w.params);
  } else if (f.dim === 'category') {
    rows = db
      .prepare(
        `SELECT COALESCE(c.code,'unclassified.pending') AS categoryCode,
                COALESCE(c.label,'未分类') AS categoryLabel,
                COALESCE(c.domain,'EXPENSE') AS domain,
                COALESCE(c.level1,'其他') AS level1,
                COALESCE(c.include_in_stats,1) AS includeInStats,
                COALESCE(SUM(t.income_cent),0) AS incomeCent,
                COALESCE(SUM(t.expense_cent),0) AS expenseCent,
                COALESCE(SUM(t.amount_signed_cent),0) AS netCent,
                COUNT(*) AS txnCount
         ${BASE_FROM}${w.sql}
         GROUP BY c.code, c.label, c.domain, c.level1, c.include_in_stats
         ORDER BY ${f.direction === 'IN' ? 'incomeCent' : 'expenseCent'} DESC
         LIMIT ?`
      )
      .all(...w.params, f.topN);
  } else {
    // share：一级消费类别占比（复刻 v_category_share，只统计 EXPENSE 且 include_in_stats=1）
    const shareW = {
      sql: w.sql + (w.sql ? ' AND ' : ' WHERE ') + "c.domain='EXPENSE' AND COALESCE(c.include_in_stats,1)=1",
      params: w.params.slice(),
    };
    const grouped = db
      .prepare(
        `SELECT ${pe} AS period, COALESCE(c.level1,'其他') AS level1,
                COALESCE(SUM(t.expense_cent),0) AS expenseCent,
                COUNT(*) AS txnCount
         ${BASE_FROM}${shareW.sql}
         GROUP BY ${pe}, c.level1`
      )
      .all(...shareW.params);
    const byPeriod = new Map();
    for (const r of grouped) {
      byPeriod.set(r.period, (byPeriod.get(r.period) || 0) + Number(r.expenseCent));
    }
    rows = grouped.map((r) => ({
      period: r.period,
      level1: r.level1,
      expenseCent: Number(r.expenseCent),
      txnCount: Number(r.txnCount),
      expensePct: byPeriod.get(r.period)
        ? Number(((Number(r.expenseCent) / byPeriod.get(r.period)) * 100).toFixed(2))
        : 0,
    }));
    rows.sort((a, b) => (a.period < b.period ? -1 : a.period > b.period ? 1 : b.expenseCent - a.expenseCent));
  }

  return {
    dim: f.dim,
    grain: f.grain,
    scope: f.scope,
    filters: { ...appliedFilters(f), topN: f.topN },
    rows,
    totals: {
      incomeCent: Number(totals.incomeCent),
      expenseCent: Number(totals.expenseCent),
      netCent: Number(totals.netCent),
      txnCount: Number(totals.txnCount),
      incomeCount: Number(totals.incomeCount || 0),
      expenseCount: Number(totals.expenseCount || 0),
    },
    generatedAt: Date.now(),
  };
}

/* ---------------- CSV 导出（BOM + CRLF + 公式注入防护） ---------------- */

function csvCell(v) {
  let s = v == null ? '' : String(v);
  // Excel / Sheets 会以 = + - @ Tab 开头执行公式；加单引号前缀中和
  if (/^[=+\-@\t]/.test(s)) s = "'" + s;
  if (/[",\r\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function yuan(cent) {
  const n = Number(cent || 0);
  const sign = n < 0 ? '-' : '';
  const v = Math.abs(n);
  return `${sign}${Math.floor(v / 100)}.${String(v % 100).padStart(2, '0')}`;
}

function buildCsv(header, rows) {
  const lines = [header.map(csvCell).join(',')];
  for (const r of rows) lines.push(r.map(csvCell).join(','));
  return '\uFEFF' + lines.join('\r\n') + '\r\n';
}

function transactionsCsv(result) {
  return buildCsv(
    ['日期', '时间', '银行卡', '方向', '收入(元)', '支出(元)', '余额(元)', '交易类型',
      '类别编码', '类别名称', '对手方', '渠道', '脱敏摘要', '分类来源', '内部划转'],
    result.rows.map((r) => [
      r.txnDate, r.txnTime, r.accountNoMasked, r.direction,
      yuan(r.incomeCent), yuan(r.expenseCent), yuan(r.balanceCent), r.txnType,
      r.categoryCode || '', r.categoryLabel || '', r.counterparty || '', r.channel || '',
      r.memoClean || '', r.source || '', r.isInternalTransfer ? '是' : '否',
    ])
  );
}

function reportCsv(result) {
  if (result.dim === 'period') {
    return buildCsv(
      ['期间', '口径', '收入(元)', '支出(元)', '净额(元)', '收入笔数', '支出笔数', '总笔数'],
      result.rows.map((r) => [
        r.period, result.scope.toUpperCase(), yuan(r.incomeCent), yuan(r.expenseCent), yuan(r.netCent),
        r.incomeCount, r.expenseCount, r.txnCount,
      ])
    );
  }
  if (result.dim === 'category') {
    return buildCsv(
      ['口径', '域', '一级类别', '类别编码', '类别名称', '收入(元)', '支出(元)', '净额(元)', '笔数'],
      result.rows.map((r) => [
        result.scope.toUpperCase(), r.domain, r.level1, r.categoryCode, r.categoryLabel,
        yuan(r.incomeCent), yuan(r.expenseCent), yuan(r.netCent), r.txnCount,
      ])
    );
  }
  return buildCsv(
    ['月份', '一级类别', '支出(元)', '支出占比(%)', '笔数'],
    result.rows.map((r) => [r.period, r.level1, yuan(r.expenseCent), r.expensePct, r.txnCount])
  );
}

module.exports = {
  parseFilters,
  buildWhere,
  queryTransactions,
  queryAllTransactions,
  queryMeta,
  queryReport,
  csvCell,
  yuan,
  buildCsv,
  transactionsCsv,
  reportCsv,
  BASE_FROM,
};
