#!/usr/bin/env node
/**
 * 系统探针监控服务（零依赖 Node.js）
 *
 * 功能：
 *  - 采集 CPU / 内存 / 交换分区 / 硬件温度 / 磁盘使用率
 *  - 采集 Docker 容器列表与资源占用（docker stats）
 *  - 文件管理：目录浏览 / 上传下载 / 文本读写 / 收藏夹（/api/fs/*）
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
    wsl: false,              // Windows 下经由 WSL 运行 Linux 版 ttyd（忽略 ttydPath，固定用 wsl.exe）
  },
  cfg.terminal
);
if (!Array.isArray(cfg.terminal.ttydArgs)) cfg.terminal.ttydArgs = ['bash'];
/* Runner 配置：远程触发脚本任务（如 running_page 的 build.sh）。
   scriptPath 为必配项且只允许服务端配置（config.json / RUNNER_SCRIPT），客户端不可传路径 */
cfg.runner = Object.assign(
  {
    enabled: false,               // 是否启用 Runner API
    scriptPath: '',               // 要执行的脚本绝对路径（必配）
    shell: 'bash',                // 执行 shell（Linux 服务器默认 bash）
    maxLogBytes: 5 * 1024 * 1024, // 日志轮转阈值，超过则 rename 为 .old
  },
  cfg.runner
);
if (process.env.PORT) cfg.port = parseInt(process.env.PORT, 10);
if (process.env.PASSWORD) cfg.password = process.env.PASSWORD;
if (process.env.BASE_PATH) cfg.basePath = process.env.BASE_PATH;
if (process.env.TERMINAL_ENABLED != null) {
  cfg.terminal.enabled = ['1', 'true', 'yes', 'on'].includes(String(process.env.TERMINAL_ENABLED).toLowerCase());
}
if (process.env.TTYD_PATH) cfg.terminal.ttydPath = process.env.TTYD_PATH;
if (process.env.TTYD_PORT) cfg.terminal.ttydPort = parseInt(process.env.TTYD_PORT, 10) || cfg.terminal.ttydPort;
if (process.env.TTYD_WSL != null) {
  cfg.terminal.wsl = ['1', 'true', 'yes', 'on'].includes(String(process.env.TTYD_WSL).toLowerCase());
}
if (process.env.RUNNER_ENABLED != null) {
  cfg.runner.enabled = ['1', 'true', 'yes', 'on'].includes(String(process.env.RUNNER_ENABLED).toLowerCase());
}
if (process.env.RUNNER_SCRIPT) cfg.runner.scriptPath = process.env.RUNNER_SCRIPT;
if (process.env.RUNNER_SHELL) cfg.runner.shell = process.env.RUNNER_SHELL;

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

/** WSL 模式的启动命令：先清理 WSL 内残留的 ttyd，再以登录环境拉起（~/.profile 的 PATH 生效）；
 *  -W 开启可写（ttyd 1.7.x 起默认只读模式，不加则键盘输入无效） */
const WSL_TTYD_CMD = 'pkill -x ttyd 2>/dev/null; exec ttyd -W "$@"';

/**
 * 拉起 ttyd 子进程（仅监听 127.0.0.1）。
 * 失败不永久禁用终端：记录原因并退避重试（端口被占用、ttyd 卸载等场景可自愈）。
 */
