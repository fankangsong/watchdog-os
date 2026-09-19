#!/usr/bin/env node
/**
 * 系统探针监控服务（零依赖 Node.js）
 *
 * 功能：
 *  - 采集 CPU / 内存 / 交换分区 / 硬件温度 / 磁盘使用率
 *  - 采集 Docker 容器列表与资源占用（docker stats）
 *  - 文本密码鉴权（REST + 静态页面统一校验）
 *  - basePath 前缀支持，可置于 Nginx 反向代理子路径之后
 *
 * 启动：node server.js   （或 npm start）
 * 配置：config.json，可用环境变量 PORT / PASSWORD / BASE_PATH 覆盖
 */
'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const fsp = require('fs').promises;
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const net = require('net');
const { execFile, spawn } = require('child_process');

/* ---------------- 配置 ---------------- */
/* .env 加载（零依赖）：PASSWORD 等变量写入 process.env，不覆盖已有环境变量 */
function loadEnv() {
  try {
    const txt = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
    for (const line of txt.split('\n')) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!m) continue;
      const val = m[2].replace(/^["']|["']$/g, '');
      if (!(m[1] in process.env)) process.env[m[1]] = val;
    }
  } catch { /* 无 .env 文件时忽略 */ }
}
loadEnv();

let fileCfg = {};
try {
  fileCfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
} catch (e) {
  console.warn('[warn] 读取 config.json 失败，使用默认配置:', e.message);
}

const cfg = Object.assign(
  {
    port: 3000,
    host: '0.0.0.0',
    password: 'admin123',
    basePath: '/',
    diskMounts: [],          // 留空则按平台取默认挂载点
    collectInterval: 2000,   // CPU/内存采样间隔 ms
    dockerInterval: 5000,    // docker stats 刷新间隔 ms
    processInterval: 10000,  // 进程列表刷新间隔 ms
    processTopN: 50,         // 进程列表返回条数（按 CPU 排序取前 N）
  },
  fileCfg
);
/* 终端（ttyd）配置：config.json 的 terminal 节整体覆盖默认值 */
cfg.terminal = Object.assign(
  {
    enabled: false,          // 是否启用终端应用（需服务器安装 ttyd）
    ttydPath: 'ttyd',        // ttyd 可执行文件路径
    ttydPort: 7681,          // ttyd 监听端口（仅本机 127.0.0.1 访问）
    ttydArgs: ['bash'],      // ttyd 附加参数与要运行的 shell
  },
  cfg.terminal
);
if (!Array.isArray(cfg.terminal.ttydArgs)) cfg.terminal.ttydArgs = ['bash'];
if (process.env.PORT) cfg.port = parseInt(process.env.PORT, 10);
if (process.env.PASSWORD) cfg.password = process.env.PASSWORD;
if (process.env.BASE_PATH) cfg.basePath = process.env.BASE_PATH;
if (process.env.TERMINAL_ENABLED != null) {
  cfg.terminal.enabled = ['1', 'true', 'yes', 'on'].includes(String(process.env.TERMINAL_ENABLED).toLowerCase());
}
if (process.env.TTYD_PATH) cfg.terminal.ttydPath = process.env.TTYD_PATH;
if (process.env.TTYD_PORT) cfg.terminal.ttydPort = parseInt(process.env.TTYD_PORT, 10) || cfg.terminal.ttydPort;

if (!cfg.password) {
  console.error('[fatal] 未配置访问密码：请在 config.json 的 password 或 .env 的 PASSWORD 中设置');
  process.exit(1);
}

/* basePath 规范化：必须以 / 开头，去除末尾 /（根路径保留为 '/'） */
let BASE = String(cfg.basePath || '/').trim();
if (!BASE.startsWith('/')) BASE = '/' + BASE;
if (BASE.length > 1 && BASE.endsWith('/')) BASE = BASE.slice(0, -1);
cfg.basePath = BASE;

if (!Array.isArray(cfg.diskMounts) || cfg.diskMounts.length === 0) {
  cfg.diskMounts =
    os.platform() === 'win32' ? [process.cwd().slice(0, 3)] : ['/'];
}

