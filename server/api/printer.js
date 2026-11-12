/**
 * Printer 模块（打印机监控数据源）：基于 CUPS 自带命令（ipptool / lpinfo）的零依赖采集。
 * 数据源说明（原 server.js 877-888 行注释，原样保留）：
 *  - CUPS-Get-Printers（ipptool）：打印机列表 + 状态（idle/processing/stopped）、
 *    printer-state-reasons（缺纸/卡纸等）、device-uri（含 usb:// 即配置为 USB 连接）
 *  - Get-Jobs（ipptool，带 requesting-user-name 才返回 job-name/user/host，
 *    否则匿名请求会被 CUPS 以 Unknown/Withheld 隐藏）：
 *      which-jobs=not-completed → 打印中队列
 *      which-jobs=completed     → 打印历史
 *    属性：job-name（文档名）、job-originating-user-name（用户）、
 *    job-originating-host-name（发起打印的设备 IP）、time-at-creation/completed、job-k-octets
 *  - USB 链路（printer.link）：默认读 /sys/bus/usb/devices 判断设备是否在位（毫秒级、无副作用），
 *    探测手段不可读时才回退 lpinfo -v（会拉起全部 CUPS backend 枚举，并让 usb 后端卸载/重挂
 *    内核 usblp 驱动，因此不再放在常规采集路径上）
 *  - 打印能力（printer.ready）：由 CUPS 的 printer-state / printer-state-reasons 推导，
 *    与链路层解耦——「线插着但队列暂停/缺纸/离线」各不相同
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { cfg } = require('../config');
const { runCmd } = require('../lib/http');
const { fsResolve, fsAllowed } = require('./fs');

const IPP_TESTS = {
  printers: {
    op: 'CUPS-Get-Printers',
    uri: 'ipp://localhost/',
    attrs:
      'printer-name,printer-state,printer-state-reasons,printer-state-message,' +
      'printer-is-accepting-jobs,printer-make-and-model,device-uri,queued-job-count',
  },
  jobsActive: {
    op: 'Get-Jobs',
    extra: ['ATTR keyword which-jobs not-completed'],
    attrs:
      'job-id,job-name,job-printer-uri,job-originating-user-name,job-originating-host-name,' +
      'job-state,job-k-octets,time-at-creation,time-at-completed',
  },
  jobsDone: {
    op: 'Get-Jobs',
    extra: ['ATTR keyword which-jobs completed'],
    attrs:
      'job-id,job-name,job-printer-uri,job-originating-user-name,job-originating-host-name,' +
      'job-state,job-k-octets,time-at-creation,time-at-completed',
  },
};

/* 启动时把 ipptool 测试文件写到系统临时目录（内容固定，多实例可共用同名文件） */
function ippTestFile(key) {
  const spec = IPP_TESTS[key];
  const fp = path.join(os.tmpdir(), `watchdog-ipp-${key}.test`);
  try {
    fs.writeFileSync(
      fp,
      `{\n  OPERATION ${spec.op}\n  GROUP operation-attributes-tag\n` +
        `  ATTR charset attributes-charset utf-8\n` +
        `  ATTR language attributes-natural-language en\n` +
        // Get-Jobs 需要 printer-uri 操作属性（由命令行 URI 注入）；CUPS-Get-Printers 则针对服务器整体
        (spec.op === 'Get-Jobs' ? `  ATTR uri printer-uri $uri\n` : '') +
        `  ATTR name requesting-user-name root\n` +
        (spec.extra ? spec.extra.map((l) => `  ${l}\n`).join('') : '') +
        `  ATTR keyword requested-attributes ${spec.attrs}\n}\n`,
      'utf8'
    );
  } catch { /* 写入失败时 ipptool 调用会报错并体现为 unavailable */ }
  return fp;
}
const IPP_TEST_FILES = {};
for (const k of Object.keys(IPP_TESTS)) IPP_TEST_FILES[k] = ippTestFile(k);

/** 解析 ipptool -tv 输出：仅取 [PASS]/[FAIL] 行之后的属性段，
 *  `-- separator --`（可能带缩进）分隔多个 printer/job，属性行格式为 "name (type) = value" */
function parseIppTool(out) {
  const nl = out.indexOf('\n', out.indexOf('[PASS]') >= 0 ? out.indexOf('[PASS]') : 0);
  if (nl < 0) return [];
  const groups = [{}];
  for (const line of out.slice(nl + 1).split('\n')) {
    if (line.trim() === '-- separator --') {
      groups.push({});
      continue;
    }
    const m = line.match(/^\s+([a-zA-Z][\w-]*) \([^)]+\) = ?(.*)$/);
    if (m) groups[groups.length - 1][m[1]] = m[2];
  }
  return groups;
}

