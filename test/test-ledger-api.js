#!/usr/bin/env node
/**
 * 财务账本 API 冒烟测试（零依赖，自起自停 server）。
 *
 * 数据隔离：把真实 bank-ledger/ledger.db 复制一份到临时目录，备份目录也指向临时目录，
 * 绝不污染真实账本或 ~/.watchdog-os。覆盖：
 *   401 / status 基线 / meta / 多维查询 / CSV 导出 / 报表 / 类别改写
 *   / 两步增量导入（去重 + 自动快照）/ 备份下载 / 恢复往返 / 非法文件与穿越防护 / 禁用降级。
 */
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 3214;
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = path.join(__dirname, '..');
const TMP = path.join(os.tmpdir(), 'srv-ledger-test-' + Date.now());
const DB = path.join(TMP, 'ledger.db');
const BACKUP_DIR = path.join(TMP, 'backups');
const PASSWORD = process.env.PASSWORD || 'test123';
const JWT_SECRET = process.env.JWT_SECRET || 'test-only-jwt-secret-0123456789abcdef0123456789';

let passed = 0;
let failed = 0;
function ok(name, cond, extra = '') {
  if (cond) {
    passed += 1;
    console.log(`PASS ${name}${extra ? ' — ' + extra : ''}`);
  } else {
    failed += 1;
    console.log(`FAIL ${name}${extra ? ' — ' + extra : ''}`);
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitHealth() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return true;
    } catch { /* 未就绪继续等 */ }
    await sleep(200);
  }
  return false;
}

function startServer(extra = {}) {
  return spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      PASSWORD,
      JWT_SECRET,
      BASE_PATH: '/',
      LEDGER_ENABLED: 'true',
      LEDGER_DB: DB,
      LEDGER_BACKUP_DIR: BACKUP_DIR,
      LEDGER_AUTO_BACKUP_ON_IMPORT: 'true',
      LOGIN_LOG_DIR: path.join(TMP, 'login-log'),
      DRAFT_DIR: path.join(TMP, 'drafts'),
      TERMINAL_ENABLED: 'false',
      ...extra,
    },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
}

function stopServer(child) {
  if (!child || child.killed) return;
  try {
    child.kill('SIGTERM');
  } catch { /* 已退出 */ }
}