const COOKIE_NAME = 'sp_token';
/* JWT（HS256，零依赖）：密钥从密码派生，不落盘；过期默认 24h，可用 JWT_EXPIRES_IN 秒覆盖 */
const JWT_SECRET = crypto
  .createHash('sha256')
  .update('sysprobe::jwt::' + cfg.password)
  .digest('hex');
const JWT_EXPIRES = Math.max(parseInt(process.env.JWT_EXPIRES_IN || '86400', 10) || 86400, 60);
/* 静态目录：优先 SPA 构建产物 dist/，不存在时回退旧 public/ */
const DIST_DIR = path.join(__dirname, 'dist');
const PUBLIC_DIR = fs.existsSync(DIST_DIR) ? DIST_DIR : path.join(__dirname, 'public');
const SPA_MODE = PUBLIC_DIR === DIST_DIR;

/* ---------------- 工具函数 ---------------- */
function send(res, status, body, headers) {
  const h = Object.assign({ 'Cache-Control': 'no-store' }, headers || {});
  if (typeof body === 'object' && !(body instanceof Buffer)) {
    h['Content-Type'] = 'application/json; charset=utf-8';
    body = JSON.stringify(body);
  }
  res.writeHead(status, h);
  res.end(body);
}

function redirect(res, location) {
  res.writeHead(302, { Location: location, 'Cache-Control': 'no-store' });
  res.end();
}

function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie;
  if (!raw) return out;
  for (const pair of raw.split(';')) {
    const i = pair.indexOf('=');
    if (i > 0) out[pair.slice(0, i).trim()] = decodeURIComponent(pair.slice(i + 1).trim());
  }
  return out;
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/* ---------------- JWT（HS256，零依赖） ---------------- */
function b64url(s) {
  return Buffer.from(s).toString('base64url');
}

function signJwt(payload) {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify(payload));
  const sig = crypto
    .createHmac('sha256', JWT_SECRET)
    .update(header + '.' + body)
    .digest('base64url');
  return `${header}.${body}.${sig}`;
}

/** 校验 JWT：签名正确且未过期 → 返回 payload，否则 null */
function verifyJwt(token) {
  try {
    const parts = String(token).split('.');
    if (parts.length !== 3) return null;
    const [header, body, sig] = parts;
    const expect = crypto
      .createHmac('sha256', JWT_SECRET)
      .update(header + '.' + body)
      .digest('base64url');
    if (sig.length !== expect.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) {
      return null;
    }
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

/** 从 cookie / Bearer / x-auth-token 取 JWT 校验 */
function checkAuth(req) {
  const token =
    parseCookies(req)[COOKIE_NAME] ||
    req.headers['x-auth-token'] ||
    (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '') ||
    '';
  return !!verifyJwt(token);
}

function readBody(req, limit = 4096) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) return reject(new Error('body too large'));
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function runCmd(cmd, args, timeout = 8000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, windowsHide: true }, (err, stdout) => {
      resolve(err ? null : stdout);
    });
  });
}

/* ---------------- 指标采集 ---------------- */
const IS_LINUX = os.platform() === 'linux';

function readCpuTimes() {
  const cpus = os.cpus();
  const cores = cpus.map((c) => {
    const t = c.times;
    return { idle: t.idle, total: t.user + t.nice + t.sys + t.idle + t.irq };
  });
  return {
    cores,
    idle: cores.reduce((s, c) => s + c.idle, 0),
    total: cores.reduce((s, c) => s + c.total, 0),
  };
}

let prevCpu = null;
function sampleCpu() {
  const snap = readCpuTimes();
  const out = { usage: 0, cores: [], loadavg: IS_LINUX ? os.loadavg() : null };
  if (prevCpu) {
    const dt = snap.total - prevCpu.total;
    const di = snap.idle - prevCpu.idle;
    if (dt > 0) out.usage = +(((dt - di) / dt) * 100).toFixed(1);
    out.cores = snap.cores.map((c, i) => {
      const p = prevCpu.cores[i];
      if (!p) return 0;
      const d = c.total - p.total;
      return d > 0 ? +(((d - (c.idle - p.idle)) / d) * 100).toFixed(1) : 0;
    });
  } else {
    out.cores = snap.cores.map(() => 0);
  }
  prevCpu = snap;
  return out;
}

