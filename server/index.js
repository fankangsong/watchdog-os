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

/* 后台采集：指标 / 打印机 / 终端 ttyd 子进程（失败自动退避重试） */
startCollectTimers();
startPrinterTimer(state);
terminal.startTerminal();

server.listen(cfg.port, cfg.host, () => {
  console.log(`[sysprobe] listening on http://${cfg.host}:${cfg.port}${BASE === '/' ? '/' : BASE}`);
  console.log(`[sysprobe] basePath=${BASE}  鉴权已启用（密码来自 .env）`);
});

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