/** 打印机/任务状态枚举 → 文案 */
const IPP_PRINTER_STATES = { 3: 'idle', 4: 'processing', 5: 'stopped' };

/* ================= 链路探测：USB 走 sysfs，失败才回退 lpinfo ================= */

const USB_SYSFS_DIR = '/sys/bus/usb/devices';
/** 探测方式：auto = sysfs 优先、不可读才回退 lpinfo；sysfs = 只用 sysfs；lpinfo = 旧行为 */
const PROBE_MODES = new Set(['auto', 'sysfs', 'lpinfo']);
/** CUPS 的 printer-state-reasons 里「需要人处理」的原因码 → ready=error */
const ERROR_REASONS = new Set([
  'media-jam',
  'media-empty',
  'media-needed',
  'media-low',
  'toner-empty',
  'toner-low',
  'marker-supply-empty',
  'marker-supply-low',
  'cover-open',
  'door-open',
  'input-tray-missing',
  'output-area-full',
]);
/** 链路状态历史：printerName → { state, since, lastSeen }。进程内状态，服务重启后 since 重新计时 */
const linkHistory = new Map();

/** device-uri → 连接方式 */
function transportOf(uri) {
  if (!uri) return 'other';
  if (uri.startsWith('usb://')) return 'usb';
  return /^(ipp|ipps|dnssd|socket|lpd|http|https):\/\//.test(uri) ? 'network' : 'other';
}

/** 从 device-uri 的 ?serial= 取序列号（URI 中可能是百分号编码） */
function uriSerial(uri) {
  const m = /[?&]serial=([^&]*)/i.exec(uri || '');
  if (!m) return '';
  try {
    return decodeURIComponent(m[1]).trim();
  } catch {
    return m[1].trim();
  }
}

/** 读 sysfs 文本；设备在枚举与读取之间被拔掉时返回空串，不视为探测失败 */
async function readSysfs(file) {
  try {
    return (await fs.promises.readFile(file, 'utf8')).trim();
  } catch {
    return '';
  }
}

async function sysfsExists(fp) {
  try {
    await fs.promises.access(fp);
    return true;
  } catch {
    return false;
  }
}

/**
 * 扫描 /sys/bus/usb/devices，挑出充当打印机的设备（接口类 07，或已绑定 usbmisc/lpN）。
 * 只有根目录不可读时才抛错——那才是「探测手段不可用」；单台设备读不到按已拔出处理。
 * 返回 [{ devicePath, vid, pid, serial, manufacturer, product, driverBound }]
 */
async function scanUsbPrinters() {
  const names = await fs.promises.readdir(USB_SYSFS_DIR);
  const found = [];
  await Promise.all(
    names.map(async (name) => {
      // 设备节点形如 1-1.2；带 ':' 的是接口节点，usbN 是总线根目录，均跳过
      if (!name.includes('-') || name.includes(':')) return;
      const dir = path.join(USB_SYSFS_DIR, name);
      const [vid, pid] = await Promise.all([
        readSysfs(path.join(dir, 'idVendor')),
        readSysfs(path.join(dir, 'idProduct')),
      ]);
      if (!vid || !pid) return; // 枚举期间被拔掉
      const ifaces = (await fs.promises.readdir(dir).catch(() => [])).filter((n) => n.includes(':'));
      let printerIface = false;
      let driverBound = false;
      for (const iface of ifaces) {
        const ifaceDir = path.join(dir, iface);
        if ((await readSysfs(path.join(ifaceDir, 'bInterfaceClass'))) === '07') printerIface = true;
        if (await sysfsExists(path.join(ifaceDir, 'usbmisc'))) driverBound = true;
      }
      if (!printerIface && !driverBound) return; // 非打印机设备（键鼠/存储等）
      const [serial, manufacturer, product] = await Promise.all([
        readSysfs(path.join(dir, 'serial')),
        readSysfs(path.join(dir, 'manufacturer')),
        readSysfs(path.join(dir, 'product')),
      ]);
      found.push({
        devicePath: name,
        vid: vid.toLowerCase(),
        pid: pid.toLowerCase(),
        serial,
        manufacturer,
        product,
        driverBound,
      });
    })
  );
  return found;
}

/**
 * 把 device-uri 匹配到物理设备：
 *  - 配了 PRINTER_USB_IDS 时先按 VID:PID 过滤（多台同型号时缩小范围）
 *  - URI 带 serial 时按 serial 精确匹配，不一致视为「插的不是这台」
 *  - URI 无 serial：唯一候选直接匹配；多候选取第一台并标记 ambiguous
 */