async function readMem() {
  if (IS_LINUX) {
    try {
      const txt = await fsp.readFile('/proc/meminfo', 'utf8');
      const info = {};
      for (const line of txt.split('\n')) {
        const m = line.match(/^(\w+):\s+(\d+)/);
        if (m) info[m[1]] = +m[2] * 1024; // kB -> B
      }
      const total = info.MemTotal || 0;
      const available = info.MemAvailable != null ? info.MemAvailable : info.MemFree || 0;
      const mem = {
        total,
        used: total - available,
        free: available,
        usagePct: total ? +(((total - available) / total) * 100).toFixed(1) : 0,
      };
      let swap = null;
      if (info.SwapTotal > 0) {
        const sUsed = info.SwapTotal - (info.SwapFree || 0);
        swap = {
          total: info.SwapTotal,
          used: sUsed,
          usagePct: +((sUsed / info.SwapTotal) * 100).toFixed(1),
        };
      }
      return { mem, swap };
    } catch { /* fallthrough */ }
  }
  const total = os.totalmem();
  const free = os.freemem();
  return {
    mem: {
      total,
      used: total - free,
      free,
      usagePct: +(((total - free) / total) * 100).toFixed(1),
    },
    swap: null,
  };
}

async function readTemps() {
  const temps = [];
  if (IS_LINUX) {
    try {
      // 优先 hwmon（含 CPU/主板等带标签的温度）
      const hwmons = await fsp.readdir('/sys/class/hwmon').catch(() => []);
      for (const hw of hwmons) {
        const dir = path.join('/sys/class/hwmon', hw);
        const chip = (await fsp.readFile(path.join(dir, 'name'), 'utf8').catch(() => '')).trim();
        const entries = await fsp.readdir(dir).catch(() => []);
        for (const e of entries) {
          if (!/^temp\d+_input$/.test(e)) continue;
          const v = parseInt((await fsp.readFile(path.join(dir, e), 'utf8').catch(() => '')).trim(), 10);
          if (!Number.isFinite(v)) continue;
          const labelFile = e.replace('_input', '_label');
          const label = (await fsp.readFile(path.join(dir, labelFile), 'utf8').catch(() => '')).trim();
          temps.push({ label: label || chip || hw, temp: +(v / 1000).toFixed(1) });
        }
      }
      // 兜底：thermal_zone
      if (temps.length === 0) {
        const zones = await fsp.readdir('/sys/class/thermal').catch(() => []);
        for (const z of zones) {
          if (!/^thermal_zone\d+$/.test(z)) continue;
          const v = parseInt(
            (await fsp.readFile(path.join('/sys/class/thermal', z, 'temp'), 'utf8').catch(() => '')).trim(),
            10
          );
          if (!Number.isFinite(v)) continue;
          const type = (await fsp.readFile(path.join('/sys/class/thermal', z, 'type'), 'utf8').catch(() => '')).trim();
          temps.push({ label: type || z, temp: +(v / 1000).toFixed(1) });
        }
      }
    } catch { /* ignore */ }
    return temps;
  }
  // Windows：尝试 ACPI 温度（PowerShell CIM），多数环境拿不到则返回空
  try {
    const out = await runCmd(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command',
        'Get-CimInstance -Namespace root/wmi -ClassName MSAcpi_ThermalZoneTemperature -ErrorAction Stop | ForEach-Object { $_.CurrentTemperature }'],
      5000
    );
    if (out) {
      for (const line of out.split('\n')) {
        const m = line.match(/\d{3,}/);
        if (m) {
          const c = +(parseInt(m[0], 10) / 10 - 273.15).toFixed(1);
          if (c > -50 && c < 150) temps.push({ label: 'ACPI Thermal Zone', temp: c });
        }
      }
    }
  } catch { /* ignore */ }
  return temps;
}

