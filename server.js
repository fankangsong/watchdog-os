#!/usr/bin/env node
/**
 * 系统探针监控服务（零依赖 Node.js）—— 瘦入口
 *
 * 功能（实现按模块拆分在 server/ 下，本文件只负责组装与生命周期）：
 *  - server/config.js      配置加载（.env / config.json）
 *  - server/lib/http.js    HTTP 基础工具
 *  - server/lib/auth.js    JWT 鉴权
 *  - server/api/metrics.js 指标采集（MonitorApp / DockerApp）
 *  - server/api/printer.js 打印机采集
 *  - server/api/terminal.js 终端 ttyd 代理（TerminalApp）
 *  - server/api/runner.js  脚本任务（RunnerApp）
 *  - server/api/chat.js    Hermes 聊天代理（ImcolinApp）
 *  - server/api/fs.js      文件管理（FinderApp / EditorApp）
 *  - server/static.js      静态资源服务
 *  - server/router.js      API 路由分发与 WS 升级处理
 *
 * 启动：node server.js   （或 npm start）
 * 配置：config.json，可用环境变量 PORT / PASSWORD / BASE_PATH 覆盖
 */
'use strict';

const http = require('http');
const { cfg, BASE } = require('./server/config');
const { send } = require('./server/lib/http');
const { state, startCollectTimers } = require('./server/api/metrics');
const { startPrinterTimer } = require('./server/api/printer');
const terminal = require('./server/api/terminal');
const runner = require('./server/api/runner');
const { route, handleUpgrade } = require('./server/router');

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
  console.log(`[sysprobe] basePath=${BASE}  鉴权已启用（密码来自 config.json）`);
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
