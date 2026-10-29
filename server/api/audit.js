/**
 * 登录审计日志（AuditApp 数据源）：记录与登录相关的操作（登录成功 / 失败、登出、
 * 受保护接口 401 未授权访问），按本地日期分文件落盘为 JSONL，并支持按范围读取、
 * 聚合统计与 CSV 导出。
 *
 * 设计要点（为什么这么写）：
 *  - 写入与认证解耦：所有 log* 调用都是 fire-and-forget，落盘失败只 [warn] 一次，
 *    绝不能因为「日志写不了」把登录流程搞挂（与 ttyd 后台模块同一条原则）。
 *  - 401 去重：前端页面级共享轮询（monitorPoll / dockerPoll / printerPoll）在会话失效后
 *    会每 5s 持续 401，逐条落盘会瞬间打爆磁盘、淹没真实撞库信号。策略：同 IP + 同路径
 *    在 LOGIN_LOG_401_DEDUPE_SEC 窗口内合并为一条（count 记次数），窗口结束 / 读取前 /
 *    进程退出前落盘。登录失败**不合并**——每次尝试都是独立事实。
 *  - 读取守卫：单日文件只读尾部 8MB、总解析条数上限 LOGIN_LOG_MAX_ENTRIES，
 *    防异常大日志撑爆内存；命中上限返回 truncated。
 *  - 脱敏：只记录请求元信息，绝不记录密码、Cookie、Authorization 等凭据。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { cfg } = require('../config');
const { send } = require('../lib/http');
const { DATA_DIR } = require('../lib/userdata');

const FILE_RE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;
const TAIL_BYTES = 8 * 1024 * 1024; // 单日文件读取上限（只取尾部）
const DAY_MS = 24 * 60 * 60 * 1000;

/* ---------------- 路径与日期 ---------------- */

let cachedDir = null;
/** 审计目录：LOGIN_LOG_DIR（支持 ~ 前缀）优先，留空则与 data.json 同级的 login-log/ */
function auditDir() {
  if (cachedDir) return cachedDir;
  const raw = String(cfg.audit.dir || '').trim();
  if (!raw) cachedDir = path.join(DATA_DIR, 'login-log');
  else if (raw === '~') cachedDir = path.join(os.homedir(), 'login-log');
  else if (raw.startsWith('~/')) cachedDir = path.join(os.homedir(), raw.slice(2));
  else cachedDir = path.resolve(raw);
  return cachedDir;
}

/** 本地日期键 YYYY-MM-DD（按用户本地日期分文件；不能用 toISOString 的 UTC 日期） */
function dayKey(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 相对今天偏移 days 天的日期键（用 Date 而非纯毫秒差，规避夏令时导致的日期漂移） */
function shiftDay(offset) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + offset);
  return dayKey(d.getTime());
}

/* ---------------- 写入 ---------------- */

let writeChain = Promise.resolve(); // 串行队列：并发 append 不交叉
let writeWarned = false; // 只在首次失败时打印，避免刷屏
let writeError = ''; // 最近一次写入失败原因（GET 时回传，面板可展示）
let lastCleanupDay = ''; // 每天最多清理一次过期文件

/** 记录写入失败：不抛错（调用方是鉴权路径，绝不能因此中断登录） */
function warnWrite(err) {
  writeError = String((err && err.message) || err || 'unknown');
  if (writeWarned) return;
  writeWarned = true;
  console.warn('[warn] 登录审计日志写入失败（不影响登录流程）:', writeError, `dir=${auditDir()}`);
}

/** 删除超过保留期的日文件；任何失败都只影响清理本身 */
function cleanupRetention() {
  const dir = auditDir();
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch (e) {
    warnWrite(e);
    return;
  }
  const cutoff = shiftDay(-(cfg.audit.retentionDays - 1));
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    const m = FILE_RE.exec(name);
    if (!m || m[1] >= cutoff) continue;
    try {
      fs.unlinkSync(path.join(dir, name));
    } catch {
      /* 删除失败（被占用等）不影响新日志写入 */
    }
  }
}

/** 跨天 / 启动时各触发一次清理，避免每次 append 都 readdir */
function maybeCleanup(today) {
  if (lastCleanupDay === today) return;
  lastCleanupDay = today;
  cleanupRetention();
}