async function readDisks() {
  const disks = [];
  for (const mount of cfg.diskMounts) {
    try {
      const s = await fsp.statfs(mount);
      const bsize = s.bsize || 1;
      const total = s.blocks * bsize;
      const free = s.bavail * bsize; // 可供普通用户使用
      const used = total - free;
      disks.push({
        mount,
        total,
        free,
        used,
        usagePct: total ? +((used / total) * 100).toFixed(1) : 0,
      });
    } catch {
      disks.push({ mount, total: 0, free: 0, used: 0, usagePct: 0, error: 'Unreadable' });
    }
  }
  return disks;
}

async function readDocker() {
  const psOut = await runCmd('docker', [
    'ps', '--format', '{{.ID}}|{{.Names}}|{{.Image}}|{{.Status}}',
  ]);
  if (psOut === null) {
    return { available: false, containers: [], error: 'Docker command unavailable or no permission' };
  }
  const containers = psOut
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [id, name, image, status] = l.split('|');
      return { id, name, image, status };
    });
  const statsOut = await runCmd('docker', [
    'stats', '--no-stream', '--format',
    '{{.Name}}|{{.CPUPerc}}|{{.MemUsage}}|{{.MemPerc}}|{{.NetIO}}|{{.BlockIO}}|{{.PIDs}}',
  ]);
  const statsMap = {};
  if (statsOut) {
    for (const l of statsOut.trim().split('\n').filter(Boolean)) {
      const [name, cpu, mem, memPct, net, block, pids] = l.split('|');
      statsMap[name] = { cpu, mem, memPct, net, block, pids };
    }
  }
  for (const c of containers) {
    Object.assign(c, statsMap[c.name] || { cpu: '-', mem: '-', memPct: '-', net: '-', block: '-', pids: '-' });
  }
  return { available: true, containers };
}

/* ---------------- 进程列表 ---------------- */
const CORE_COUNT = Math.max(1, os.cpus().length);
let prevProcCpu = {}; // pid -> 累计 CPU 秒（Windows 增量计算用）
let prevProcAt = 0;

