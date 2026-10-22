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
 *  - lpinfo -v：列出当前物理可用的设备 URI，与打印机 device-uri 精确比对 → USB 线是否已连接
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { cfg } = require('../config');
const { runCmd } = require('../lib/http');

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

async function readPrinter() {
  const fail = (msg) => ({ available: false, printers: [], activeJobs: [], history: [], error: msg });
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
      deviceUri: uri,
      // USB 配置以 device-uri 判断；是否物理连接需与 lpinfo 枚举的设备比对
      usbConfigured: uri.startsWith('usb://'),
      usbConnected: false,
    });
  }

  /* 2. lpinfo -v：当前物理在线的设备 URI（USB 已插入才会出现在列表中） */
  const lpinfoOut = await runCmd('lpinfo', ['-v'], 8000);
  const liveUris = new Set();
  if (lpinfoOut) {
    for (const line of lpinfoOut.split('\n')) {
      const m = line.match(/^(?:direct|network)\s+(\S+)/);
      if (m) liveUris.add(m[1]);
    }
    for (const p of printers) {
      // 打印中（processing）时 CUPS USB 后端独占设备，lpinfo 枚举不到它——此时链路必然是通的，直接视为已连接
      if (p.usbConfigured) p.usbConnected = liveUris.has(p.deviceUri) || p.state === 'processing';
    }
  }

  /* 3. 打印中队列与历史：Get-Jobs 必须指向具体打印机，故逐台并行查询后合并 */
  const readJobs = async (key, printerName) => {
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
  };
  const names = printers.map((p) => p.name);
  const [activeLists, doneLists] = await Promise.all([
    Promise.all(names.map((n) => readJobs('jobsActive', n))),
    Promise.all(names.map((n) => readJobs('jobsDone', n))),
  ]);
  const activeJobs = activeLists.flat();
  // 历史：多打印机时按完成时间倒序合并，截取上限
  const history = doneLists
    .flat()
    .sort((a, b) => (b.completedMs || b.createdMs) - (a.completedMs || a.createdMs))
    .slice(0, Math.max(1, cfg.printer.historyLimit));

  return {
    available: true,
    collectedAt: Date.now(),
    printers,
    activeJobs,
    history: history.slice(0, Math.max(1, cfg.printer.historyLimit)),
    error: '',
  };
}

/** 启动 printer 采集定时器并写入共享 state（入口调用；语义与原 server.js 模块加载期行为一致） */
function startPrinterTimer(state) {
  readPrinter().then((p) => (state.printer = p));
  setInterval(async () => (state.printer = await readPrinter()), Math.max(5000, cfg.printer.interval));
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
 * 向指定打印机提交一张测试页。返回 { ok, printer, jobId, requestId, title } 或 { error, detail? }，
 * error 约定（由路由映射状态码）：'Bad printer name'→400、'Printer not found'→404、
 * 'CUPS unavailable'→503、其余（'Print failed' 等）→500。
 */
async function printTestPage(printerName) {
  const name = String(printerName || '').trim();
  if (!PRINTER_NAME_RE.test(name)) return { error: 'Bad printer name' };

  /* 1. 打印机存在性探测：lpstat -p <name>（存在则输出 "printer <name> ..."，否则非零退出） */
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

module.exports = { readPrinter, startPrinterTimer, printTestPage };