function matchUsbDevice(devices, uri, usbIds) {
  const filter = usbIds && usbIds.length ? usbIds : null;
  const pool = filter ? devices.filter((d) => filter.includes(`${d.vid}:${d.pid}`)) : devices;
  const serial = uriSerial(uri);
  if (serial) {
    const hit = pool.find((d) => d.serial && d.serial.toLowerCase() === serial.toLowerCase());
    if (hit) return { device: hit, ambiguous: false, detail: '' };
    // 区分两种「没匹配上」：过滤器把所有设备排除了，还是序列号对不上
    const detail =
      filter && pool.length === 0 && devices.length > 0
        ? 'PRINTER_USB_IDS 未匹配到任何在位设备'
        : 'device-uri 的序列号与在位设备不一致';
    return { device: null, ambiguous: false, detail };
  }
  if (pool.length === 1) return { device: pool[0], ambiguous: false, detail: '' };
  if (pool.length === 0) return { device: null, ambiguous: false, detail: '' };
  return { device: pool[0], ambiguous: true, detail: `同型号设备 ${pool.length} 台，按序列号无法唯一确定` };
}

/** sysfs 匹配结果 → link 对象 */
function linkFromMatch(m) {
  if (!m.device) {
    return {
      state: 'disconnected',
      source: 'sysfs',
      devicePath: '',
      driverBound: false,
      serial: '',
      ambiguous: false,
      detail: m.detail,
    };
  }
  return {
    state: 'connected',
    source: 'sysfs',
    devicePath: m.device.devicePath,
    driverBound: m.device.driverBound,
    serial: m.device.serial,
    ambiguous: m.ambiguous,
    detail: m.detail,
  };
}

/** 未知态：探测手段不可用（≠ 没插），前端用灰色展示 */
function unknownLink(source, detail) {
  return {
    state: 'unknown',
    source,
    devicePath: '',
    driverBound: false,
    serial: '',
    ambiguous: false,
    detail,
  };
}

/**
 * 探测 USB 打印机链路。返回 { probe, links }：probe 说明本次用了什么手段、耗时、是否降级。
 * sysfs 根目录不可读 → auto 模式回退 lpinfo 并置 degraded；两者都失败才是 unknown。
 */
async function probeUsbLinks(printers) {
  const started = Date.now();
  const usbPrinters = printers.filter((p) => p.usbConfigured);
  const probe = { method: 'none', durationMs: 0, degraded: false, error: '' };
  const links = new Map();
  if (usbPrinters.length === 0) {
    probe.durationMs = Date.now() - started;
    return { probe, links };
  }

  const mode = PROBE_MODES.has(cfg.printer.probe) ? cfg.printer.probe : 'auto';
  if (mode !== 'lpinfo') {
    try {
      const devices = await scanUsbPrinters();
      for (const p of usbPrinters) {
        links.set(p.name, linkFromMatch(matchUsbDevice(devices, p.deviceUri, cfg.printer.usbIds)));
      }
      probe.method = 'sysfs';
      probe.durationMs = Date.now() - started;
      return { probe, links };
    } catch (e) {
      probe.error = `sysfs 不可读：${(e && e.message) || e}`;
      probe.degraded = mode === 'auto';
      if (mode === 'sysfs') {
        for (const p of usbPrinters) links.set(p.name, unknownLink('sysfs', probe.error));
        probe.method = 'sysfs';
        probe.durationMs = Date.now() - started;
        return { probe, links };
      }
    }
  }

  /* 回退路径：只在 sysfs 不可用（或显式配 lpinfo）时执行 */
  const out = await runCmd('lpinfo', ['-v'], 8000);
  probe.method = 'lpinfo';
  probe.durationMs = Date.now() - started;
  if (out === null) {
    probe.degraded = true;
    probe.error = probe.error || 'lpinfo 不可用';
    for (const p of usbPrinters) links.set(p.name, unknownLink('none', probe.error));
    return { probe, links };
  }
  const live = new Set();
  for (const line of out.split('\n')) {
    const m = line.match(/^(?:direct|network)\s+(\S+)/);
    if (m) live.add(m[1]);
  }
  for (const p of usbPrinters) {
    // 打印中 CUPS 后端独占设备，lpinfo 枚举不到，此时链路必然通（仅回退路径沿用旧行为）
    const connected = live.has(p.deviceUri) || p.state === 'processing';
    links.set(p.name, {
      state: connected ? 'connected' : 'disconnected',
      source: 'lpinfo',
      devicePath: '',
      driverBound: false,
      serial: uriSerial(p.deviceUri),
      ambiguous: false,
      detail: '',
    });
  }
  return { probe, links };
}