function startTtyd() {
  if (!cfg.terminal.enabled || shuttingDown || ttydProc) return;
  let cmd = cfg.terminal.ttydPath;
  let args = ['-i', '127.0.0.1', '-p', String(cfg.terminal.ttydPort), ...cfg.terminal.ttydArgs];
  if (cfg.terminal.wsl && process.platform === 'win32') {
    // Windows 本地联调：经 WSL 运行 Linux 版 ttyd，WSL2 会把 WSL 内监听的端口
    // 自动转发到 Windows 的 127.0.0.1；经 bash 登录环境启动以保证 ~/.local/bin 下的 ttyd 可见。
    // 仅 Windows 生效：同一目录在 WSL 内运行时忽略该开关，走原生 ttyd。
    cmd = 'wsl.exe';
    args = ['-e', 'bash', '-lc', WSL_TTYD_CMD, 'bash', ...args];
  }
  let proc;
  try {
    // stderr 保留用于诊断（如端口冲突时的 "Address already in use"），stdout 丢弃
    proc = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
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

/** WSL 模式兜底：终止 Windows 侧 wsl.exe 不保证 WSL 内 ttyd 退出，需显式清理 Linux 侧进程 */
function killWslTtyd() {
  if (process.platform !== 'win32') return;
  try {
    spawn('wsl.exe', ['-e', 'pkill', '-x', 'ttyd'], { stdio: 'ignore', windowsHide: true });
  } catch { /* 清理失败忽略 */ }
}

/* ---------------- Runner（脚本任务：远程触发 + 日志回读）---------------- */
const RUNNER_LOG_DIR = path.join(__dirname, 'data');
const RUNNER_LOG_FILE = path.join(RUNNER_LOG_DIR, 'runner.log');
const RUNNER_LOG_OLD = RUNNER_LOG_FILE + '.old';
let runnerProc = null;  // 当前脚本子进程；null 表示空闲
let runnerJob = null;   // 当前 job 元信息 { id, startedAt, script }
let runnerLast = null;  // 最近一次结束的 job 摘要 { id, startedAt, finishedAt, exitCode, failed, durationMs }

/** 生成 job id：YYYYMMDD-HHmmss-xxxx（本地时间 + 4 位随机 hex） */
function runnerNewJobId() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const rnd = crypto.randomBytes(2).toString('hex');
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${rnd}`
  );
}

/**
 * 启动脚本任务。返回 { job } 或 { error, ... }；错误码由路由映射：
 * 'Job already running'→409、'Script not found'→400、其余→500（'Runner disabled' 已由路由先行拦截，此处为防御）
 */
function startRunnerJob() {
  const r = cfg.runner;
  if (runnerProc) return { error: 'Job already running', job: runnerJob };
  if (!r.enabled || !r.scriptPath) return { error: 'Runner disabled' };
  const scriptAbs = path.resolve(r.scriptPath);
  let st = null;
  try {
    st = fs.statSync(scriptAbs);
  } catch { /* 不存在 → 下方 400 */ }
  if (!st || !st.isFile()) return { error: 'Script not found' };

  try { fs.mkdirSync(RUNNER_LOG_DIR, { recursive: true }); } catch { /* 已存在忽略 */ }
  // 日志轮转：上次日志超阈值则归档为 .old（构建日志量大，防止单文件无限增长）
  try {
    if (fs.existsSync(RUNNER_LOG_FILE) && fs.statSync(RUNNER_LOG_FILE).size > r.maxLogBytes) {
      fs.renameSync(RUNNER_LOG_FILE, RUNNER_LOG_OLD);
    }
  } catch { /* 轮转失败不阻塞构建 */ }

  const job = { id: runnerNewJobId(), startedAt: Date.now(), script: scriptAbs };
  try {
    fs.appendFileSync(RUNNER_LOG_FILE, `\n===== [${new Date(job.startedAt).toISOString()}] job ${job.id}\n===== $ ${r.shell} ${scriptAbs}\n`, 'utf8');
  } catch { /* 日志失败不阻塞构建 */ }

  let proc;
  try {
    // 用相对文件名 + cwd 定位脚本：Windows 下 Git Bash 不识别 C:\ 绝对路径（exit 127），
    // Linux 绝对路径虽可用，但相对名 + cwd 在两平台行为一致；build.sh 类脚本用 BASH_SOURCE 自定位目录，不受影响
    proc = spawn(r.shell, [path.basename(scriptAbs)], {
      cwd: path.dirname(scriptAbs),
      // 注入 git safe.directory：服务用户（如 systemd root）与仓库属主不一致时，
      // git 会报 "detected dubious ownership in repository" 而失败。
      // 用 GIT_CONFIG_* 环境变量注入，不依赖运行用户的 HOME/全局 gitconfig；
      // 脚本路径只来自服务端配置，放开所有权检查不扩大攻击面。
      env: {
        ...process.env,
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'safe.directory',
        GIT_CONFIG_VALUE_0: '*',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
  } catch (e) {
    try { fs.appendFileSync(RUNNER_LOG_FILE, `[spawn error] ${e.message}\n`, 'utf8'); } catch { /* 忽略 */ }
    return { error: 'Spawn failed', detail: e.message };
  }
  runnerProc = proc;
  runnerJob = job;
  const append = (c) => {
    try { fs.appendFileSync(RUNNER_LOG_FILE, c, 'utf8'); } catch { /* 磁盘异常丢日志不崩服务 */ }
  };
  proc.stdout.on('data', append);
  proc.stderr.on('data', append);
  proc.on('error', (e) => append(`[spawn error] ${e.message}\n`));
  proc.on('exit', (code, signal) => {
    append(`[exit code ${code === null ? `null(${signal})` : code}]\n`);
    if (runnerProc !== proc) return;
    const finishedAt = Date.now();
    runnerLast = {
      id: job.id,
      startedAt: job.startedAt,
      finishedAt,
      exitCode: code,
      failed: code !== 0,
      durationMs: finishedAt - job.startedAt,
    };
    runnerProc = null;
    runnerJob = null;
  });
  console.log(`[sysprobe] runner 已启动: job=${job.id} script=${scriptAbs}`);
  return { job };
}

/** 停止当前任务（SIGTERM）；有任务返回 true */
function stopRunnerJob() {
  if (runnerProc) {
    runnerProc.kill('SIGTERM');
    return true;
  }
  return false;
}

/** 读日志尾部 lines 行（文件受 maxLogBytes 轮转约束，整体读入取尾即可） */
function runnerReadLog(lines) {
  try {
    const arr = fs.readFileSync(RUNNER_LOG_FILE, 'utf8').split('\n');
    // 文件以换行结尾时 split 会多出一个尾部空串，先去掉再取尾，保证 lines=1 能取到最后一行内容
    if (arr.length && arr[arr.length - 1] === '') arr.pop();
    return arr.slice(Math.max(0, arr.length - lines)).join('\n');
  } catch {
    return '';
  }
}

/** 组装 status 响应体（lines 已由路由裁剪） */
function runnerStatusPayload(lines) {
  return {
    enabled: !!(cfg.runner.enabled && cfg.runner.scriptPath),
    script: cfg.runner.scriptPath || '',
    running: !!runnerProc,
    job: runnerJob ? { ...runnerJob, exitCode: null, finishedAt: null } : null,
    last: runnerLast,
    log: runnerReadLog(lines),
  };
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
    if (cfg.terminal.wsl) killWslTtyd();
    ttydProc = null;
  }
  if (runnerProc) {
    try { runnerProc.kill('SIGTERM'); } catch { /* 已退出忽略 */ }
    runnerProc = null;
  }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('exit', () => {
  if (ttydProc) {
    ttydProc.kill('SIGTERM');
    if (cfg.terminal.wsl) killWslTtyd();
  }
  if (runnerProc) {
    try { runnerProc.kill('SIGTERM'); } catch { /* 已退出忽略 */ }
  }
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

/* ---------------- 文件管理（零依赖 fs API） ---------------- */
/* 允许浏览的根目录：默认 Windows 列出项目所在盘符与 C 盘，POSIX 为根目录；
   可用环境变量 FS_ROOTS 覆盖（按 path.delimiter 分隔，如 "C:\;D:\" 或 "/data:/home"）。 */
const FS_ROOTS = (() => {
  const raw = process.env.FS_ROOTS;
  const list = (raw
    ? raw.split(path.delimiter)
    : process.platform === 'win32'
      ? [process.cwd().slice(0, 3), 'C:\\']
      : ['/']
  )
    .map((s) => s.trim())
    .filter(Boolean)
    .map((r) => path.resolve(r));
  const out = [];
  const seen = new Set();
  for (const r of list) {
    const key = process.platform === 'win32' ? r.toLowerCase() : r;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(r);
    }
  }
  return out;
})();

const FS_MAX_TEXT = 2 * 1024 * 1024;    // 文本读取/保存上限 2MB
const FS_MAX_UPLOAD = 50 * 1024 * 1024; // 上传单文件上限 50MB
const FS_FAV_MAX = 100;                 // 收藏夹条目上限
const FS_DATA_DIR = path.join(__dirname, 'data');
const FS_FAV_FILE = path.join(FS_DATA_DIR, 'favorites.json');

/* 图片扩展名：raw 接口唯一允许内联输出的类型（其余一律 attachment 下载，防止内联 HTML/XSS） */
const FS_IMAGE_EXT = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.avif', '.svg'];
/* 视为文本的扩展名（决定前端“可预览/可编辑”提示；read 接口对任何文件都会再做二进制嗅探兜底） */
const FS_TEXT_EXT = new Set([
  '.txt', '.log', '.md', '.markdown', '.json', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf',
  '.xml', '.html', '.htm', '.css', '.scss', '.less', '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx',
  '.py', '.rb', '.go', '.rs', '.java', '.kt', '.c', '.h', '.cpp', '.hpp', '.cs', '.php', '.sh',
  '.bash', '.zsh', '.fish', '.ps1', '.psm1', '.sql', '.properties', '.gradle', '.cmake',
  '.vue', '.svelte', '.astro', '.graphql', '.proto', '.patch', '.diff', '.csv', '.service',
]);
const FS_RAW_MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.bmp': 'image/bmp', '.ico': 'image/x-icon',
  '.avif': 'image/avif',
};

/** 解析用户传入路径为绝对路径（统一 resolve 规范化防穿越），非法返回 null */
function fsResolve(raw) {
  if (raw == null) return null;
  let p;
  try {
    p = decodeURIComponent(String(raw));
  } catch {
    return null;
  }
  p = p.trim().replace(/\u0000/g, '');
  if (!p) return null;
  return path.resolve(p);
}

/** 校验绝对路径位于允许的根之内（Windows 根比较不区分大小写） */
function fsAllowed(abs) {
  const norm = process.platform === 'win32' ? abs.toLowerCase() : abs;
  return FS_ROOTS.some((root) => {
    const r = process.platform === 'win32' ? root.toLowerCase() : root;
    if (r === '/' || r === path.sep) return norm.startsWith('/');
    const rr = r.endsWith(path.sep) ? r : r + path.sep;
    return norm === r || norm.startsWith(rr);
  });
}

/** 判断路径是否为允许根目录本身（根目录不可删除/重命名） */
function fsIsRoot(abs) {
  const norm = process.platform === 'win32' ? abs.toLowerCase() : abs;
  return FS_ROOTS.some((root) => (process.platform === 'win32' ? root.toLowerCase() : root) === norm);
}

/** Unix 风格权限串，如 rwxr-xr-x */
function fsModeString(mode) {
  const s = 'rwxrwxrwx';
  let out = '';
  for (let i = 0; i < 9; i++) out += (mode >> (8 - i)) & 1 ? s[i] : '-';
  return out;
}

/** 前端预览能力标记：image 内联图 / markdown 渲染 / text 编辑器 / none 仅下载 */
function fsPreviewKind(name, isDir) {
  if (isDir) return 'none';
  const base = path.basename(name);
  const ext = path.extname(base).toLowerCase();
  if (FS_IMAGE_EXT.includes(ext)) return 'image';
  if (ext === '.md' || ext === '.markdown') return 'markdown';
  if (FS_TEXT_EXT.has(ext)) return 'text';
  // 无扩展名（Makefile/LICENSE）与点文件（.env/.gitignore）多为文本，read 接口有二进制嗅探兜底
  if (!ext || base.startsWith('.')) return 'text';
  return 'none';
}

function fsEntryFromStat(baseDir, name, st) {
  const isDir = st.isDirectory();
  return {
    name,
    path: path.join(baseDir, name),
    type: isDir ? 'dir' : 'file',
    size: isDir ? 0 : st.size,
    mtime: Math.floor(st.mtimeMs),
    mode: fsModeString(st.mode),
    previewable: fsPreviewKind(name, isDir),
  };
}

/** 目录在前、名称自然排序（数字感知，config10 排在 config2 之后） */
function fsSortEntries(list) {
  list.sort((a, b) =>
    a.type !== b.type
      ? a.type === 'dir' ? -1 : 1
      : a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
  );
}

/** 清洗文件/目录名：仅取 basename，剔除分隔符与控制字符；非法返回 null */
function fsSafeName(raw) {
  const base = path
    .basename(String(raw == null ? '' : raw))
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '')
    .trim();
  if (!base || base === '.' || base === '..') return null;
  return base;
}

/** 读取小体积 JSON body；解析失败返回 null */
async function fsJson(req) {
  try {
    return JSON.parse((await readBody(req, 64 * 1024)) || '{}');
  } catch {
    return null;
  }
}

/** 流式接收请求 body 写入目标文件（限 maxBytes），返回写入字节数；中途失败清理半截文件 */
function fsReceiveFile(req, destAbs, maxBytes) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let settled = false;
    const out = fs.createWriteStream(destAbs, { flags: 'w' });
    const fail = (err) => {
      if (settled) return;
      settled = true;
      out.destroy();
      fsp.unlink(destAbs).catch(() => {});
      req.resume();
      reject(err);
    };
    req.on('data', (c) => {
      if (settled) return;
      size += c.length;
      if (size > maxBytes) return fail(new Error('上传超过大小限制'));
      if (!out.write(c)) {
        req.pause();
        out.once('drain', () => req.resume());
      }
    });
    req.on('end', () => {
      out.end(() => {
        if (settled) return;
        settled = true;
        resolve(size);
      });
    });
    req.on('error', fail);
    out.on('error', fail);
  });
}

/** 读取文本文件：超限（tooLarge）或二进制（含 NUL 字节，binary）时返回标记而不返回内容 */
async function fsReadText(abs) {
  const st = await fsp.stat(abs);
  if (!st.isFile()) throw Object.assign(new Error('不是常规文件'), { code: 'EISDIR' });
  const meta = { size: st.size, mtime: Math.floor(st.mtimeMs) };
  if (st.size > FS_MAX_TEXT) return { ...meta, tooLarge: true };
  const buf = await fsp.readFile(abs);
  if (buf.subarray(0, 8192).includes(0)) return { ...meta, binary: true };
  return { ...meta, content: buf.toString('utf8') };
}

/* 收藏夹：持久化到 data/favorites.json（惰性加载 + 临时文件原子替换写） */
let fsFavorites = null;
async function fsLoadFavorites() {
  if (fsFavorites) return fsFavorites;
  try {
    const j = JSON.parse(await fsp.readFile(FS_FAV_FILE, 'utf8'));
    fsFavorites = Array.isArray(j.favorites) ? j.favorites.filter((x) => typeof x === 'string') : [];
  } catch {
    fsFavorites = [];
  }
  return fsFavorites;
}

async function fsSaveFavorites(list) {
  await fsp.mkdir(FS_DATA_DIR, { recursive: true });
  const tmp = `${FS_FAV_FILE}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify({ favorites: list }, null, 2) + '\n', 'utf8');
  await fsp.rename(tmp, FS_FAV_FILE);
  fsFavorites = list;
}