/** 异步追加一条记录（串行队列 + 单文件当日 JSONL） */
function append(entry) {
  const file = path.join(auditDir(), dayKey(entry.t) + '.jsonl');
  const line = JSON.stringify(entry) + '\n';
  writeChain = writeChain
    .then(() => fs.promises.appendFile(file, line, { mode: 0o600 }))
    .then(() => {
      writeError = '';
    })
    .catch(warnWrite);
  maybeCleanup(dayKey(Date.now()));
  return writeChain;
}

/** 同步追加（仅进程退出时用：异步写来不及落盘） */
function appendSync(entry) {
  const file = path.join(auditDir(), dayKey(entry.t) + '.jsonl');
  try {
    fs.appendFileSync(file, JSON.stringify(entry) + '\n', { mode: 0o600 });
  } catch (e) {
    warnWrite(e);
  }
}

/* ---------------- 记录构造 ---------------- */

/** 清洗字符串：剥控制字符（换行会把一条记录劈成两行，破坏 JSONL）并截断 */
function cleanText(v, max) {
  return String(v == null ? '' : v)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .slice(0, max);
}

/** 去掉 IPv4-mapped IPv6 前缀，保证同一客户端在分析里归并为同一来源 */
function normalizeIp(v) {
  const s = String(v || '').trim();
  return s.startsWith('::ffff:') ? s.slice(7) : s;
}

/**
 * 客户端来源：反代部署下真实客户端在 X-Forwarded-For 首段，直连地址另存 remoteIp。
 * 两条都保留，分析口径以 ip（首段优先）为准，排障时可回溯。
 */
function clientInfo(req) {
  const rawXff = req.headers && req.headers['x-forwarded-for'];
  const xff = cleanText(Array.isArray(rawXff) ? rawXff.join(',') : rawXff || '', 200);
  const remoteIp = normalizeIp(req.socket && req.socket.remoteAddress);
  const ip = normalizeIp(xff.split(',')[0]) || remoteIp;
  return { ip, remoteIp, xff };
}

function baseEntry(req, extra) {
  const c = clientInfo(req);
  return Object.assign(
    {
      t: Date.now(),
      type: 'login',
      ok: false,
      reason: '',
      ip: c.ip,
      remoteIp: c.remoteIp,
      xff: c.xff,
      ua: cleanText(req.headers && req.headers['user-agent'], 256),
      path: cleanText(String(req.url || '').split('?')[0], 200),
      status: 0,
    },
    extra || {}
  );
}

/* ---------------- 对外记录接口 ---------------- */

/** 登录事件：ok=true 成功，ok=false 失败（reason: bad-password / bad-body…，绝不含凭据） */
function logLogin(req, { ok, reason, status, durationMs }) {
  if (!cfg.audit.enabled) return;
  append(
    baseEntry(req, {
      type: 'login',
      ok: !!ok,
      reason: cleanText(reason || (ok ? 'ok' : 'failed'), 60),
      status,
      durationMs,
    })
  );
}

/** 登出事件（仅在 checkAuth 通过后记录，避免未授权请求伪造登出日志） */
function logLogout(req) {
  if (!cfg.audit.enabled) return;
  append(baseEntry(req, { type: 'logout', ok: true, reason: 'logout', status: 200 }));
}

/** 待合并的 401：key(ip|path) → { entry, count, lastSeen, timer } */
const pending401 = new Map();

/** 落盘并移除一个合并槽 */
function flushKey(key, sync) {
  const rec = pending401.get(key);
  if (!rec) return;
  pending401.delete(key);
  if (rec.timer) clearTimeout(rec.timer);
  const entry = Object.assign({}, rec.entry, { count: rec.count, lastSeen: rec.lastSeen });
  if (sync) appendSync(entry);
  else append(entry);
}

/**
 * 未授权访问（受保护接口 401 / WS 升级被拒）。
 * 同 IP + 同路径在去重窗口内只落一条，count 记累计次数——既防日志风暴，又保留「被持续探测」的量级信号。
 */
function logUnauthorized(req) {
  if (!cfg.audit.enabled) return;
  const winMs = cfg.audit.dedupeSec * 1000;
  const entry = baseEntry(req, { type: 'unauthorized', ok: false, reason: 'unauthorized', status: 401 });
  if (winMs <= 0) {
    append(entry);
    return;
  }
  const key = `${entry.ip}|${entry.path}`;
  const cur = pending401.get(key);
  if (cur) {
    cur.count += 1;
    cur.lastSeen = entry.t;
    return;
  }
  const rec = { entry, count: 1, lastSeen: entry.t, timer: null };
  rec.timer = setTimeout(() => flushKey(key, false), winMs);
  // 定时器不得拖住进程退出（退出路径由 flushPending(true) 显式同步落盘）
  if (typeof rec.timer.unref === 'function') rec.timer.unref();
  pending401.set(key, rec);
}