/** 记录链路状态首次出现时间（since）与最近一次确认在位时间（lastSeen） */
function withHistory(name, link, now) {
  const prev = linkHistory.get(name);
  if (!prev || prev.state !== link.state) {
    linkHistory.set(name, {
      state: link.state,
      since: now,
      lastSeen: link.state === 'connected' ? now : prev ? prev.lastSeen : 0,
    });
  } else if (link.state === 'connected') {
    prev.lastSeen = now;
  }
  const rec = linkHistory.get(name);
  return { ...link, since: rec.since, lastSeen: rec.lastSeen };
}

/** 打印能力层：链路之外「能不能打」，与 link 解耦 */
function deriveReady(p) {
  const reasons = String(p.stateReasons || '')
    .split(',')
    .map((r) => r.trim())
    .filter((r) => r && r !== 'none');
  const detail = p.stateMessage || '';
  if (reasons.includes('offline-report')) return { state: 'offline', reasons, detail };
  if (!p.accepting || p.state === 'stopped') return { state: 'paused', reasons, detail };
  if (reasons.some((r) => ERROR_REASONS.has(r))) return { state: 'error', reasons, detail };
  if (p.state === 'idle' || p.state === 'processing') return { state: 'ready', reasons, detail };
  return { state: 'unknown', reasons, detail };
}

async function readPrinter() {
  const fail = (msg) => ({
    available: false,
    probe: { method: 'none', durationMs: 0, degraded: false, error: msg },
    printers: [],
    activeJobs: [],
    history: [],
    error: msg,
  });
  if (!cfg.printer.enabled) return fail('Printer disabled');

  /* 1. 打印机列表与状态 */
  const printersOut = await runCmd('ipptool', ['-tv', IPP_TESTS.printers.uri, IPP_TEST_FILES.printers], 10000);
  if (printersOut === null) {
    return fail('CUPS 不可用（未安装 ipptool / cupsd 未运行）');
  }
  const printers = [];
  for (const g of parseIppTool(printersOut)) {
    if (!g['printer-name']) continue;
    const uri = g['device-uri'] || '';
    printers.push({
      name: g['printer-name'],
      model: g['printer-make-and-model'] || '',
      state: IPP_PRINTER_STATES[g['printer-state']] || g['printer-state'] || 'unknown',
      stateReasons: g['printer-state-reasons'] || '',
      stateMessage: g['printer-state-message'] || '',
      accepting: g['printer-is-accepting-jobs'] === 'true',
      queuedJobCount: parseInt(g['queued-job-count'], 10) || 0,
      deviceUri: uri,
      transport: transportOf(uri),
      // USB 配置以 device-uri 判断；是否物理在位见 link（sysfs 探测）
      usbConfigured: uri.startsWith('usb://'),
      usbConnected: false,
    });
  }

  /* 2. 链路探测：USB 走 sysfs（毫秒级、不触碰设备），探测手段不可用时才回退 lpinfo */
  const { probe, links } = await probeUsbLinks(printers);
  const now = Date.now();
  for (const p of printers) {
    p.link = withHistory(
      p.name,
      links.get(p.name) || { state: 'unknown', source: 'cups', detail: p.stateMessage || '' },
      now
    );
    p.ready = deriveReady(p);
    // 旧字段保留一个版本（前端迁移期）：只表示「确认在位」，探测失败时为 false，看 link.state 区分
    p.usbConnected = p.link.state === 'connected';
  }

  /* 3. 打印中队列（历史单独走 /api/printer/history，不跟随 10s 轮询） */
  const activeJobs = (await Promise.all(printers.map((p) => readJobs('jobsActive', p.name)))).flat();

  return {
    available: true,
    collectedAt: Date.now(),
    probe,
    printers,
    activeJobs,
    error: '',
  };
}

/** Get-Jobs：必须指向具体打印机，逐台查询后由调用方合并 */
async function readJobs(key, printerName) {
  const out = await runCmd(
    'ipptool',
    ['-tv', `ipp://localhost/printers/${encodeURIComponent(printerName)}`, IPP_TEST_FILES[key]],
    10000
  );
  if (out === null) return [];
  const jobs = [];
  for (const g of parseIppTool(out)) {
    if (g['job-id'] == null) continue;
    jobs.push({
      id: g['job-id'],
      printer: printerName,
      name: g['job-name'] || '(未命名)',
      user: g['job-originating-user-name'] || '-',
      host: g['job-originating-host-name'] || '-',
      state: g['job-state'] || '',
      sizeKB: parseInt(g['job-k-octets'], 10) || 0,
      createdMs: (parseInt(g['time-at-creation'], 10) || 0) * 1000,
      completedMs: (parseInt(g['time-at-completed'], 10) || 0) * 1000 || null,
    });
  }
  return jobs;
}