/** 文件管理 API 分发（进入前已完成 checkAuth，路径均已剥离 BASE 前缀） */
async function fsRoute(req, res, p, url) {
  try {
    const q = url.searchParams;
    const method = req.method || 'GET';

    /* GET /api/fs/list：列目录；不传 path 时返回允许的根列表（供目录树初始化） */
    if (p === '/api/fs/list' && method === 'GET') {
      const raw = q.get('path');
      if (!raw || !raw.trim()) {
        const entries = FS_ROOTS.map((r) => ({
          name: process.platform === 'win32' ? r : '根目录',
          path: r,
          type: 'dir',
          size: 0,
          mtime: 0,
          mode: '',
          previewable: 'none',
        }));
        return send(res, 200, { path: '', roots: FS_ROOTS, entries });
      }
      const abs = fsResolve(raw);
      if (!abs || !fsAllowed(abs)) return send(res, 403, { error: '路径不在允许范围内' });
      const st = await fsp.stat(abs).catch(() => null);
      if (!st) return send(res, 404, { error: '目录不存在' });
      if (!st.isDirectory()) return send(res, 400, { error: '不是目录' });
      const items = await fsp.readdir(abs, { withFileTypes: true }).catch(() => null);
      if (!items) return send(res, 403, { error: '目录不可读（权限不足）' });
      const entries = [];
      for (const it of items) {
        // stat 失败（悬空软链 / 无权限）的条目直接跳过
        const st2 = await fsp.stat(path.join(abs, it.name)).catch(() => null);
        if (st2) entries.push(fsEntryFromStat(abs, it.name, st2));
      }
      fsSortEntries(entries);
      return send(res, 200, { path: abs, roots: FS_ROOTS, entries });
    }

    /* GET /api/fs/read：读文本（2MB 上限 + NUL 二进制嗅探） */
    if (p === '/api/fs/read' && method === 'GET') {
      const abs = fsResolve(q.get('path'));
      if (!abs || !fsAllowed(abs)) return send(res, 403, { error: '路径不在允许范围内' });
      const st = await fsp.stat(abs).catch(() => null);
      if (!st) return send(res, 404, { error: '文件不存在' });
      if (!st.isFile()) return send(res, 400, { error: '不是常规文件' });
      const info = await fsReadText(abs);
      return send(res, 200, { path: abs, name: path.basename(abs), ...info });
    }

    /* GET /api/fs/raw：原始文件流。仅图片允许内联（<img> 预览），其余一律 attachment 下载。
       注意：不设 Content-Length —— ReFS/Dev Drive 上刚写入文件的 stat.size 可能是
       预分配值（元数据延迟），按实际流读取到 EOF 输出（chunked）才不会截断或虚报。 */
    if (p === '/api/fs/raw' && method === 'GET') {
      const abs = fsResolve(q.get('path'));
      if (!abs || !fsAllowed(abs)) return send(res, 403, { error: '路径不在允许范围内' });
      const st = await fsp.stat(abs).catch(() => null);
      if (!st || !st.isFile()) return send(res, 404, { error: '文件不存在' });
      const ext = path.extname(abs).toLowerCase();
      const inline = FS_IMAGE_EXT.includes(ext) && q.get('download') !== '1';
      res.writeHead(200, {
        'Content-Type': inline ? FS_RAW_MIME[ext] || 'application/octet-stream' : 'application/octet-stream',
        'Cache-Control': 'no-store',
        'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(path.basename(abs))}`,
      });
      const stream = fs.createReadStream(abs);
      stream.on('error', () => res.destroy());
      stream.pipe(res);
      return;
    }

    /* PUT /api/fs/write：保存文本内容（body 为 UTF-8 原文） */
    if (p === '/api/fs/write' && method === 'PUT') {
      const abs = fsResolve(q.get('path'));
      if (!abs || !fsAllowed(abs)) return send(res, 403, { error: '路径不在允许范围内' });
      let body;
      try {
        body = await readBody(req, FS_MAX_TEXT + 1);
      } catch {
        return send(res, 413, { error: '内容超过大小限制' });
      }
      if (Buffer.byteLength(body, 'utf8') > FS_MAX_TEXT) return send(res, 413, { error: '内容超过大小限制' });
      await fsp.writeFile(abs, body, 'utf8');
      const st = await fsp.stat(abs);
      return send(res, 200, { ok: true, path: abs, size: st.size, mtime: Math.floor(st.mtimeMs) });
    }

    /* POST /api/fs/upload：raw body 流式上传到 path 目录下（?name= 文件名，?overwrite=1 覆盖） */
    if (p === '/api/fs/upload' && method === 'POST') {
      const abs = fsResolve(q.get('path'));
      if (!abs || !fsAllowed(abs)) return send(res, 403, { error: '路径不在允许范围内' });
      const name = fsSafeName(q.get('name') || '');
      if (!name) return send(res, 400, { error: '文件名非法' });
      const dest = path.join(abs, name);
      const st = await fsp.stat(dest).catch(() => null);
      if (st && q.get('overwrite') !== '1') return send(res, 409, { error: '同名文件已存在' });
      if (st && !st.isFile()) return send(res, 400, { error: '同名路径不是文件' });
      const size = await fsReceiveFile(req, dest, FS_MAX_UPLOAD).catch((e) => {
        send(res, 400, { error: (e && e.message) || '上传失败' });
        return null;
      });
      if (size == null) return;
      return send(res, 200, { ok: true, path: dest, name, size });
    }

    /* POST /api/fs/mkdir：递归创建目录 */
    if (p === '/api/fs/mkdir' && method === 'POST') {
      const body = await fsJson(req);
      if (!body) return send(res, 400, { error: 'Invalid request body' });
      const abs = fsResolve(body.path);
      if (!abs || !fsAllowed(abs)) return send(res, 403, { error: '路径不在允许范围内' });
      await fsp.mkdir(abs, { recursive: true });
      return send(res, 200, { ok: true, path: abs });
    }

    /* POST /api/fs/delete：删除文件/目录（递归；根目录禁止删除） */
    if (p === '/api/fs/delete' && method === 'POST') {
      const body = await fsJson(req);
      if (!body) return send(res, 400, { error: 'Invalid request body' });
      const abs = fsResolve(body.path);
      if (!abs || !fsAllowed(abs)) return send(res, 403, { error: '路径不在允许范围内' });
      if (fsIsRoot(abs)) return send(res, 403, { error: '不能删除根目录' });
      await fsp.rm(abs, { recursive: true, force: false });
      return send(res, 200, { ok: true });
    }

    /* POST /api/fs/rename：重命名（仅目录内改名，不做移动） */
    if (p === '/api/fs/rename' && method === 'POST') {
      const body = await fsJson(req);
      if (!body) return send(res, 400, { error: 'Invalid request body' });
      const abs = fsResolve(body.path);
      if (!abs || !fsAllowed(abs)) return send(res, 403, { error: '路径不在允许范围内' });
      if (fsIsRoot(abs)) return send(res, 403, { error: '不能重命名根目录' });
      const name = fsSafeName(body.name);
      if (!name) return send(res, 400, { error: '文件名非法' });
      const dest = path.join(path.dirname(abs), name);
      const exists = await fsp.stat(dest).catch(() => null);
      if (exists) return send(res, 409, { error: '目标名称已存在' });
      await fsp.rename(abs, dest);
      return send(res, 200, { ok: true, path: dest });
    }

    /* GET/PUT /api/fs/favorites：收藏目录列表（服务端持久化，跨浏览器生效） */
    if (p === '/api/fs/favorites' && method === 'GET') {
      return send(res, 200, { favorites: await fsLoadFavorites() });
    }
    if (p === '/api/fs/favorites' && method === 'PUT') {
      const body = await fsJson(req);
      if (!body) return send(res, 400, { error: 'Invalid request body' });
      const list = Array.isArray(body.favorites) ? body.favorites : [];
      const out = [];
      const seen = new Set();
      for (const item of list.slice(0, FS_FAV_MAX)) {
        const abs = fsResolve(item);
        if (!abs || !fsAllowed(abs)) continue;
        const key = process.platform === 'win32' ? abs.toLowerCase() : abs;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(abs);
      }
      await fsSaveFavorites(out);
      return send(res, 200, { ok: true, favorites: out });
    }

    return send(res, 404, { error: 'not found' });
  } catch (e) {
    const code = (e && e.code) || '';
    if (code === 'ENOENT') return send(res, 404, { error: '文件或目录不存在' });
    if (code === 'EACCES' || code === 'EPERM') return send(res, 403, { error: '权限不足' });
    if (code === 'EISDIR') return send(res, 400, { error: '是目录而非文件' });
    if (code === 'ENOTDIR') return send(res, 400, { error: '不是目录' });
    if (code === 'EEXIST') return send(res, 409, { error: '已存在同名文件或目录' });
    if (code === 'ENOSPC') return send(res, 507, { error: '磁盘空间不足' });
    if (code === 'EBUSY' || code === 'EBUSY resource busy or locked') return send(res, 409, { error: '文件被占用' });
    return send(res, 500, { error: (e && e.message) || String(e) });
  }
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

  /* ---- 文件管理 API（零依赖 fs 操作，统一 JWT 鉴权）---- */
  if (p.startsWith('/api/fs/')) {
    if (!checkAuth(req)) {
      return send(res, 401, { error: 'Unauthorized' }, { 'WWW-Authenticate': 'Bearer' });
    }
    return fsRoute(req, res, p, url);
  }

  /* ---- Runner API（脚本任务触发，统一 JWT 鉴权）---- */
  if (p.startsWith('/api/runner/')) {
    if (!checkAuth(req)) {
      return send(res, 401, { error: 'Unauthorized' }, { 'WWW-Authenticate': 'Bearer' });
    }
    // status 是信息性接口：未启用时也返回 200 + enabled=false，便于前端区分"未配置"与"服务异常"
    if (p === '/api/runner/status' && req.method === 'GET') {
      const q = url.searchParams;
      let lines = parseInt(q.get('lines') || '300', 10);
      if (!Number.isFinite(lines) || lines < 1) lines = 300;
      lines = Math.min(lines, 2000);
      return send(res, 200, runnerStatusPayload(lines));
    }
    if (!cfg.runner.enabled || !cfg.runner.scriptPath) {
      return send(res, 503, { error: 'Runner disabled' });
    }
    if (p === '/api/runner/start' && req.method === 'POST') {
      const r = startRunnerJob();
      if (r.error === 'Job already running') return send(res, 409, { error: r.error, job: r.job });
      if (r.error === 'Script not found') return send(res, 400, { error: r.error });
      if (r.error) return send(res, 500, { error: r.error, detail: r.detail || '' });
      return send(res, 200, { ok: true, jobId: r.job.id, startedAt: r.job.startedAt, script: r.job.script });
    }
    if (p === '/api/runner/stop' && req.method === 'POST') {
      if (!stopRunnerJob()) return send(res, 409, { error: 'No job running' });
      return send(res, 200, { ok: true, job: runnerJob });
    }
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
