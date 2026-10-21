/**
 * 配置模块：.env 加载（唯一配置来源）、环境变量解析、默认值、fail-fast 与 basePath 规范化。
 *
 * 配置约定：所有可配置项统一写在项目根目录的 .env 中，由 loadEnv() 读入 process.env；
 * 同名的真实环境变量优先（不被 .env 覆盖）。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

/* 项目根目录（server/ 的上一级）：.env / dist / public 均以根目录定位 */
const ROOT_DIR = path.join(__dirname, '..');

/* .env 加载（零依赖）：写入 process.env，不覆盖已有环境变量 */
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

/* ---------- 环境变量解析辅助：统一处理缺失、类型与非法值回落 ---------- *
 * 约定：未设置与空串一律视为「未设置」并回退默认值，避免 .env 里写了空值
 * 就把配置清零（原先各分支判断不一致，PORT 甚至可能被写成 NaN）。 */

/** 取字符串；未设置或空串回退默认值 */
function envStr(name, def) {
  const v = process.env[name];
  return v == null || v === '' ? def : v;
}

/** 取整数；非法值 [warn] 并回退默认值（避免 NaN 静默流入配置） */
function envInt(name, def) {
  const raw = process.env[name];
  if (raw == null || raw.trim() === '') return def;
  const n = parseInt(raw.trim(), 10);
  if (!Number.isFinite(n)) {
    console.warn(`[warn] ${name}="${raw}" 非法，回退默认 ${def}`);
    return def;
  }
  return n;
}