/**
 * 打印历史（GET /api/printer/history）：变化慢，独立采集、独立缓存，
 * 不再随 10s 状态轮询重复传输，也不进入 /api/metrics 的聚合响应。
 */
async function readPrinterHistory() {
  const now = Date.now();
  if (!cfg.printer.enabled) return { collectedAt: now, history: [], error: 'Printer disabled' };
  const printersOut = await runCmd('ipptool', ['-tv', IPP_TESTS.printers.uri, IPP_TEST_FILES.printers], 10000);
  if (printersOut === null) return { collectedAt: now, history: [], error: 'CUPS 不可用（未安装 ipptool / cupsd 未运行）' };
  const names = parseIppTool(printersOut)
    .map((g) => g['printer-name'])
    .filter(Boolean);
  const lists = await Promise.all(names.map((n) => readJobs('jobsDone', n)));
  const history = lists
    .flat()
    .sort((a, b) => (b.completedMs || b.createdMs) - (a.completedMs || a.createdMs))
    .slice(0, Math.max(1, cfg.printer.historyLimit));
  return { collectedAt: Date.now(), history, error: '' };
}

/** 启动 printer 采集定时器并写入共享 state（入口调用；语义与原 server.js 模块加载期行为一致） */
function startPrinterTimer(state) {
  readPrinter().then((p) => (state.printer = p));
  setInterval(async () => (state.printer = await readPrinter()), Math.max(5000, cfg.printer.interval));
}

/** 历史缓存：留在模块内而不是共享 state，避免进入 /api/metrics 的聚合响应 */
let historyCache = { collectedAt: 0, history: [], error: '' };

/** 启动历史采集定时器：默认 60s，与 10s 状态轮询解耦 */
function startPrinterHistoryTimer() {
  const tick = async () => {
    historyCache = await readPrinterHistory();
  };
  tick();
  setInterval(tick, Math.max(15000, cfg.printer.historyInterval));
}

/** 最近一次历史采集结果（GET /api/printer/history） */
function getPrinterHistory() {
  return historyCache;
}

/* ================= 打印测试页（POST /api/printer/test-page） ================= */

/** CUPS 打印机名约束：字母/数字开头，仅允许 字母 数字 空格 . _ -（拒绝路径分隔符与控制字符，
 *  防止构造 device-uri / 文件路径类混淆；execFile 无 shell，注入风险本身有限，这里防御纵深） */
const PRINTER_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,127}$/;

/**
 * 独立的命令执行封装（与 lib/http.js 的 runCmd 不同）：捕获 stderr 与退出码，
 * 供测试页流程给出第一手失败原因（如 "printer is not accepting jobs"）。
 * extraEnv 注入额外环境变量（本模块用于 LC_ALL=C 固定 lp/lpstat 输出语言，便于解析）。
 */
function run(cmd, args, timeout, extraEnv) {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { timeout, windowsHide: true, env: extraEnv ? { ...process.env, ...extraEnv } : undefined },
      (err, stdout, stderr) =>
        resolve({
          ok: !err,
          code: err ? (err.code ?? err.errno ?? 1) : 0,
          out: String(stdout || ''),
          errText: String(stderr || (err && err.message) || ''),
        })
    );
  });
}

/** PostScript 字符串转义：反斜杠与圆括号（PS 字面量定界符）；仅保留 ASCII 可打印字符 */
function psStr(s) {
  return String(s)
    .replace(/[^\x20-\x7e]/g, '?')
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)');
}

/** 生成测试页 PostScript：边框 + 打印机/主机/时间（ISO，Courier 无中文字形）+ 可读性确认行 */
function buildTestPagePs(printerName) {
  const L = [
    'watchdog-os Test Page',
    '',
    `Printer: ${printerName}`,
    `Host:    ${os.hostname()}`,
    `Date:    ${new Date().toISOString()}`,
    '',
    'If you can read this line, printing works.',
  ];
  return (
    '%!PS-Adobe-3.0\n' +
    '/Courier findfont 12 scalefont setfont\n' +
    '2 setlinewidth\n' +
    '36 36 540 720 rectstroke\n' +
    L.map((t, i) => `72 ${708 - i * 24} moveto (${psStr(t)}) show\n`).join('') +
    'showpage\n'
  );
}