/**
 * 落盘所有待合并的 401 计数。
 * sync=true 用于进程退出（异步队列来不及跑完）；读取前也应调用，避免面板看不到最新探测。
 */
function flushPending(sync) {
  for (const key of [...pending401.keys()]) flushKey(key, !!sync);
}

/** 启动：建目录 + 清理过期文件 + 打一行启用日志（失败不影响主服务） */
function startAudit() {
  if (!cfg.audit.enabled) return;
  try {
    fs.mkdirSync(auditDir(), { recursive: true, mode: 0o700 });
  } catch (e) {
    warnWrite(e);
    return;
  }
  cleanupRetention();
  console.log(`[audit] 登录审计日志已启用：${auditDir()}（保留 ${cfg.audit.retentionDays} 天）`);
}

/* ---------------- 读取 ---------------- */

/** 目录下的日文件名（升序；不存在/不可读返回空） */
function listLogFiles(dir) {
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .map((n) => {
      const m = FILE_RE.exec(n);
      return m ? m[1] : null;
    })
    .filter(Boolean)
    .sort();
}

/** 读文件：超过上限时只取尾部，并丢弃被截断的首行 */
function readFileTail(file) {
  let st = null;
  try {
    st = fs.statSync(file);
  } catch {
    return '';
  }
  if (st.size <= TAIL_BYTES) {
    try {
      return fs.readFileSync(file, 'utf8');
    } catch {
      return '';
    }
  }
  let fd = null;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(TAIL_BYTES);
    fs.readSync(fd, buf, 0, TAIL_BYTES, st.size - TAIL_BYTES);
    const txt = buf.toString('utf8');
    const nl = txt.indexOf('\n');
    return nl >= 0 ? txt.slice(nl + 1) : txt;
  } catch {
    return '';
  } finally {
    if (fd != null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* 已关闭 */
      }
    }
  }
}

/** 单行 → 事件对象（宽松容错：坏行 / 缺字段一律丢弃或取默认值，不抛错） */
function parseLine(line) {
  if (!line) return null;
  let o = null;
  try {
    o = JSON.parse(line);
  } catch {
    return null;
  }
  if (!o || typeof o !== 'object') return null;
  const t = Number(o.t);
  if (!Number.isFinite(t) || t <= 0) return null;
  const count = Number(o.count);
  const status = Number(o.status);
  const durationMs = Number(o.durationMs);
  return {
    t,
    type: o.type === 'logout' || o.type === 'unauthorized' ? o.type : 'login',
    ok: o.ok === true,
    reason: typeof o.reason === 'string' ? o.reason : '',
    ip: typeof o.ip === 'string' ? o.ip : '',
    remoteIp: typeof o.remoteIp === 'string' ? o.remoteIp : '',
    ua: typeof o.ua === 'string' ? o.ua : '',
    path: typeof o.path === 'string' ? o.path : '',
    status: Number.isFinite(status) ? status : 0,
    durationMs: Number.isFinite(durationMs) ? durationMs : undefined,
    count: Number.isFinite(count) && count > 0 ? count : 1,
    lastSeen: Number.isFinite(Number(o.lastSeen)) ? Number(o.lastSeen) : t,
  };
}

/**
 * 按天范围读取原始事件（结果按时间倒序）。
 * days<=0 表示「全部保留期」；从最新文件往前读，命中条数上限时保留的必然是最新数据。
 */
function readEntries(days, maxEntries) {
  const dir = auditDir();
  const cutoff = days > 0 ? shiftDay(-(days - 1)) : '';
  const files = listLogFiles(dir)
    .filter((d) => !cutoff || d >= cutoff)
    .reverse();
  const entries = [];
  let truncated = false;
  for (const day of files) {
    const txt = readFileTail(path.join(dir, day + '.jsonl'));
    if (!txt) continue;
    for (const line of txt.split('\n')) {
      const e = parseLine(line);
      if (!e) continue;
      entries.push(e);
      if (entries.length >= maxEntries) {
        truncated = true;
        break;
      }
    }
    if (truncated) break;
  }
  entries.sort((a, b) => b.t - a.t);
  return { entries, truncated };
}

/* ---------------- 过滤与统计 ---------------- */