async function readProcesses() {
  const topN = Math.max(1, parseInt(cfg.processTopN, 10) || 50);
  if (IS_LINUX) {
    // ps 直接输出累计 CPU%，按其排序
    const out = await runCmd('ps', [
      '-eo', 'pid,user,pcpu,pmem,rss,etime,args', '--sort=-pcpu', '--no-headers',
    ]);
    if (out === null) return { available: false, list: [], error: 'ps command unavailable' };
    const list = [];
    for (const line of out.split('\n')) {
      const m = line.match(/^\s*(\d+)\s+(\S+)\s+([\d.]+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s*(.*)$/);
      if (!m) continue;
      list.push({
        pid: +m[1],
        user: m[2],
        cpuPct: +(+m[3]).toFixed(1),
        memPct: +(+m[4]).toFixed(1),
        mem: +m[5] * 1024, // kB -> B
        etime: m[6],
        cmd: m[7] || m[2],
      });
      if (list.length >= topN) break; // ps 已排序
    }
    return { available: true, list, total: null };
  }

  // Windows：PowerShell 取全量进程累计 CPU 秒，两次采样差值折算 CPU%
  const script =
    'Get-Process | Where-Object { $_.CPU -ne $null } | ' +
    'ForEach-Object { "$($_.Id)|$($_.ProcessName)|$($_.CPU)|$($_.WorkingSet64)" }';
  const out = await runCmd(
    'powershell',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    15000
  );
  if (out === null) return { available: false, list: [], error: 'PowerShell process query failed' };
  const now = Date.now();
  const dtSec = prevProcAt ? Math.max(1, (now - prevProcAt) / 1000) : 0;
  const cur = {};
  const list = [];
  const totalMem = os.totalmem() || 1;
  for (const line of out.split('\n')) {
    const parts = line.trim().split('|');
    if (parts.length < 4) continue;
    const pid = +parts[0];
    const cpuSec = parseFloat(parts[2]);
    const ws = parseInt(parts[3], 10) || 0;
    if (!Number.isFinite(pid)) continue;
    cur[pid] = Number.isFinite(cpuSec) ? cpuSec : 0;
    let cpuPct = 0;
    if (dtSec > 0 && prevProcCpu[pid] != null) {
      const delta = cur[pid] - prevProcCpu[pid];
      if (delta > 0) cpuPct = +((delta / dtSec) * 100 / CORE_COUNT).toFixed(1);
    }
    list.push({
      pid,
      user: '-',
      cpuPct,
      memPct: +((ws / totalMem) * 100).toFixed(1),
      mem: ws,
      etime: '',
      cmd: parts[1],
    });
  }
  prevProcCpu = cur;
  prevProcAt = now;
  list.sort((a, b) => b.cpuPct - a.cpuPct || b.mem - a.mem);
  return { available: true, list: list.slice(0, topN), total: list.length };
}

/* ---------------- 状态快照与后台采样 ---------------- */

/* 局域网 IPv4 列表（排除回环与内部地址） */
function getLanIps() {
  const list = [];
  const nifs = os.networkInterfaces();
  for (const name of Object.keys(nifs || {})) {
    for (const n of nifs[name] || []) {
      if (n.family === 'IPv4' && !n.internal) list.push(n.address);
    }
  }
  return list;
}

/* 公网 IP 候选端点（依次尝试，取第一个可用） */
const WAN_IP_ENDPOINTS = [
  'https://api.ipify.org',
  'https://icanhazip.com',
  'https://ipinfo.io/ip',
];

/* 公网 IP：成功才写入，全部失败则静默等待下次重试 */
function fetchWanIp() {
  let idx = 0;
  const tryNext = () => {
    if (idx >= WAN_IP_ENDPOINTS.length) return;
    const url = WAN_IP_ENDPOINTS[idx++];
    const req = https.get(url, { timeout: 6000 }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => {
        body += c;
        if (body.length > 64) req.destroy();
      });
      res.on('end', () => {
        const ip = body.trim();
        if (/^(\d{1,3}\.){3}\d{1,3}$/.test(ip)) state.host.wanIp = ip;
        else tryNext();
      });
    });
    req.on('error', tryNext);
    req.on('timeout', () => req.destroy());
  };
  tryNext();
}

const state = {
  cpu: { usage: 0, cores: [], loadavg: null },
  mem: null,
  swap: null,
  temps: [],
  disks: [],
  docker: { available: false, containers: [], error: 'Collecting…' },
  processes: { available: false, list: [], error: 'Collecting…' },
  history: [], // 最近 120 个采样点 {t, cpu, mem}
  host: {
    hostname: os.hostname(),
    platform: os.platform(),
    release: os.release(),
    arch: os.arch(),
    cpuModel: (os.cpus()[0] && os.cpus()[0].model) || '',
    cpuCount: os.cpus().length,
    totalMem: os.totalmem(),
    uptime: os.uptime(),
    lanIp: getLanIps(), // 局域网 IPv4 列表
    wanIp: null,        // 公网 IP，由 fetchWanIp 异步填充
  },
  collectedAt: null,
};

async function collectCore() {
  state.cpu = sampleCpu();
  const m = await readMem();
  state.mem = m.mem;
  state.swap = m.swap;
  state.collectedAt = Date.now();
  state.history.push({
    t: Date.now(),
    cpu: state.cpu.usage,
    mem: state.mem ? state.mem.usagePct : 0,
  });
  if (state.history.length > 120) state.history.shift();
}

collectCore();
setInterval(collectCore, Math.max(500, cfg.collectInterval));
readTemps().then((t) => (state.temps = t));
setInterval(async () => (state.temps = await readTemps()), 5000);
readDisks().then((d) => (state.disks = d));
setInterval(async () => (state.disks = await readDisks()), 10000);
readDocker().then((d) => (state.docker = d));
setInterval(async () => (state.docker = await readDocker()), Math.max(2000, cfg.dockerInterval));
readProcesses().then((p) => (state.processes = p));
setInterval(async () => (state.processes = await readProcesses()), Math.max(3000, cfg.processInterval));