/**
 * 打印机存在性探测：lpstat -p <name>（存在则输出 "printer <name> ..."，否则非零退出）。
 * 返回 null 表示可用，否则返回 { error, detail }（测试页与文件打印共用同一判定）。
 */
async function checkPrinter(name) {
  const st = await run('lpstat', ['-p', name], 8000, { LC_ALL: 'C' });
  if (!st.ok && st.code === 'ENOENT') {
    return { error: 'CUPS unavailable', detail: 'lpstat 不存在（未安装 CUPS）' };
  }
  if (!st.ok && /unable to|cannot|connection refused|no such file|cupsd/i.test(st.errText)) {
    return { error: 'CUPS unavailable', detail: st.errText.trim().slice(0, 300) };
  }
  if (!st.ok || !st.out.includes(`printer ${name}`)) {
    return { error: 'Printer not found', detail: st.errText.trim().slice(0, 300) };
  }
  return null;
}

/**
 * 向指定打印机提交一张测试页。返回 { ok, printer, jobId, requestId, title } 或 { error, detail? }，
 * error 约定（由路由映射状态码）：'Bad printer name'→400、'Printer not found'→404、
 * 'CUPS unavailable'→503、其余（'Print failed' 等）→500。
 */
async function printTestPage(printerName) {
  const name = String(printerName || '').trim();
  if (!PRINTER_NAME_RE.test(name)) return { error: 'Bad printer name' };

  /* 1. 打印机存在性探测 */
  const printerErr = await checkPrinter(name);
  if (printerErr) return printerErr;

  /* 2. 生成测试页文件（文件名含时间戳避免并发覆盖，提交完成后清理） */
  const file = path.join(os.tmpdir(), `watchdog-testpage-${name}-${Date.now()}.ps`);
  try {
    fs.writeFileSync(file, buildTestPagePs(name), 'utf8');
  } catch (e) {
    return { error: 'Print failed', detail: `测试页文件写入失败：${e.message}` };
  }
  try {
    /* 3. lp 提交：-t 设置任务名（会体现在 Printer 面板的任务列表/历史里） */
    const title = `watchdog-os Test Page - ${new Date().toISOString()}`;
    const lp = await run('lp', ['-d', name, '-t', title, file], 15000, { LC_ALL: 'C' });
    if (!lp.ok && lp.code === 'ENOENT') {
      return { error: 'CUPS unavailable', detail: 'lp 不存在（未安装 CUPS）' };
    }
    if (!lp.ok) {
      return { error: 'Print failed', detail: (lp.errText || lp.out).trim().slice(0, 300) };
    }
    // 成功输出形如 "request id is L130-42 (1 file(s))"，作业号可关联到面板队列
    const m = lp.out.match(/request id is (\S+)-(\d+)/);
    return { ok: true, printer: name, jobId: m ? m[2] : '', requestId: m ? m[1] : '', title };
  } finally {
    try { fs.unlinkSync(file); } catch { /* 清理失败不影响提交结果 */ }
  }
}

/* ================= 打印文件（POST /api/printer/print） ================= */

/** 纸张尺寸白名单：CUPS media（IPP 标准）/ PPD PageSize 关键字；不接收任意 -o 值防选项注入 */
const PRINT_PAPER_SIZES = new Set(['A4', 'A3', 'A5', 'Letter', 'Legal', 'Executive', 'Tabloid', 'B5']);
/**
 * 色彩模式 → CUPS 选项。两种写法都传：
 *  - print-color-mode 是 IPP Everywhere 标准关键字（CUPS ≥2.2）
 *  - ColorModel 是 PPD 驱动（如本机 Gutenprint）的实际选项
 * 二者语义一致（color↔RGB / monochrome↔Gray），不支持的一方会被 cupsd 忽略。
 */
const PRINT_COLOR_MODES = {
  color: ['color', 'RGB'],
  mono: ['monochrome', 'Gray'],
};
/** 页码范围：1-3、5、8- 等，逗号分隔；空串表示全部 */
const PRINT_PAGE_RANGE_RE = /^\d+(-\d*)?(,\d+(-\d*)?)*$/;
/** 单文件打印上限（只嗅探前 1KB，避免把巨型文件塞进 CUPS 队列） */
const PRINT_MAX_SIZE = 50 * 1024 * 1024;