function filterEntries(entries, { type, ok, ip }) {
  const ipq = String(ip || '').trim().toLowerCase();
  return entries.filter((e) => {
    if (type && type !== 'all' && e.type !== type) return false;
    if (ok === 'success' && !e.ok) return false;
    if (ok === 'failure' && e.ok) return false;
    if (ipq && !e.ip.toLowerCase().includes(ipq) && !e.remoteIp.toLowerCase().includes(ipq)) return false;
    return true;
  });
}

/**
 * 疑似暴力破解：同一 IP 的登录失败在滑动窗口内达到 threshold 次。
 * 取该 IP 命中次数最多的那个窗口作为代表（比「最近一个窗口」更能说明攻击强度）。
 */
function detectBruteForce(entries, threshold, windowMs) {
  const byIp = new Map();
  for (const e of entries) {
    if (e.type !== 'login' || e.ok || !e.ip) continue;
    const arr = byIp.get(e.ip) || [];
    arr.push(e.t);
    byIp.set(e.ip, arr);
  }
  const out = [];
  for (const [ip, arr] of byIp) {
    arr.sort((a, b) => a - b);
    let best = 0;
    let bestStart = 0;
    let bestEnd = 0;
    let i = 0;
    for (let j = 0; j < arr.length; j += 1) {
      while (arr[j] - arr[i] > windowMs) i += 1;
      const n = j - i + 1;
      if (n > best) {
        best = n;
        bestStart = arr[i];
        bestEnd = arr[j];
      }
    }
    if (best >= threshold) out.push({ ip, count: best, firstSeen: bestStart, lastSeen: bestEnd });
  }
  return out.sort((a, b) => b.count - a.count).slice(0, 10);
}

/** 聚合统计（一次遍历；count 为 401 合并次数，登录事件恒为 1） */
function buildStats(entries, { threshold, windowMs }) {
  const byDay = new Map();
  const byHour = Array.from({ length: 24 }, () => ({ success: 0, failures: 0 }));
  const sources = new Map();
  let success = 0;
  let failures = 0;
  let unauthorized = 0;

  for (const e of entries) {
    const n = e.count || 1;
    const field = e.ok ? 'success' : 'failures';
    if (e.type === 'unauthorized') unauthorized += n;
    if (e.ok) success += n;
    else failures += n;

    const day = dayKey(e.t);
    const d = byDay.get(day) || { success: 0, failures: 0 };
    d[field] += n;
    byDay.set(day, d);

    byHour[new Date(e.t).getHours()][field] += n;

    const key = e.ip || 'unknown';
    const s = sources.get(key) || { ip: key, total: 0, failures: 0, firstSeen: e.t, lastSeen: e.t };
    s.total += n;
    if (!e.ok) s.failures += n;
    s.firstSeen = Math.min(s.firstSeen, e.t);
    s.lastSeen = Math.max(s.lastSeen, e.lastSeen || e.t);
    sources.set(key, s);
  }

  const total = success + failures;
  const sourceList = [...sources.values()].sort((a, b) => b.total - a.total);
  const now = Date.now();

  return {
    total,
    success,
    failures,
    failureRate: total ? Math.round((failures / total) * 1000) / 10 : 0,
    unauthorized,
    sources: sourceList.length,
    byDay: [...byDay.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([day, v]) => ({ day, success: v.success, failures: v.failures })),
    byHour: byHour.map((v, hour) => ({ hour, success: v.success, failures: v.failures })),
    topSources: sourceList.slice(0, 10),
    recentFailures: entries.filter((e) => !e.ok).slice(0, 20),
    anomalies: {
      bruteForce: detectBruteForce(entries, threshold, windowMs),
      // 陌生来源：在所选范围内首次出现于最近 24 小时（范围外的历史不参与，口径见文档）
      newSources: sourceList
        .filter((s) => s.firstSeen >= now - DAY_MS)
        .sort((a, b) => b.firstSeen - a.firstSeen)
        .slice(0, 10)
        .map((s) => ({ ip: s.ip, firstSeen: s.firstSeen })),
    },
  };
}

/* ---------------- 路由 ---------------- */

const TYPES = ['all', 'login', 'logout', 'unauthorized'];
const RESULTS = ['all', 'success', 'failure'];