/* IP 刷新：启动即取，之后每 10 分钟同步一次（公网 IP 失败则下次自动重试） */
fetchWanIp();
setInterval(() => {
  state.host.lanIp = getLanIps();
  fetchWanIp();
}, 600000);

/* ---------------- 静态资源 ---------------- */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
};

function serveFile(res, filename) {
  const fp = path.join(PUBLIC_DIR, filename);
  if (!fp.startsWith(PUBLIC_DIR)) return send(res, 403, { error: 'forbidden' });
  fs.readFile(fp, (err, data) => {
    if (err) return send(res, 404, { error: 'not found' });
    send(res, 200, data, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' });
  });
}

/* ---------------- 终端（ttyd 子进程 + 零依赖代理）---------------- */
let ttydProc = null;          // 当前 ttyd 子进程；null 表示未运行
let ttydLastError = '';       // 最近一次启动/退出失败原因（供接口提示与排错）
let ttydRetryTimer = null;    // 启动失败后的重试定时器
let ttydRetryDelay = 0;       // 当前重试退避间隔 ms（存活时间够长后重置）
let shuttingDown = false;     // 进程正在退出，停止子进程重试
const TTYD_RETRY_MIN = 5000;  // 重试退避下限 ms
const TTYD_RETRY_MAX = 60000; // 重试退避上限 ms

/**
 * 拉起 ttyd 子进程（仅监听 127.0.0.1）。
 * 失败不永久禁用终端：记录原因并退避重试（端口被占用、ttyd 卸载等场景可自愈）。
 */
function startTtyd() {
  if (!cfg.terminal.enabled || shuttingDown || ttydProc) return;
  const args = ['-i', '127.0.0.1', '-p', String(cfg.terminal.ttydPort), ...cfg.terminal.ttydArgs];
  let proc;
  try {
    // stderr 保留用于诊断（如端口冲突时的 "Address already in use"），stdout 丢弃
    proc = spawn(cfg.terminal.ttydPath, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  } catch (e) {
    ttydLastError = e.message;
    console.warn('[warn] ttyd 启动失败，终端暂不可用，稍后重试:', e.message);
    scheduleTtydRetry();
    return;
  }
  ttydProc = proc;
  ttydLastError = '';
  const startedAt = Date.now();
  proc.stderr.on('data', (c) => process.stderr.write('[ttyd] ' + c));
  proc.on('error', (e) => {
    if (ttydProc !== proc) return;
    ttydProc = null;
    ttydLastError = e.message;
    console.warn('[warn] ttyd 不可用（未安装或无法执行），终端暂不可用，稍后重试:', e.message);
    scheduleTtydRetry();
  });
  proc.on('exit', (code, signal) => {
    if (ttydProc !== proc) return;
    ttydProc = null;
    ttydLastError = signal ? `被信号 ${signal} 终止` : `退出码 ${code}`;
    // 存活超 10s 视为正常启动过：重置退避，下次立刻重试；否则按启动失败继续退避
    if (Date.now() - startedAt > 10000) ttydRetryDelay = 0;
    console.warn(
      `[warn] ttyd 进程退出（${ttydLastError}），终端暂不可用，稍后重试` +
        `（请确认端口 ${cfg.terminal.ttydPort} 未被其他 ttyd 占用）`
    );
    scheduleTtydRetry();
  });
  console.log(`[sysprobe] ttyd 已拉起: 127.0.0.1:${cfg.terminal.ttydPort}  args=${args.join(' ')}`);
}

/** ttyd 启动失败时按退避策略重试（5s 起，上限 60s） */
function scheduleTtydRetry() {
  if (!cfg.terminal.enabled || shuttingDown || ttydRetryTimer) return;
  ttydRetryDelay = ttydRetryDelay ? Math.min(ttydRetryDelay * 2, TTYD_RETRY_MAX) : TTYD_RETRY_MIN;
  ttydRetryTimer = setTimeout(() => {
    ttydRetryTimer = null;
    startTtyd();
  }, ttydRetryDelay);
  ttydRetryTimer.unref?.();
}

/** 退出前清理 ttyd 子进程与重试定时器（systemd stop / Ctrl-C） */
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  if (ttydRetryTimer) {
    clearTimeout(ttydRetryTimer);
    ttydRetryTimer = null;
  }
  if (ttydProc) {
    ttydProc.kill('SIGTERM');
    ttydProc = null;
  }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('exit', () => {
  if (ttydProc) ttydProc.kill('SIGTERM');
});

/** HTTP 代理：/api/terminal/token → http://127.0.0.1:{port}/token */
function proxyTerminalToken(req, res) {
  const up = http.request(
    { host: '127.0.0.1', port: cfg.terminal.ttydPort, path: '/token', method: 'GET', timeout: 5000 },
    (ur) => {
      const chunks = [];
      ur.on('data', (c) => chunks.push(c));
      ur.on('end', () => {
        let body = Buffer.concat(chunks).toString('utf8');
        try { body = JSON.stringify(JSON.parse(body)); } catch { /* 非 JSON 时透传原文 */ }
        send(res, ur.statusCode || 502, body, { 'Content-Type': 'application/json; charset=utf-8' });
      });
    }
  );
  up.on('error', () => send(res, 502, { error: 'ttyd unreachable' }));
  up.on('timeout', () => {
    up.destroy();
    send(res, 502, { error: 'ttyd timeout' });
  });
  up.end();
}

/**
 * WebSocket 升级代理：/api/terminal/ws → ttyd /ws
 * 校验鉴权后，改写请求行/Host 并以裸 TCP 管道双向转发，
 * 无需实现 WS 帧编解码（对上下游完全透明）。
 */
function proxyTerminalWs(req, clientSocket, search) {
  const upstream = net.connect(cfg.terminal.ttydPort, '127.0.0.1', () => {
    const h = Object.assign({}, req.headers);
    h.host = `127.0.0.1:${cfg.terminal.ttydPort}`;
    delete h.cookie; // 不向 ttyd 泄露会话 Cookie
    let head = `GET /ws${search || ''} HTTP/1.1\r\n`;
    for (const [k, v] of Object.entries(h)) head += `${k}: ${v}\r\n`;
    head += '\r\n';
    upstream.write(head);
    clientSocket.pipe(upstream);
    upstream.pipe(clientSocket);
  });
  const teardown = () => {
    clientSocket.destroy();
    upstream.destroy();
  };
  clientSocket.on('error', teardown);
  upstream.on('error', teardown);
  clientSocket.on('close', teardown);
  upstream.on('close', teardown);
}

/* ---------------- 路由 ---------------- */
async function route(req, res, url) {
  let p = url.pathname;
  // 剥离 basePath 前缀
  if (BASE !== '/') {
    // 根路径 / 或 BASE 无斜杠 → 302 到 BASE/，保证相对路径资源（css/js/api）可解析
    if (p === '/' || p === BASE) return redirect(res, BASE + '/');
    if (p.startsWith(BASE + '/')) p = p.slice(BASE.length);
    else return send(res, 404, { error: 'not found' });
  }

  /* ---- 公开接口 ---- */
  if (p === '/api/health') return send(res, 200, { ok: true, basePath: BASE, hostname: os.hostname() });

  if (p === '/api/login' && req.method === 'POST') {
    let body;
    try {
      body = JSON.parse((await readBody(req)) || '{}');
    } catch {
      return send(res, 400, { error: 'Invalid request body' });
    }
    const pass = String(body.password || '');
    const ok = safeEqual(
      crypto.createHash('sha256').update(pass).digest('hex'),
      crypto.createHash('sha256').update(cfg.password).digest('hex')
    );
    if (!ok) {
      await new Promise((r) => setTimeout(r, 600)); // 简单防爆破
      return send(res, 401, { error: 'Incorrect password' });
    }
    const jwt = signJwt({
      sub: 'sysprobe',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + JWT_EXPIRES,
    });
    const cookie = [
      `${COOKIE_NAME}=${jwt}`,
      `Path=${BASE}`,
      'HttpOnly',
      'SameSite=Lax',
      `Max-Age=${JWT_EXPIRES}`,
    ].join('; ');
    return send(res, 200, { ok: true, token: jwt, expiresIn: JWT_EXPIRES }, { 'Set-Cookie': cookie });
  }

  /* ---- 需要鉴权的接口 ---- */
  if (p === '/api/metrics' || p === '/api/docker' || p === '/api/processes' || p === '/api/logout') {
    if (!checkAuth(req)) {
      return send(res, 401, { error: 'Unauthorized' }, { 'WWW-Authenticate': 'Bearer' });
    }
    if (p === '/api/metrics') {
      state.host.uptime = os.uptime();
      return send(res, 200, state);
    }
    if (p === '/api/docker') return send(res, 200, state.docker);
    if (p === '/api/processes') return send(res, 200, state.processes);
    if (p === '/api/logout') {
      const clear = `${COOKIE_NAME}=; Path=${BASE}; HttpOnly; SameSite=Lax; Max-Age=0`;
      return send(res, 200, { ok: true }, { 'Set-Cookie': clear });
    }
  }

  /* ---- 终端代理（ttyd，复用 JWT 鉴权）---- */
  if (p.startsWith('/api/terminal/')) {
    if (!checkAuth(req)) {
      return send(res, 401, { error: 'Unauthorized' }, { 'WWW-Authenticate': 'Bearer' });
    }
    if (!cfg.terminal.enabled) return send(res, 503, { error: 'Terminal disabled' });
    // 终端已启用但 ttyd 尚未就绪（未安装 / 端口被占用 / 正在重试）：明确区分于“未启用”
    if (!ttydProc) {
      return send(res, 503, { error: 'Terminal unavailable', detail: ttydLastError || 'ttyd 正在启动' });
    }
    if (p === '/api/terminal/token') return proxyTerminalToken(req, res);
    return send(res, 404, { error: 'not found' });
  }

  /* ---- 静态页面 ---- */
  if (SPA_MODE) {
    // SPA：页面路径统一返回 index.html，登录/仪表盘由前端鉴权态决定
    if (p === '/' || p === '/index.html' || p === '/login') {
      return serveFile(res, 'index.html');
    }
  } else {
    if (p === '/login') return serveFile(res, 'login.html');

    if (p === '/' || p === '/index.html') {
      if (!checkAuth(req)) return serveFile(res, 'login.html'); // 未验证 → 登录页
      return serveFile(res, 'index.html');
    }
  }

  // 静态资源：SPA 构建产物（assets/ 带 hash 文件）或旧 public 白名单
  if (p.startsWith('/assets/') || p === '/style.css' || p === '/app.js' || p === '/favicon.svg') {
    return serveFile(res, p.slice(1));
  }

  return send(res, 404, { error: 'not found' });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    await route(req, res, url);
  } catch (e) {
    send(res, 500, { error: String((e && e.message) || e) });
  }
});

/* WebSocket 升级：仅放行鉴权后的终端代理路径（与 route() 相同的 BASE 前缀剥离逻辑） */
server.on('upgrade', (req, socket) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    let p = url.pathname;
    if (BASE !== '/') {
      if (p === BASE || p === BASE + '/') p = '/';
      else if (p.startsWith(BASE + '/')) p = p.slice(BASE.length);
      else { socket.destroy(); return; }
    }
    if (p !== '/api/terminal/ws') { socket.destroy(); return; }
    if (!cfg.terminal.enabled || !ttydProc || !checkAuth(req)) { socket.destroy(); return; }
    proxyTerminalWs(req, socket, url.search);
  } catch {
    socket.destroy();
  }
});

startTtyd();

server.listen(cfg.port, cfg.host, () => {
  console.log(`[sysprobe] listening on http://${cfg.host}:${cfg.port}${BASE === '/' ? '/' : BASE}`);
  console.log(`[sysprobe] basePath=${BASE}  鉴权已启用（密码来自 config.json）`);
});