/**
 * 探测文件能否被 CUPS 直接打印（与 /usr/share/cups/mime 的 magic 判定对齐）：
 * PDF / PostScript / 常见图片 / 纯文本；其余返回 false。
 * 没有这一步，二进制（如 docx/压缩包）会被 lp 提交成功、却在过滤器阶段失败，
 * 接口误报成功而队列里是一条 aborted 作业。仅读取前 1KB，大文件不整块入内存。
 */
async function isPrintableFile(abs) {
  const fh = await fs.promises.open(abs, 'r');
  try {
    const buf = Buffer.alloc(1024);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    const head = buf.subarray(0, bytesRead);
    if (head.length === 0) return true; // 空文件：打印一张空白页
    const starts = (s) =>
      head.length >= s.length && head.subarray(0, s.length).equals(Buffer.from(s, 'binary'));
    if (starts('%PDF') || starts('%!PS')) return true;
    if (
      starts('\x89PNG') ||
      starts('\xff\xd8\xff') ||
      starts('GIF87a') ||
      starts('GIF89a') ||
      starts('BM') ||
      head.subarray(0, 4).equals(Buffer.from([0x49, 0x49, 0x2a, 0x00])) || // TIFF little-endian
      head.subarray(0, 4).equals(Buffer.from([0x4d, 0x4d, 0x00, 0x2a])) // TIFF big-endian
    ) {
      return true;
    }
    // 纯文本：前 1KB 内无 NUL、无控制字符（Tab/LF/CR 放行；≥0x80 视为 UTF-8 多字节放行）
    for (const b of head) {
      if (b === 0) return false;
      if (b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d) return false;
    }
    return true;
  } finally {
    await fh.close();
  }
}

/** 拼装 lp 实参（纯函数，便于单测）：所有值都经调用方的白名单/正则校验 */
function buildPrintArgs(name, title, paperSize, colorMode, pageRange, abs) {
  const [mode, model] = PRINT_COLOR_MODES[colorMode];
  const args = [
    '-d', name,
    '-t', title,
    '-o', `media=${paperSize}`,
    '-o', `print-color-mode=${mode}`,
    '-o', `ColorModel=${model}`,
  ];
  if (pageRange) args.push('-o', `page-ranges=${pageRange}`);
  args.push(abs);
  return args;
}

/**
 * 向指定打印机提交一个文件。body: { path, printer, paperSize, colorMode, pageRange }。
 * 返回 { ok, printer, jobId, requestId, title, pageRange } 或 { error, detail? }。
 * 路径校验复用 /api/fs 的 fsResolve + fsAllowed（同一套 FS_ROOTS 白名单）。
 */
async function printFile(body) {
  const name = String((body && body.printer) || '').trim();
  if (!PRINTER_NAME_RE.test(name)) return { error: 'Bad printer name' };
  const paperSize = String((body && body.paperSize) || 'A4');
  if (!PRINT_PAPER_SIZES.has(paperSize)) return { error: 'Bad paper size' };
  const colorMode = String((body && body.colorMode) || 'color');
  if (!PRINT_COLOR_MODES[colorMode]) return { error: 'Bad color mode' };
  // 去掉空白后按白名单校验：page-ranges 会原样传给 lp，必须先挡掉任意 -o 注入
  const pageRange = String((body && body.pageRange) || '').replace(/\s+/g, '');
  if (pageRange && !PRINT_PAGE_RANGE_RE.test(pageRange)) return { error: 'Bad page range' };

  const abs = fsResolve(body && body.path);
  if (!abs || !fsAllowed(abs)) return { error: 'Path is outside the allowed roots' };
  const st = await fs.promises.stat(abs).catch(() => null);
  if (!st) return { error: 'File not found' };
  if (!st.isFile()) return { error: 'Not a regular file' };
  if (st.size > PRINT_MAX_SIZE) {
    return { error: 'File too large to print', detail: `上限 ${PRINT_MAX_SIZE / 1024 / 1024}MB` };
  }
  let printable;
  try {
    printable = await isPrintableFile(abs);
  } catch (e) {
    return { error: 'File not readable', detail: (e && e.message) || String(e) };
  }
  if (!printable) {
    return {
      error: 'Unsupported file type',
      detail: 'Only PDF, PostScript, images and plain text can be printed.',
    };
  }

  const printerErr = await checkPrinter(name);
  if (printerErr) return printerErr;

  // 文档格式由 CUPS 按文件内容自动识别（mime.types magic），无需 -o document-format。
  // execFile 无 shell，所有值都经上面的白名单/正则校验，文件名含空格也不会被拆词。
  const title = path.basename(abs);
  const lp = await run('lp', buildPrintArgs(name, title, paperSize, colorMode, pageRange, abs), 20000, {
    LC_ALL: 'C',
  });
  if (!lp.ok && lp.code === 'ENOENT') {
    return { error: 'CUPS unavailable', detail: 'lp 不存在（未安装 CUPS）' };
  }
  if (!lp.ok) return { error: 'Print failed', detail: (lp.errText || lp.out).trim().slice(0, 300) };
  // 成功输出形如 "request id is L130-42 (1 file(s))"，作业号可关联到 Printer 面板队列
  const m = lp.out.match(/request id is (\S+)-(\d+)/);
  return { ok: true, printer: name, jobId: m ? m[2] : '', requestId: m ? m[1] : '', title, pageRange };
}

