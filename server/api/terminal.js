/**
 * 终端模块（TerminalApp 数据源）：ttyd 子进程生命周期管理（启动 / 退避重试 / WSL 清理）
 * 与零依赖代理（token HTTP 转发 + WS 裸 TCP 管道升级转发）。
 * 从 server.js 原样搬移（原 661-743、1077-1124 行）；
 * shutdown 所需的清理能力封装为 stopTerminal() / cleanupSync() 供入口调用。
 */
'use strict';

const http = require('http');
const net = require('net');
const { spawn } = require('child_process');
const { cfg } = require('../config');
const { send } = require('../lib/http');

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
  // stderr 透传做双重防御：父进程 stderr 管道异常（EPIPE 等）不得冒成未捕获异常打翻主服务
  proc.stderr.on('data', (c) => {
    try {
      process.stderr.write('[ttyd] ' + c);
    } catch { /* 父进程 stderr 不可写：丢弃诊断输出，不影响 ttyd 生命周期与主服务 */ }
  });
  proc.stderr.on('error', () => { /* stderr 管道错误忽略，避免冒泡为未捕获异常 */ });
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

/** 终端是否就绪（ttyd 子进程存活）；路由据此区分 503 disabled / unavailable */
function ttydReady() {
  return !!ttydProc;
}

/** 最近一次启动/退出失败原因（供接口 detail 提示） */
function ttydError() {
  return ttydLastError;
}

/**
 * 退出前清理（SIGINT/SIGTERM）：停止重试定时器并 SIGTERM ttyd 子进程。
 * 行为与原 server.js 的 shutdown() 中 ttyd 段一致。
 */
function stopTerminal() {
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
}

/** process 'exit' 阶段的同步兜底清理（与原 exit handler 的 ttyd 段一致） */
function cleanupSync() {
  if (ttydProc) {
    ttydProc.kill('SIGTERM');
    if (cfg.terminal.wsl) killWslTtyd();
  }
}

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
    // 不向 ttyd 泄露任何会话凭据（纵深防御：服务端鉴权只用 Cookie，这些头本不该出现）
    delete h.cookie;
    delete h.authorization;
    delete h['x-auth-token'];
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

module.exports = {
  startTerminal: startTtyd,
  stopTerminal,
  cleanupSync,
  ttydReady,
  ttydError,
  proxyTerminalToken,
  proxyTerminalWs,
};