async function login() {
  const r = await fetch(`${BASE}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD }),
  });
  const cookie = (r.headers.get('set-cookie') || '').split(';')[0];
  return { status: r.status, headers: { Cookie: cookie } };
}

async function getJson(p, headers) {
  const r = await fetch(BASE + p, { headers });
  return { status: r.status, body: await r.json() };
}

(async () => {
  fs.mkdirSync(TMP, { recursive: true });
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'bank-ledger', 'ledger.db'), DB);

  let child = startServer();
  let H = {};
  try {
    ok('server health', await waitHealth());

    const unauth = await fetch(`${BASE}/api/ledger/transactions`);
    ok('unauth 401', unauth.status === 401, `status=${unauth.status}`);

    const lg = await login();
    H = lg.headers;
    ok('login cookie', lg.status === 200 && !!H.Cookie, `status=${lg.status}`);

    /* ---------- status / meta 基线 ---------- */
    const st = await getJson('/api/ledger/status', H);
    const s = st.body.stats || {};
    ok('status enabled/available', st.body.enabled === true && st.body.available === true);
    ok('status txnCount=1870', s.txnCount === 1870, `txnCount=${s.txnCount}`);
    ok('status 收支/账户/类别/规则',
      s.incomeCount === 194 && s.expenseCount === 1676 && s.accountCount === 4 &&
      s.categoryCount === 46 && s.ruleCount === 41,
      JSON.stringify({ i: s.incomeCount, e: s.expenseCount, a: s.accountCount, c: s.categoryCount, r: s.ruleCount }));
    ok('status locked=427 / pairs=71', s.lockedCount === 427 && s.transferPairs === 71,
      `locked=${s.lockedCount} pairs=${s.transferPairs}`);

    const meta = await getJson('/api/ledger/meta', H);
    ok('meta 4 卡 / 46 类', meta.body.accounts.length === 4 && meta.body.categories.length === 46);
    ok('meta years/months', meta.body.years.includes('2026') && meta.body.months.length === 10,
      `months=${meta.body.months.length}`);

    /* ---------- 明细查询 ---------- */
    const all = await getJson('/api/ledger/transactions?limit=5', H);
    ok('transactions 分页', all.body.rows.length === 5 && all.body.total === 1870,
      `rows=${all.body.rows.length} total=${all.body.total}`);
    ok('transactions 不含 memoRaw', all.body.rows.every((r) => !('memoRaw' in r) && !('memo_raw' in r)));

    const byCard = await getJson('/api/ledger/transactions?account=1&limit=5', H);
    ok('按卡筛选', byCard.body.total > 0 && byCard.body.rows.every((r) => r.accountNoMasked),
      `total=${byCard.body.total}`);
    const byMonth = await getJson('/api/ledger/transactions?year=2026&month=10&limit=5', H);
    ok('按年月筛选', byMonth.body.rows.every((r) => r.txnDate.startsWith('2026-10')),
      `total=${byMonth.body.total}`);
    // meta.months 返回 YYYY-MM：前端下拉直接提交该格式，后端必须识别，否则筛选会被静默忽略
    const byYearMonth = await getJson('/api/ledger/transactions?month=2026-10&limit=5', H);
    ok('YYYY-MM 月份筛选', byYearMonth.body.total === byMonth.body.total &&
      byYearMonth.body.rows.every((r) => r.txnDate.startsWith('2026-10')),
      `total=${byYearMonth.body.total} vs 两位数月份=${byMonth.body.total}`);

    // 用户实测复现的 URL：曾因后端旧进程静默忽略 YYYY-MM，返回 NET 全量里最新的 100 笔（全是 10 月）
    const repro = await getJson(
      '/api/ledger/transactions?year=2026&month=2026-08&scope=net&limit=100&offset=0', H
    );
    ok('复现 URL：YYYY-MM + year + NET 真正生效',
      repro.status === 200 && repro.body.rows.length === 100 &&
      repro.body.rows.every((r) => r.txnDate.startsWith('2026-08')) &&
      repro.body.total !== all.body.total,
      `total=${repro.body.total} 首行=${repro.body.rows[0] && repro.body.rows[0].txnDate}`);
    ok('响应回显生效筛选', !!repro.body.filters && repro.body.filters.month === '2026-08' &&
      repro.body.filters.year === '2026' && repro.body.filters.scope === 'net',
      `filters=${JSON.stringify(repro.body.filters)}`);
    const byTwoDigit = await getJson('/api/ledger/transactions?year=2026&month=8&scope=net&limit=5', H);
    ok('两位数月份与 YYYY-MM 口径一致', byTwoDigit.body.total === repro.body.total,
      `total=${byTwoDigit.body.total} vs ${repro.body.total}`);

    // 传了但无法识别的筛选值必须显式 400，绝不静默丢条件返回错误数据
    for (const [name, qs] of [
      ['非法月份', 'month=2026-99'],
      ['越界月份', 'month=13'],
      ['非法年份', 'year=20x6'],
      ['非法日期', 'day=2026-08'],
      ['非法方向', 'direction=BOTH'],
      ['非法口径', 'scope=gross'],
      ['非法域', 'domain=FOO'],
      ['非法账户', 'account=abc'],
    ]) {
      const r = await getJson('/api/ledger/transactions?' + qs + '&limit=1', H);
      ok(name + ' 明确 400', r.status === 400 && /无效筛选参数/.test(r.body.error || ''),
        `status=${r.status} error=${r.body.error}`);
    }
    const badReport = await getJson('/api/ledger/report?month=2026-99&limit=1', H);
    ok('报表同样拒绝非法筛选', badReport.status === 400, `status=${badReport.status}`);
    const allCompat = await getJson(
      '/api/ledger/transactions?month=all&year=ALL&scope=all&limit=1', H
    );
    ok('显式 all（含大小写）仍兼容', allCompat.status === 200 && allCompat.body.total === all.body.total,
      `status=${allCompat.status} total=${allCompat.body.total}`);
    const byDay = await getJson('/api/ledger/transactions?day=2026-10-01&limit=5', H);
    ok('按日筛选', byDay.body.rows.every((r) => r.txnDate === '2026-10-01'), `total=${byDay.body.total}`);
    const byCat = await getJson('/api/ledger/transactions?category=food.dining&limit=5', H);
    ok('按类别筛选', byCat.body.rows.every((r) => r.categoryCode === 'food.dining'),
      `total=${byCat.body.total}`);
    // 报表点击柱状图下钻：期间区间 + 收支方向 + NET 口径 + 按日期升序
    const drill = await getJson(
      '/api/ledger/transactions?from=2026-10-01&to=2026-10-31&direction=IN&scope=net&sort=txn_date&order=asc&limit=200',
      H
    );
    ok('下钻明细筛选', drill.body.rows.length > 0 && drill.body.rows.every(
      (r) => r.txnDate >= '2026-10-01' && r.txnDate <= '2026-10-31' && r.direction === 'IN'
    ), `rows=${drill.body.rows.length} total=${drill.body.total}`);
    const net = await getJson('/api/ledger/transactions?scope=net&limit=1', H);
    const allScope = await getJson('/api/ledger/transactions?scope=all&limit=1', H);
    ok('NET 剔除内部划转', net.body.total === 1728 && allScope.body.total === 1870,
      `net=${net.body.total} all=${allScope.body.total}`);

    const csvRes = await fetch(`${BASE}/api/ledger/transactions.csv?year=2026&month=10`, { headers: H });
    // Response.text() 会按 UTF-8 解码并吞掉 BOM，故直接看原始字节
    const csvBuf = Buffer.from(await csvRes.arrayBuffer());
    const csvText = csvBuf.toString('utf8');
    ok('CSV 导出 BOM+CRLF+表头',
      csvBuf[0] === 0xEF && csvBuf[1] === 0xBB && csvBuf[2] === 0xBF &&
      csvText.includes('\r\n') && csvText.includes('日期'));

    /* ---------- 报表 ---------- */
    const rp = await getJson('/api/ledger/report?dim=period&grain=month&scope=net', H);
    ok('报表按月 10 期', rp.body.rows.length === 10, `rows=${rp.body.rows.length}`);
    const rpAll = await getJson('/api/ledger/report?dim=period&grain=month&scope=all', H);
    ok('NET/ALL 净额相同',
      rp.body.totals.netCent === rpAll.body.totals.netCent &&
      rp.body.totals.incomeCent !== rpAll.body.totals.incomeCent,
      `net=${rp.body.totals.netCent} all=${rpAll.body.totals.netCent}`);
    const ry = await getJson('/api/ledger/report?dim=period&grain=year&scope=net', H);
    ok('报表按年', ry.body.rows.length === 1 && ry.body.rows[0].period === '2026');
    const rc = await getJson('/api/ledger/report?dim=category&scope=net&topN=5', H);
    ok('报表按类别 TopN', rc.body.rows.length === 5 && !!rc.body.rows[0].categoryCode);
    const rs = await getJson('/api/ledger/report?dim=share&scope=net', H);
    const pct = rs.body.rows.filter((r) => r.period === rs.body.rows[0].period)
      .reduce((a, r) => a + r.expensePct, 0);
    ok('报表占比合计≈100', Math.abs(pct - 100) < 1.5, `pct=${pct}`);
    const csvReport = await fetch(`${BASE}/api/ledger/report.csv?dim=period&grain=year`, { headers: H });
    ok('报表 CSV 导出', csvReport.status === 200 && (await csvReport.text()).includes('期间'));

    /* ---------- 类别改写 ---------- */
    const oneId = all.body.rows[0].txnId;
    const patch = await fetch(`${BASE}/api/ledger/classification`, {
      method: 'PATCH', headers: { ...H, 'content-type': 'application/json' },
      body: JSON.stringify({ txnIds: [oneId], categoryCode: 'food.dining' }),
    });
    const patched = await patch.json();
    ok('改类别返回 updated', patch.status === 200 && patched.updated === 1, JSON.stringify(patched));
    const changed = await getJson(`/api/ledger/transactions?q=&limit=2000`, H);
    const row = changed.body.rows.find((r) => r.txnId === oneId);
    ok('改类别生效 locked=1', row && row.categoryCode === 'food.dining' && row.locked === 1 && row.source === 'manual');

    /* ---------- 备份（导入前，1870 笔） ---------- */
    const b1Res = await fetch(`${BASE}/api/ledger/db/backup`, {
      method: 'POST', headers: { ...H, 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'manual' }),
    });
    const b1 = (await b1Res.json()).backup;
    ok('创建备份', b1Res.status === 200 && b1 && b1.txnCount === 1870, JSON.stringify(b1 && b1.name));
    const list1 = await getJson('/api/ledger/db/backups', H);
    ok('备份列表含新快照', list1.body.backups.some((b) => b.name === b1.name));
    const dl = await fetch(`${BASE}/api/ledger/db/backup?name=${encodeURIComponent(b1.name)}`, { headers: H });
    const dlBuf = Buffer.from(await dl.arrayBuffer());
    ok('下载备份是 SQLite', dl.status === 200 && dlBuf.slice(0, 15).toString('latin1') === 'SQLite format 3',
      `bytes=${dlBuf.length}`);
    const cur = await fetch(`${BASE}/api/ledger/db/current.db`, { headers: H });
    const curBuf = Buffer.from(await cur.arrayBuffer());
    ok('下载当前库快照', cur.status === 200 && curBuf.slice(0, 15).toString('latin1') === 'SQLite format 3',
      `bytes=${curBuf.length}`);
    const info = await getJson('/api/ledger/db/info', H);
    ok('db/info', info.body.txnCount === 1870 && info.body.backupCount >= 1,
      `txn=${info.body.txnCount} backups=${info.body.backupCount}`);

    /* ---------- 两步式增量导入 ---------- */
    // 上面的「类别改写」测试本身新增了 1 条 locked=1 标注，故以当前值为基线
    const lockedBefore = (await getJson('/api/ledger/status', H)).body.stats.lockedCount;
    const srcName = 'CMB_6225--------4161_20260101_20261031.csv';
    const raw = fs.readFileSync(path.join(ROOT, 'bank-ledger', srcName), 'utf8');
    const modified = raw.replace('深圳电信实时扣费', '深圳电信实时扣费TEST');
    const newName = 'CMB_6225--------4161_20260101_20261031-increment.csv';

    const prev = await fetch(`${BASE}/api/ledger/import/preview`, {
      method: 'POST', headers: { ...H, 'content-type': 'application/json' },
      body: JSON.stringify({ filename: newName, text: modified }),
    });
    const pv = await prev.json();
    ok('preview 解析 26 行', prev.status === 200 && pv.rowCount === 26, `status=${prev.status} rows=${pv.rowCount}`);
    ok('preview 去重状态 new=1/exists=25',
      pv.counts.new === 1 && pv.counts.exists === 25 && pv.counts.conflict === 0,
      JSON.stringify(pv.counts));
    ok('preview 不含 memoRaw', pv.rows.every((r) => !('memoRaw' in r)));
    const newRow = pv.rows.find((r) => r.status === 'new');
    ok('preview 标出新增行', !!newRow && !!newRow.rowHash);

    const cm = await fetch(`${BASE}/api/ledger/import/commit`, {
      method: 'POST', headers: { ...H, 'content-type': 'application/json' },
      body: JSON.stringify({ filename: newName, text: modified, selected: [newRow.rowHash] }),
    });
    const commit = await cm.json();
    ok('commit 只插入选中行', cm.status === 200 && commit.inserted === 1 && commit.skipped === 25,
      JSON.stringify({ inserted: commit.inserted, skipped: commit.skipped }));
    ok('commit 自动快照', !!commit.autoBackup && commit.autoBackup.kind === 'auto-before-import',
      JSON.stringify(commit.autoBackup && commit.autoBackup.name));
    ok('commit txnCount=1871', commit.stats.txnCount === 1871, `txnCount=${commit.stats.txnCount}`);
    const st2 = await getJson('/api/ledger/status', H);
    ok('导入后人工标注未被覆盖', st2.body.stats.lockedCount === lockedBefore,
      `before=${lockedBefore} after=${st2.body.stats.lockedCount}`);

    const cm2 = await fetch(`${BASE}/api/ledger/import/commit`, {
      method: 'POST', headers: { ...H, 'content-type': 'application/json' },
      body: JSON.stringify({ filename: newName, text: modified, selected: [newRow.rowHash] }),
    });
    const commit2 = await cm2.json();
    ok('重复提交零新增', cm2.status === 200 && commit2.inserted === 0, `inserted=${commit2.inserted}`);
    const batches = await getJson('/api/ledger/import/batches?limit=5', H);
    ok('导入批次记录', batches.body.batches.length >= 1 &&
      String(batches.body.batches[0].message || '').includes('partial-import'));

    /* ---------- 恢复往返（1871 → 1870 → 1871） ---------- */
    const restore1 = await fetch(`${BASE}/api/ledger/db/restore`, {
      method: 'POST', headers: { ...H, 'content-type': 'application/json' },
      body: JSON.stringify({ name: b1.name, confirm: true }),
    });
    const r1 = await restore1.json();
    ok('恢复到导入前备份', restore1.status === 200 && r1.txnCount === 1870,
      `status=${restore1.status} txn=${r1.txnCount} err=${r1.error || ''}`);
    ok('恢复生成安全快照', !!r1.preRestoreBackup &&
      r1.preRestoreBackup.kind === 'auto-before-restore' &&
      r1.preRestoreBackup.txnCount === 1871,
      JSON.stringify(r1.preRestoreBackup && r1.preRestoreBackup.name));

    const restore2 = await fetch(`${BASE}/api/ledger/db/restore`, {
      method: 'POST', headers: { ...H, 'content-type': 'application/json' },
      body: JSON.stringify({ name: r1.preRestoreBackup.name, confirm: true }),
    });
    const r2 = await restore2.json();
    ok('用安全快照撤销恢复（往返）', restore2.status === 200 && r2.txnCount === 1871,
      `status=${restore2.status} txn=${r2.txnCount} err=${r2.error || ''}`);
    const st3 = await getJson('/api/ledger/status', H);
    ok('往返后 locked/划转完整',
      st3.body.stats.lockedCount === lockedBefore && st3.body.stats.transferPairs === 71,
      `locked=${st3.body.stats.lockedCount} pairs=${st3.body.stats.transferPairs}`);
    const metaAfter = await getJson('/api/ledger/meta', H);
    ok('恢复后 meta 可读', metaAfter.status === 200 && metaAfter.body.accounts.length === 4);

    /* ---------- 安全边界 ---------- */
    const badUpload = await fetch(`${BASE}/api/ledger/db/restore?upload=1`, {
      method: 'POST', headers: { ...H, 'content-type': 'application/octet-stream' },
      body: Buffer.from('this is definitely not a sqlite database'),
    });
    ok('非法上传被拒绝', badUpload.status === 400, `status=${badUpload.status}`);
    const st4 = await getJson('/api/ledger/status', H);
    ok('非法上传后数据不变', st4.body.stats.txnCount === 1871, `txn=${st4.body.stats.txnCount}`);

    const traversal = await fetch(`${BASE}/api/ledger/db/backup?name=..%2Fledger.db`, { headers: H });
    ok('路径穿越被拒绝', traversal.status === 400, `status=${traversal.status}`);

    const delSafety = await fetch(
      `${BASE}/api/ledger/db/backup?name=${encodeURIComponent(r1.preRestoreBackup.name)}`,
      { method: 'DELETE', headers: H }
    );
    ok('安全快照禁止删除', delSafety.status === 403, `status=${delSafety.status}`);

    const delManual = await fetch(`${BASE}/api/ledger/db/backup?name=${encodeURIComponent(b1.name)}`,
      { method: 'DELETE', headers: H });
    ok('普通备份可删除', delManual.status === 200, `status=${delManual.status}`);

    const noConfirm = await fetch(`${BASE}/api/ledger/db/restore`, {
      method: 'POST', headers: { ...H, 'content-type': 'application/json' },
      body: JSON.stringify({ name: b1.name }),
    });
    ok('恢复缺 confirm 被拒绝', noConfirm.status === 400, `status=${noConfirm.status}`);

    /* ---------- 降级：LEDGER_ENABLED=false ---------- */
    stopServer(child);
    await sleep(700);
    child = startServer({ LEDGER_ENABLED: 'false' });
    ok('禁用后服务仍健康', await waitHealth());
    const lg2 = await login();
    H = lg2.headers;
    const stOff = await getJson('/api/ledger/status', H);
    ok('禁用时 status 恒 200 + enabled=false',
      stOff.status === 200 && stOff.body.enabled === false, JSON.stringify(stOff.body.enabled));
    const offTxn = await getJson('/api/ledger/transactions', H);
    ok('禁用时其它端点 503', offTxn.status === 503, `status=${offTxn.status}`);
  } catch (e) {
    failed += 1;
    console.error('FAIL 测试执行异常:', e);
  } finally {
    stopServer(child);
    await sleep(300);
    try {
      fs.rmSync(TMP, { recursive: true, force: true });
    } catch { /* 临时目录清理失败不影响结果 */ }
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  }
})().catch((e) => {
  console.error('测试执行失败:', e);
  process.exit(1);
});