/* ================= 打印机恢复 / 队列任务控制 ================= */

/**
 * 队列任务动作 → CUPS 命令（纯函数，便于单测）：
 *  - hold   （暂停）：lp -i <id> -H hold    挂起作业不再打印（可用 resume 解除）
 *  - resume （恢复）：lp -i <id> -H resume  解除挂起，重新排队
 *  - cancel （取消）：cancel <id>           Cancel-Job，中止作业但保留在打印历史中
 *  - delete （删除）：cancel -x <id>        取消并删除作业数据文件（不留历史记录）
 */
function buildJobCommand(action, jobId) {
  switch (action) {
    case 'hold':
      return { cmd: 'lp', args: ['-i', jobId, '-H', 'hold'] };
    case 'resume':
      return { cmd: 'lp', args: ['-i', jobId, '-H', 'resume'] };
    case 'cancel':
      return { cmd: 'cancel', args: [jobId] };
    case 'delete':
      return { cmd: 'cancel', args: ['-x', jobId] };
    default:
      return null;
  }
}

/** CUPS 全局作业号为十进制正整数（ipptool 的 job-id 即此值）；拒绝其它字符防参数混淆 */
const JOB_ID_RE = /^\d{1,10}$/;

/**
 * 恢复被暂停的打印机：cupsenable 解除「已停止」（cupsdisable 造成，printer-state=stopped），
 * cupsaccept 恢复「拒收新任务」（cupsreject 造成，printer-is-accepting-jobs=false）。
 * 两条命令都幂等，对正常打印机执行也无害；逐条执行避免同时对同一目标发两个管理请求。
 */
async function resumePrinter(printerName) {
  const name = String(printerName || '').trim();
  if (!PRINTER_NAME_RE.test(name)) return { error: 'Bad printer name' };

  const printerErr = await checkPrinter(name);
  if (printerErr) return printerErr;

  const steps = [
    ['cupsenable', [name]],
    ['cupsaccept', [name]],
  ];
  for (const [cmd, args] of steps) {
    const r = await run(cmd, args, 10000, { LC_ALL: 'C' });
    if (!r.ok && r.code === 'ENOENT') {
      return { error: 'CUPS unavailable', detail: `${cmd} 不存在（未安装 CUPS）` };
    }
    if (!r.ok) return { error: 'Resume failed', detail: (r.errText || r.out).trim().slice(0, 300) };
  }
  return { ok: true, printer: name };
}

/**
 * 队列任务控制。body: { printer, jobId, action }。
 * 校验（打印机名 / 作业号 / 动作白名单）都在触达 CUPS 之前完成，避免对任意作业执行命令。
 */
async function controlPrinterJob(body) {
  const name = String((body && body.printer) || '').trim();
  const jobId = String((body && body.jobId) || '').trim();
  const action = String((body && body.action) || '').trim();
  if (!PRINTER_NAME_RE.test(name)) return { error: 'Bad printer name' };
  if (!JOB_ID_RE.test(jobId)) return { error: 'Bad job id' };
  const cmd = buildJobCommand(action, jobId);
  if (!cmd) return { error: 'Bad job action' };

  const printerErr = await checkPrinter(name);
  if (printerErr) return printerErr;

  const r = await run(cmd.cmd, cmd.args, 10000, { LC_ALL: 'C' });
  if (!r.ok && r.code === 'ENOENT') {
    return { error: 'CUPS unavailable', detail: `${cmd.cmd} 不存在（未安装 CUPS）` };
  }
  if (!r.ok) return { error: 'Job action failed', detail: (r.errText || r.out).trim().slice(0, 300) };
  return { ok: true, printer: name, jobId, action };
}

module.exports = {
  readPrinter,
  startPrinterTimer,
  startPrinterHistoryTimer,
  getPrinterHistory,
  printTestPage,
  printFile,
  buildPrintArgs,
  resumePrinter,
  controlPrinterJob,
  buildJobCommand,
};