/** 取布尔；真值沿用项目既有语义：1 / true / yes / on */
function envBool(name, def) {
  const raw = process.env[name];
  if (raw == null || raw.trim() === '') return def;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

/** 取 JSON 字符串数组（用于 TTYD_ARGS / DISK_MOUNTS）；解析失败 [warn] 并回退默认值 */
function envJsonArray(name, def) {
  const raw = process.env[name];
  if (raw == null || raw.trim() === '') return def;
  try {
    const parsed = JSON.parse(raw.trim());
    if (Array.isArray(parsed)) return parsed.map((s) => String(s).trim()).filter(Boolean);
    console.warn(`[warn] ${name} 不是 JSON 数组，回退默认 ${JSON.stringify(def)}`);
  } catch {
    console.warn(`[warn] ${name} JSON 解析失败，回退默认 ${JSON.stringify(def)}`);
  }
  return def;
}

const cfg = {
  /* 服务 */
  port: envInt('PORT', 3000),
  host: envStr('HOST', '0.0.0.0'),
  password: envStr('PASSWORD', ''), // 必配，缺失时下方 fail-fast
  basePath: envStr('BASE_PATH', '/'),
  /* 监控采样的磁盘挂载点（≠ FS_ROOTS，后者是文件管理器可浏览白名单） */
  diskMounts: envJsonArray('DISK_MOUNTS', []),
  collectInterval: envInt('COLLECT_INTERVAL', 2000), // CPU / 内存采样间隔 ms
  dockerInterval: envInt('DOCKER_INTERVAL', 5000), // docker stats 刷新间隔 ms
  processInterval: envInt('PROCESS_INTERVAL', 10000), // 进程列表刷新间隔 ms
  processTopN: envInt('PROCESS_TOP_N', 50), // 进程列表返回条数（按 CPU 排序）

  /* 终端（ttyd）：仅监听 127.0.0.1 */
  terminal: {
    enabled: envBool('TERMINAL_ENABLED', false), // 需服务器安装 ttyd
    ttydPath: envStr('TTYD_PATH', 'ttyd'), // ttyd 可执行文件路径
    ttydPort: envInt('TTYD_PORT', 7681), // 监听端口（仅本机 127.0.0.1）
    ttydArgs: envJsonArray('TTYD_ARGS', ['bash']), // 要运行的 shell 及参数
    wsl: envBool('TTYD_WSL', false), // Windows 下经 WSL 运行 Linux 版 ttyd
  },

  /* Runner：远程触发脚本任务。scriptPath 只接受服务端配置，客户端不可传路径 */
  runner: {
    enabled: envBool('RUNNER_ENABLED', false),
    scriptPath: envStr('RUNNER_SCRIPT', ''), // 启用时必配：脚本绝对路径
    shell: envStr('RUNNER_SHELL', 'bash'), // Linux 服务器默认 bash
    maxLogBytes: envInt('RUNNER_MAX_LOG_BYTES', 5 * 1024 * 1024), // 超过则归档为 .old
  },

  /* Printer：CUPS 打印机与任务监控（依赖 ipptool / lpinfo，命令缺失时 available=false） */
  printer: {
    enabled: envBool('PRINTER_ENABLED', true),
    interval: envInt('PRINTER_INTERVAL', 10000), // 采集间隔 ms
    historyLimit: envInt('PRINTER_HISTORY_LIMIT', 200), // 历史条数上限（CUPS Get-Jobs 单次最多 500）
  },

  /* Hermes 聊天代理：转发到 OpenAI 兼容上游。apiKey 等仅服务端持有，不回传任何响应 */
  hermes: {
    enabled: envBool('HERMES_ENABLED', false),
    baseUrl: envStr('HERMES_BASE_URL', 'http://192.168.100.20:8642'),
    apiKey: envStr('HERMES_API_KEY', ''), // 上游 Bearer（可为空）
    apiServerKey: envStr('HERMES_API_SERVER_KEY', ''), // Sessions API 专用 Bearer，为空回退 apiKey
    model: envStr('HERMES_MODEL', 'hermes-agent'), // 客户端未指定 model 时注入
    timeoutMs: envInt('HERMES_TIMEOUT_MS', 300000), // agent 执行工具可能很久
  },
  // 大模型用量 Dashboard（余额/配额，/api/usage/* 代理；key 只存服务端，不回传前端）
  usage: {
    enabled: envBool('USAGE_ENABLED', false),
    deepseekKey: envStr('DEEPSEEK_API_KEY', ''), // DeepSeek 上游 Bearer（留空经 SSH 从 Mac hermes 配置读取）
    deepseekBaseUrl: envStr('DEEPSEEK_BASE_URL', ''), // 留空 = hermes 配置值优先，否则官方 https://api.deepseek.com
    zaiKey: envStr('ZAI_API_KEY', ''), // 智谱 Coding 套餐 Key（与标准 API Key 不通用）
    zaiBaseUrl: envStr('ZAI_BASE_URL', 'https://open.bigmodel.cn'), // 国际站改 https://api.z.ai
    // 两个 key 留空时的兜底：SSH 读 Mac 上 ~/.hermes/.env（mac 为 ~/.ssh/config 的免密别名；grep 只取所需键名）
    sshCmd: envStr(
      'USAGE_SSH_CMD',
      'ssh -o BatchMode=yes -o ConnectTimeout=5 mac "grep -E \'^(DEEPSEEK_API_KEY|DEEPSEEK_BASE_URL|GLM_API_KEY|ZAI_API_KEY)=\' ~/.hermes/.env"'
    ),
    timeoutMs: envInt('USAGE_TIMEOUT_MS', 15000),
  },
};

/* 访问密码 fail-fast：无内置默认口令，必须显式配置。
   历史上默认口令会让「改了配置就以为安全了」的部署直接暴露在局域网，故一律拒绝启动。 */
if (!cfg.password) {
  console.error('[fatal] 未配置访问密码：请在项目根目录 .env 或环境变量的 PASSWORD 中设置');
  process.exit(1);
}

/* basePath 规范化：必须以 / 开头，去除末尾 /（根路径保留为 '/'） */
let BASE = String(cfg.basePath || '/').trim();
if (!BASE.startsWith('/')) BASE = '/' + BASE;
if (BASE.length > 1 && BASE.endsWith('/')) BASE = BASE.slice(0, -1);
cfg.basePath = BASE;

/* diskMounts 缺省时按平台兜底：Windows 取项目所在盘符，POSIX 取根 */
if (!Array.isArray(cfg.diskMounts) || cfg.diskMounts.length === 0) {
  cfg.diskMounts = os.platform() === 'win32' ? [process.cwd().slice(0, 3)] : ['/'];
}

const COOKIE_NAME = 'sp_token';

/* JWT 签名密钥（HS256，零依赖）：独立于访问密码，必须显式配置。
   与密码解耦的原因：旧的 sha256('sysprobe::jwt::' + 密码) 派生方式下，
   任何一个泄露的 token 都能被用来离线反推密码，且弱口令可直接伪造任意会话。
   要求 ≥32 字节，把弱密钥挡在启动阶段（可用 `openssl rand -hex 32` 生成）。 */
const JWT_SECRET = envStr('JWT_SECRET', '');
if (Buffer.byteLength(JWT_SECRET, 'utf8') < 32) {
  console.error(
    '[fatal] JWT 签名密钥未配置或过短：请在项目根目录 .env 或环境变量的 JWT_SECRET 中' +
      '设置至少 32 字节的随机串（生成：openssl rand -hex 32）'
  );
  process.exit(1);
}

/* token 有效期（秒）：JWT_EXPIRES_IN 配置，clamp 到[300, 2592000]（5 分钟 ~ 30 天），
   非法值回退默认 24h。签发处 exp=iat+JWT_EXPIRES 与 Cookie Max-Age 同源，改这里即两者同步生效。 */
const JWT_EXPIRES_DEFAULT = 86400;
const JWT_EXPIRES_MIN = 300;
const JWT_EXPIRES_MAX = 2592000;
const JWT_EXPIRES = (() => {
  const raw = process.env.JWT_EXPIRES_IN;
  const parsed = parseInt(raw || '', 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    if (raw) console.warn(`[warn] JWT_EXPIRES_IN="${raw}" 非法，回退默认 ${JWT_EXPIRES_DEFAULT} 秒`);
    return JWT_EXPIRES_DEFAULT;
  }
  const clamped = Math.min(Math.max(parsed, JWT_EXPIRES_MIN), JWT_EXPIRES_MAX);
  if (clamped !== parsed) {
    console.warn(
      `[warn] JWT_EXPIRES_IN=${parsed} 超出允许范围，已收敛为 ${clamped} 秒（${JWT_EXPIRES_MIN}~${JWT_EXPIRES_MAX}）`
    );
  }
  return clamped;
})();

/* Cookie Secure 策略（COOKIE_SECURE）：
   - auto（默认）：仅当请求本身走 HTTPS（含反代标注 X-Forwarded-Proto/X-Forwarded-Ssl）时附加 Secure。
     这样 Nginx 配了 TLS 就自动收紧，而内网纯 HTTP 部署不会因 Secure Cookie 被浏览器丢弃而全面 401。
   - always：恒附加（仅在确定全站 HTTPS 时用）
   - never：恒不附加 */
const COOKIE_SECURE_MODE = (() => {
  const v = envStr('COOKIE_SECURE', 'auto').trim().toLowerCase();
  if (['1', 'true', 'yes', 'on', 'always'].includes(v)) return 'always';
  if (['0', 'false', 'no', 'off', 'never'].includes(v)) return 'never';
  if (v !== 'auto') console.warn(`[warn] COOKIE_SECURE="${v}" 无法识别，回退 auto`);
  return 'auto';
})();

/* WebSocket Origin 白名单（PUBLIC_ORIGIN）：逗号分隔多值，规范化小写并去尾部 /。
   空数组表示「仅同源」（由 router.js 的 originAllowed 按请求 Host 推导）。 */
const ORIGIN_ALLOW_LIST = envStr('PUBLIC_ORIGIN', '')
  .split(',')
  .map((s) => s.trim().replace(/\/+$/, '').toLowerCase())
  .filter(Boolean);

/* 静态目录：只服务 SPA 构建产物 dist/（旧版零依赖前端已移除）。
   dist/ 不存在时不静默降级，由 static.js 的 serveIndex 返回 503 + 构建提示。 */
const DIST_DIR = path.join(ROOT_DIR, 'dist');
const PUBLIC_DIR = DIST_DIR;

module.exports = {
  cfg,
  BASE,
  COOKIE_NAME,
  JWT_SECRET,
  JWT_EXPIRES,
  COOKIE_SECURE_MODE,
  ORIGIN_ALLOW_LIST,
  DIST_DIR,
  PUBLIC_DIR,
};