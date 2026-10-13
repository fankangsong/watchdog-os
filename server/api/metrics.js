/**
 * 指标采集模块（MonitorApp / DockerApp 数据源）：
 * CPU / 内存 / 温度 / 磁盘 / Docker / 进程采集 + 局域网/公网 IP + state 快照。
 * 从 server.js 原样搬移（原 267-634 行）；原文件顶部的立即执行采样改为
 * startCollectTimers() 由入口显式启动，其余函数体不变。
 */
'use strict';

const https = require('https'); // 仅 fetchWanIp 使用（公网 IP 查询走 HTTPS）
const fsp = require('fs').promises;
const os = require('os');
const path = require('path');
const { cfg } = require('../config');
const { runCmd } = require('../lib/http');

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
  printer: { available: false, printers: [], activeJobs: [], history: [], error: 'Collecting…' },
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

/** 启动全部后台采集定时器（入口调用一次；语义与原 server.js 模块加载期行为一致） */
function startCollectTimers() {
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
}

module.exports = { state, startCollectTimers };