/** 解析查询参数（客户端输入一律收敛，不参与任何文件路径拼接） */
function parseQuery(url) {
  const q = url.searchParams;
  const daysRaw = q.get('days');
  let days;
  if (daysRaw == null || daysRaw === '') days = 7;
  else {
    const n = parseInt(daysRaw, 10);
    days = Number.isFinite(n) && n > 0 ? Math.min(n, cfg.audit.retentionDays) : 0;
  }
  let limit = parseInt(q.get('limit') || '200', 10);
  if (!Number.isFinite(limit) || limit < 1) limit = 200;
  limit = Math.min(limit, 2000);
  const type = TYPES.includes(q.get('type') || '') ? q.get('type') : 'all';
  const ok = RESULTS.includes(q.get('ok') || '') ? q.get('ok') : 'all';
  return { days, limit, type, ok, ip: cleanText(q.get('ip') || '', 64) };
}

/** 读取 + 过滤（读取前先 flush 未合并的 401 计数） */
function collect(params) {
  flushPending(false);
  const { entries, truncated } = readEntries(params.days, cfg.audit.maxEntries);
  return { entries: filterEntries(entries, params), truncated };
}

function buildPayload(params) {
  const { entries, truncated } = collect(params);
  const stats = buildStats(entries, {
    threshold: cfg.audit.bruteThreshold,
    windowMs: cfg.audit.bruteWindowMinutes * 60000,
  });
  return {
    enabled: true,
    error: writeError || undefined,
    entries: entries.slice(0, params.limit),
    stats,
    meta: {
      retentionDays: cfg.audit.retentionDays,
      days: params.days,
      limit: params.limit,
      truncated,
      dir: auditDir(),
      generatedAt: Date.now(),
      // 判定参数随响应下发：前端异常条目文案要写清「多少次 / 多长时间内」，避免文案与配置脱节
      bruteWindowMinutes: cfg.audit.bruteWindowMinutes,
      bruteThreshold: cfg.audit.bruteThreshold,
    },
  };
}

/** CSV 单元格：转义逗号/引号/换行，并对 = + - @ 开头加 ' 前缀（防 Excel 公式注入） */
function csvCell(v) {
  let s = v == null ? '' : String(v);
  s = s.replace(/\r?\n/g, ' ');
  if (/^[=+\-@\t]/.test(s)) s = `'${s}`;
  if (/[",]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

function fmtTime(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  );
}

/** 导出当前筛选的全部结果（不受 limit 影响），带 BOM 便于 Excel 正确识别中文 */
function buildCsv(params) {
  const { entries } = collect(params);
  const head = [
    'Time',
    'Event',
    'Result',
    'Reason',
    'Source IP',
    'Remote IP',
    'Path',
    'Status',
    'Duration (ms)',
    'Count',
    'Client',
  ];
  const rows = entries.map((e) => [
    fmtTime(e.t),
    e.type,
    e.ok ? 'success' : 'failure',
    e.reason,
    e.ip,
    e.remoteIp,
    e.path,
    e.status,
    e.durationMs == null ? '' : e.durationMs,
    e.count || 1,
    e.ua,
  ]);
  return `\uFEFF${[head, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n')}\r\n`;
}

/** /api/audit/* 子路由（鉴权由上层 router.js 统一完成） */
function auditRoute(req, res, p, url) {
  if (req.method !== 'GET') return send(res, 404, { error: 'not found' });
  const params = parseQuery(url);
  if (p === '/api/audit/login-log') {
    // 未启用是「信息性」状态，返回 200 + enabled:false，便于前端区分「未开启」与「服务异常」
    if (!cfg.audit.enabled) {
      return send(res, 200, {
        enabled: false,
        error: 'Login audit disabled',
        entries: [],
        stats: buildStats([], { threshold: cfg.audit.bruteThreshold, windowMs: 0 }),
        meta: {
          retentionDays: cfg.audit.retentionDays,
          days: params.days,
          limit: params.limit,
          truncated: false,
          dir: '',
          generatedAt: Date.now(),
          bruteWindowMinutes: cfg.audit.bruteWindowMinutes,
          bruteThreshold: cfg.audit.bruteThreshold,
        },
      });
    }
    return send(res, 200, buildPayload(params));
  }
  if (p === '/api/audit/login-log.csv') {
    if (!cfg.audit.enabled) return send(res, 503, { error: 'Login audit disabled' });
    return send(res, 200, buildCsv(params), {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="login-log-${dayKey(Date.now())}.csv"`,
    });
  }
  return send(res, 404, { error: 'not found' });
}

module.exports = {
  auditRoute,
  startAudit,
  flushPending,
  logLogin,
  logLogout,
  logUnauthorized,
  auditDir,
};
