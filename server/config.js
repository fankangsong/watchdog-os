/**
 * 配置模块：.env 加载、config.json 读取与默认值合并、basePath 规范化。
 * 从 server.js 原样搬移（原 30-163 行），仅将根目录相关路径改为以项目根定位。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

/* 项目根目录（server/ 的上一级）：.env / config.json / dist / public 均以根目录定位 */
const ROOT_DIR = path.join(__dirname, '..');

/* .env 加载（零依赖）：PASSWORD 等变量写入 process.env，不覆盖已有环境变量 */
function loadEnv() {
  try {
    const txt = fs.readFileSync(path.join(ROOT_DIR, '.env'), 'utf8');
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
  fileCfg = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'config.json'), 'utf8'));
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
/* Printer 配置：CUPS 打印机与任务监控（依赖系统 ipptool / lpinfo 命令，命令缺失时 available=false） */
cfg.printer = Object.assign(
  {
    enabled: true,          // 是否启用 Printer API（PRINTER_ENABLED 可覆盖）
    interval: 10000,        // 采集间隔 ms
    historyLimit: 200,      // 返回的打印历史条数上限（CUPS Get-Jobs 单次最多 500）
  },
  cfg.printer
);
if (process.env.PRINTER_ENABLED != null) {
  cfg.printer.enabled = ['1', 'true', 'yes', 'on'].includes(String(process.env.PRINTER_ENABLED).toLowerCase());
}
/* Hermes 聊天代理配置：把 OpenAI 兼容的聊天补全请求转发到局域网 hermes agent。
   baseUrl / apiKey / model 仅服务端持有，任何接口响应不回传 apiKey */
cfg.hermes = Object.assign(
  {
    enabled: false,                        // 是否启用聊天代理（HERMES_ENABLED 可覆盖）
    baseUrl: 'http://192.168.100.20:8642', // hermes agent 的 OpenAI 兼容 API 地址
    apiKey: '',                            // 上游 Bearer Token（可为空）
    apiServerKey: '',                      // Sessions API 专用 Bearer（API_SERVER_KEY，为空回退 apiKey）
    model: 'hermes-agent',                 // 客户端未指定 model 时注入的默认模型
    timeoutMs: 300000,                     // 上游请求超时 ms（agent 执行工具可能很久）
  },
  cfg.hermes
);
if (process.env.HERMES_ENABLED != null) {
  cfg.hermes.enabled = ['1', 'true', 'yes', 'on'].includes(String(process.env.HERMES_ENABLED).toLowerCase());
}
if (process.env.HERMES_BASE_URL) cfg.hermes.baseUrl = process.env.HERMES_BASE_URL;
if (process.env.HERMES_API_KEY != null) cfg.hermes.apiKey = process.env.HERMES_API_KEY;
if (process.env.HERMES_API_SERVER_KEY != null) cfg.hermes.apiServerKey = process.env.HERMES_API_SERVER_KEY;
if (process.env.HERMES_MODEL) cfg.hermes.model = process.env.HERMES_MODEL;
if (process.env.HERMES_TIMEOUT_MS) {
  cfg.hermes.timeoutMs = parseInt(process.env.HERMES_TIMEOUT_MS, 10) || cfg.hermes.timeoutMs;
}

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
const DIST_DIR = path.join(ROOT_DIR, 'dist');
const PUBLIC_DIR = fs.existsSync(DIST_DIR) ? DIST_DIR : path.join(ROOT_DIR, 'public');
const SPA_MODE = PUBLIC_DIR === DIST_DIR;

module.exports = {
  cfg,
  BASE,
  COOKIE_NAME,
  JWT_SECRET,
  JWT_EXPIRES,
  DIST_DIR,
  PUBLIC_DIR,
  SPA_MODE,
};
