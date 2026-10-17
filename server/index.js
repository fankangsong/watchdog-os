#!/usr/bin/env node
/**
 * 系统探针监控服务（零依赖 Node.js）—— 瘦入口
 *
 * 功能（实现按模块拆分在同级目录下，本文件只负责组装与生命周期）：
 *  - config.js        配置加载（.env，唯一配置来源）
 *  - lib/http.js      HTTP 基础工具
 *  - lib/auth.js      JWT 鉴权
 *  - api/metrics.js   指标采集（MonitorApp / DockerApp）
 *  - api/printer.js   打印机采集
 *  - api/terminal.js  终端 ttyd 代理（TerminalApp）
 *  - api/runner.js    脚本任务（RunnerApp）
 *  - api/chat.js      Hermes 聊天代理（ImcolinApp）
 *  - api/fs.js        文件管理（FinderApp / EditorApp）
 *  - static.js        静态资源服务
 *  - router.js        API 路由分发与 WS 升级处理
 *
 * 启动：node server/index.js   （或 npm start）
 * 配置：项目根目录的 .env（唯一来源，同名环境变量优先）
 */
'use strict';

const http = require('http');
const { cfg, BASE } = require('./config');
const { send } = require('./lib/http');
const { state, startCollectTimers } = require('./api/metrics');
const { startPrinterTimer } = require('./api/printer');
const terminal = require('./api/terminal');
const runner = require('./api/runner');
const { route, handleUpgrade } = require('./router');

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    await route(req, res, url);
  } catch (e) {
    send(res, 500, { error: String((e && e.message) || e) });
  }
});

server.on('upgrade', handleUpgrade);

/** 监听错误（端口被占用等）：给出可操作提示后退出。
 *  不加该监听时 EADDRINUSE 以裸堆栈崩溃（曾表现「重启后服务莫名不见、接口全失联」） */
server.on('error', (e) => {
  if (e && e.code === 'EADDRINUSE') {
    console.error(
      `[fatal] 端口 ${cfg.port} 已被占用，无法监听（${cfg.host}）。请先停止旧实例；` +
        `Windows 可用：Get-NetTCPConnection -LocalPort ${cfg.port} | ` +
        `ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }`
    );
  } else {
    console.error('[fatal] HTTP 服务错误:', e);
  }
  process.exit(1);
});

server.listen(cfg.port, cfg.host, () => {
  console.log(`[sysprobe] listening on http://${cfg.host}:${cfg.port}${BASE === '/' ? '/' : BASE}`);
  console.log(`[sysprobe] basePath=${BASE}  鉴权已启用（密码来自 .env）`);
});

/* 后台采集：指标 / 打印机 / 终端 ttyd 子进程（失败自动退避重试）。
   全部置于 listen 之后，与 HTTP 服务解耦：任一后台模块启动异常只影响自身功能，
   不得阻止监听或波及其他接口（终端不可用时 /api/terminal/* 返回 503，其余接口照常）。 */
startCollectTimers();
startPrinterTimer(state);
// ttyd 再延后一个 tick 并包 try/catch：即使 spawn 同步抛错也只记 warn，不影响已开始的监听
setImmediate(() => {
  try {
    terminal.startTerminal();
  } catch (e) {
    console.warn('[warn] ttyd 启动异常，终端暂不可用（不影响其他接口）:', (e && e.message) || e);
  }
});

/* 进程级兜底：后台路径（采集定时器 / ttyd 子进程 / runner / 代理回调）的未捕获异常
   不得打翻整个服务——否则一次异步崩溃就会让所有接口一起失联（反代侧呈现为整片 5xx）。
   策略：打印堆栈并继续服务；短时间内反复崩溃（疑似状态已损坏）才退出，交由 systemd 重启。 */
const ASYNC_CRASH_WINDOW_MS = 60000; // 崩溃计数窗口
const ASYNC_CRASH_LIMIT = 10; // 窗口内达到该次数即退出
let asyncCrashCount = 0;
let asyncCrashWindowStart = Date.now();
function onAsyncCrash(origin, err) {
  const now = Date.now();
  if (now - asyncCrashWindowStart > ASYNC_CRASH_WINDOW_MS) {
    asyncCrashWindowStart = now;
    asyncCrashCount = 0;
  }
  asyncCrashCount += 1;
  console.error(`[fatal] 未捕获异常（${origin}），服务保持运行：`, (err && err.stack) || err);
  if (asyncCrashCount >= ASYNC_CRASH_LIMIT) {
    console.error(`[fatal] ${ASYNC_CRASH_WINDOW_MS / 1000}s 内连续崩溃 ${asyncCrashCount} 次，退出并交由 systemd 重启`);
    process.exit(1);
  }
}
process.on('uncaughtException', (e) => onAsyncCrash('uncaughtException', e));
process.on('unhandledRejection', (e) => onAsyncCrash('unhandledRejection', e));

/** 退出前清理 ttyd / runner 子进程（systemd stop / Ctrl-C） */
let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  terminal.stopTerminal();
  if (runner.stopRunnerJob()) { /* 任务已 SIGTERM */ }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('exit', () => {
  terminal.cleanupSync();
  try { runner.stopRunnerJob(); } catch { /* 已退出忽略 */ }
});
