/**
 * 路由模块：HTTP 请求分发（公开接口 / 鉴权接口 / 各 app API / 静态页面回退）
 * 与 WebSocket 升级处理（终端代理）。
 * 从 server.js 原样搬移（原 1608-1797 行），分发顺序、鉴权次序（401 优先于 503）
 * 与 basePath 剥离语义均保持不变。
 */
'use strict';

const crypto = require('crypto');
const os = require('os');
const { cfg, BASE, COOKIE_NAME, JWT_EXPIRES, COOKIE_SECURE_MODE, ORIGIN_ALLOW_LIST } = require('./config');
const { send, redirect, safeEqual, readBody } = require('./lib/http');
const { signJwt, checkAuth } = require('./lib/auth');
const { state } = require('./api/metrics');
const { printTestPage } = require('./api/printer');
const { serveFile, serveIndex, servePwaFile } = require('./static');
const terminal = require('./api/terminal');
const runner = require('./api/runner');
const blog = require('./api/blog');
const { proxyHermesChat, proxyHermesSessions } = require('./api/chat');
const { getDeepseekUsage, getZaiUsage } = require('./api/usage');
const { fsRoute } = require('./api/fs');
const { prefsRoute } = require('./api/prefs');
const audit = require('./api/audit');

/**
 * 本次登录响应是否为会话 Cookie 附加 Secure 属性（COOKIE_SECURE 三态：auto / always / never）。
 * auto：仅当请求本身走 HTTPS 时附加——覆盖 Nginx 等反代终结 TLS（X-Forwarded-Proto / X-Forwarded-Ssl），
 * 同时避免内网纯 HTTP 部署因 Secure Cookie 被浏览器直接丢弃而出现「登录成功但后续全部 401」。
 */
function cookieSecureFor(req) {
  if (COOKIE_SECURE_MODE === 'always') return true;
  if (COOKIE_SECURE_MODE === 'never') return false;
  if (req.socket && req.socket.encrypted) return true;
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  if (proto === 'https') return true;
  return String(req.headers['x-forwarded-ssl'] || '').trim().toLowerCase() === 'on';
}

/**
 * 终端 WS 升级的 Origin 白名单（依赖 cookie 的 WS 需防跨站劫持，SameSite=Lax 只是浏览器侧的隐式防线）。
 * 规则：缺失 Origin 放行（curl、测试脚本等非浏览器客户端必须可用）→ 命中 PUBLIC_ORIGIN 放行
 * → 否则按同源推导（http://<Host> 或 https://<Host>，兼容反代终结 TLS）。
 */
function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  const norm = (s) => String(s || '').trim().replace(/\/+$/, '').toLowerCase();
  const o = norm(origin);
  if (ORIGIN_ALLOW_LIST.includes(o)) return true;
  const host = String(req.headers.host || '').toLowerCase();
  if (!host) return false;
  return o === `http://${host}` || o === `https://${host}`;
}

/**
 * 统一 401 出口：先落审计日志再回响应。
 * 响应体与 WWW-Authenticate 头保持原样（既有测试与前端依赖此契约）；
 * 日志写入是 fire-and-forget，任何失败都不可能改变 401 的结果。
 */
function unauthorized(req, res) {
  audit.logUnauthorized(req);
  return send(res, 401, { error: 'Unauthorized' }, { 'WWW-Authenticate': 'Bearer' });
}

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
  if (p === '/api/health') return send(res, 200, { ok: true, basePath: BASE });

  if (p === '/api/login' && req.method === 'POST') {
    const startedAt = Date.now();
    // 注意：失败分支含 600ms 防爆破延迟，durationMs 会偏大——这是刻意保留的人工耗时，便于识别撞库节奏
    const elapsed = () => Date.now() - startedAt;
    let body;
    try {
      body = JSON.parse((await readBody(req)) || '{}');
    } catch {
      audit.logLogin(req, { ok: false, reason: 'bad-body', status: 400, durationMs: elapsed() });
      return send(res, 400, { error: 'Invalid request body' });
    }
    const pass = String(body.password || '');
    const ok = safeEqual(
      crypto.createHash('sha256').update(pass).digest('hex'),
      crypto.createHash('sha256').update(cfg.password).digest('hex')
    );
    if (!ok) {
      await new Promise((r) => setTimeout(r, 600)); // 简单防爆破
      audit.logLogin(req, { ok: false, reason: 'bad-password', status: 401, durationMs: elapsed() });
      return send(res, 401, { error: 'Incorrect password' });
    }
    const jwt = signJwt({
      sub: 'sysprobe',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + JWT_EXPIRES,
    });
    const attrs = [
      `${COOKIE_NAME}=${jwt}`,
      `Path=${BASE}`,
      'HttpOnly',
      'SameSite=Lax',
      `Max-Age=${JWT_EXPIRES}`,
    ];
    // Secure 让会话 Cookie 只走 HTTPS；auto 模式下仅 HTTPS 请求附加（见 cookieSecureFor）
    if (cookieSecureFor(req)) attrs.push('Secure');
    const cookie = attrs.join('; ');
    audit.logLogin(req, { ok: true, reason: 'ok', status: 200, durationMs: elapsed() });
    // 不回传 token：会话凭据只存在于 HttpOnly Cookie，避免落入响应体 / 代理日志
    return send(res, 200, { ok: true, expiresIn: JWT_EXPIRES }, { 'Set-Cookie': cookie });
  }

  /* ---- Printer API（GET 状态 / POST 测试页，统一 JWT 鉴权）---- */
  if (p === '/api/printer' || p === '/api/printer/test-page') {
    if (!checkAuth(req)) {
      return unauthorized(req, res);
    }
    // 未启用时 503；已启用但 CUPS 不可用时仍返回 200 + available=false（与 docker 一致）
    if (p === '/api/printer') {
      if (!cfg.printer.enabled) return send(res, 503, { error: 'Printer disabled' });
      return send(res, 200, state.printer);
    }
    // POST /api/printer/test-page：body { printer: "<名称>" }，提交 CUPS 测试页打印任务
    if (req.method !== 'POST') return send(res, 404, { error: 'not found' });
    if (!cfg.printer.enabled) return send(res, 503, { error: 'Printer disabled' });
    let body;
    try {
      body = JSON.parse((await readBody(req)) || '{}');
    } catch {
      return send(res, 400, { error: 'Invalid request body' });
    }
    const r = await printTestPage(body.printer);
    if (r.error === 'Bad printer name') return send(res, 400, { error: r.error });
    if (r.error === 'Printer not found') return send(res, 404, { error: r.error, detail: r.detail || '' });
    if (r.error === 'CUPS unavailable') return send(res, 503, { error: r.error, detail: r.detail || '' });
    if (r.error) return send(res, 500, { error: r.error, detail: r.detail || '' });
    return send(res, 200, r);
  }

  /* ---- 登出（幂等，刻意不要求有效会话）----
     过期 / 伪造 / 缺失的会话也返回 200 并清 Cookie：否则浏览器会一直带着失效 Cookie，
     前端每次轮询都 401、用户只能在「登录页 ↔ 401」之间打转（退出登录必须能兜住这种状态）。
     审计只在会话有效时记录——未授权的登出请求可能只是撞库噪声，不该污染登录审计。 */
  if (p === '/api/logout') {
    if (checkAuth(req)) audit.logLogout(req);
    const attrs = [`${COOKIE_NAME}=`, `Path=${BASE}`, 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
    if (cookieSecureFor(req)) attrs.push('Secure');
    return send(res, 200, { ok: true }, { 'Set-Cookie': attrs.join('; ') });
  }

  /* ---- 需要鉴权的接口 ---- */
  if (p === '/api/metrics' || p === '/api/docker' || p === '/api/processes') {
    if (!checkAuth(req)) {
      return unauthorized(req, res);
    }
    if (p === '/api/metrics') {
      state.host.uptime = os.uptime();
      return send(res, 200, state);
    }
    if (p === '/api/docker') return send(res, 200, state.docker);
    if (p === '/api/processes') return send(res, 200, state.processes);
  }

  /* ---- 终端代理（ttyd，复用 JWT 鉴权）---- */
  if (p.startsWith('/api/terminal/')) {
    if (!checkAuth(req)) {
      return unauthorized(req, res);
    }
    if (!cfg.terminal.enabled) return send(res, 503, { error: 'Terminal disabled' });
    // 终端已启用但 ttyd 尚未就绪（未安装 / 端口被占用 / 正在重试）：明确区分于“未启用”
    if (!terminal.ttydReady()) {
      return send(res, 503, { error: 'Terminal unavailable', detail: terminal.ttydError() || 'ttyd 正在启动' });
    }
    if (p === '/api/terminal/token') return terminal.proxyTerminalToken(req, res);
    return send(res, 404, { error: 'not found' });
  }

  /* ---- 文件管理 API（零依赖 fs 操作，统一 JWT 鉴权）---- */
  if (p.startsWith('/api/fs/')) {
    if (!checkAuth(req)) {
      return unauthorized(req, res);
    }
    return fsRoute(req, res, p, url);
  }

  /* ---- 用户偏好 API（Editor 视图选项，落盘 ~/.watchdog-os/data.json，统一 JWT 鉴权）---- */
  if (p.startsWith('/api/prefs/')) {
    if (!checkAuth(req)) {
      return unauthorized(req, res);
    }
    return prefsRoute(req, res, p);
  }

  /* ---- 登录审计日志 API（审查 + 统计 + CSV 导出，统一 JWT 鉴权）---- */
  if (p.startsWith('/api/audit/')) {
    if (!checkAuth(req)) {
      return unauthorized(req, res);
    }
    return audit.auditRoute(req, res, p, url);
  }

  /* ---- Runner API（脚本任务触发，统一 JWT 鉴权）---- */
  if (p.startsWith('/api/runner/')) {
    if (!checkAuth(req)) {
      return unauthorized(req, res);
    }
    // status 是信息性接口：未启用时也返回 200 + enabled=false，便于前端区分"未配置"与"服务异常"
    if (p === '/api/runner/status' && req.method === 'GET') {
      const q = url.searchParams;
      let lines = parseInt(q.get('lines') || '300', 10);
      if (!Number.isFinite(lines) || lines < 1) lines = 300;
      lines = Math.min(lines, 2000);
      return send(res, 200, runner.runnerStatusPayload(lines));
    }
    if (!cfg.runner.enabled || !cfg.runner.scriptPath) {
      return send(res, 503, { error: 'Runner disabled' });
    }
    if (p === '/api/runner/start' && req.method === 'POST') {
      const r = runner.startRunnerJob();
      if (r.error === 'Job already running') return send(res, 409, { error: r.error, job: r.job });
      if (r.error === 'Script not found') return send(res, 400, { error: r.error });
      if (r.error) return send(res, 500, { error: r.error, detail: r.detail || '' });
      return send(res, 200, { ok: true, jobId: r.job.id, startedAt: r.job.startedAt, script: r.job.script });
    }
    if (p === '/api/runner/stop' && req.method === 'POST') {
      if (!runner.stopRunnerJob()) return send(res, 409, { error: 'No job running' });
      return send(res, 200, { ok: true, job: runner.currentJob() });
    }
    return send(res, 404, { error: 'not found' });
  }

  /* ---- Blog API（static-gallary-generator 构建触发，统一 JWT 鉴权，与 Runner 同构）---- */
  if (p.startsWith('/api/blog/')) {
    if (!checkAuth(req)) {
      return unauthorized(req, res);
    }
    // status 是信息性接口：未启用时也返回 200 + enabled=false，便于前端区分"未配置"与"服务异常"
    if (p === '/api/blog/status' && req.method === 'GET') {
      const q = url.searchParams;
      let lines = parseInt(q.get('lines') || '300', 10);
      if (!Number.isFinite(lines) || lines < 1) lines = 300;
      lines = Math.min(lines, 2000);
      return send(res, 200, blog.statusPayload(lines));
    }
    if (!cfg.blog.enabled || !cfg.blog.scriptPath) {
      return send(res, 503, { error: 'Blog disabled' });
    }
    if (p === '/api/blog/start' && req.method === 'POST') {
      const r = blog.startJob();
      if (r.error === 'Job already running') return send(res, 409, { error: r.error, job: r.job });
      if (r.error === 'Script not found') return send(res, 400, { error: r.error });
      if (r.error) return send(res, 500, { error: r.error, detail: r.detail || '' });
      return send(res, 200, { ok: true, jobId: r.job.id, startedAt: r.job.startedAt, script: r.job.script });
    }
    if (p === '/api/blog/stop' && req.method === 'POST') {
      if (!blog.stopJob()) return send(res, 409, { error: 'No job running' });
      return send(res, 200, { ok: true, job: blog.currentJob() });
    }
    return send(res, 404, { error: 'not found' });
  }

  /* ---- Hermes 聊天代理（OpenAI 兼容 API + Sessions 转发，统一 JWT 鉴权）---- */
  if (
    p === '/api/chat/status' ||
    p === '/api/chat/completions' ||
    p.startsWith('/api/chat/sessions')
  ) {
    if (!checkAuth(req)) {
      return unauthorized(req, res);
    }
    // status 是信息性接口：未启用时也返回 200 + enabled=false，便于前端区分"未配置"与"服务异常"（不含 apiKey）
    if (p === '/api/chat/status' && req.method === 'GET') {
      return send(res, 200, { enabled: !!cfg.hermes.enabled, baseUrl: cfg.hermes.baseUrl });
    }
    if (!cfg.hermes.enabled) return send(res, 503, { error: 'Hermes chat disabled' });
    if (p === '/api/chat/completions' && req.method === 'POST') {
      let body;
      try {
        body = await readBody(req, 8 * 1024 * 1024); // 聊天消息（可能含图片 base64）允许较大 body
      } catch {
        return send(res, 413, { error: 'body too large' });
      }
      return proxyHermesChat(req, res, Buffer.from(body, 'utf8'));
    }
    // Sessions API 子路由：白名单解析（单段 id，天然拒绝 '..' 与多级路径），id decode 后再校验字符集
    if (p.startsWith('/api/chat/sessions')) {
      const sub = p.slice('/api/chat/sessions'.length); // '' | '/{id}' | '/{id}/messages'
      if (sub === '' && req.method === 'GET') {
        return proxyHermesSessions(req, res, 'list', null, url.search);
      }
      const m = sub.match(/^\/([^/]+)(\/messages)?$/);
      if (m) {
        let id;
        try {
          id = decodeURIComponent(m[1]);
        } catch {
          return send(res, 400, { error: 'bad session id' });
        }
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)) {
          return send(res, 400, { error: 'bad session id' });
        }
        if (req.method === 'GET') {
          return proxyHermesSessions(req, res, m[2] ? 'messages' : 'meta', id, url.search);
        }
        if (req.method === 'DELETE') {
          return proxyHermesSessions(req, res, 'delete', id, '');
        }
      }
      return send(res, 404, { error: 'not found' });
    }
    return send(res, 404, { error: 'not found' });
  }

  /* ---- 大模型用量 Dashboard 代理（余额/配额，统一 JWT 鉴权）---- */
  if (p === '/api/usage/deepseek' || p === '/api/usage/zai') {
    if (!checkAuth(req)) {
      return unauthorized(req, res);
    }
    if (!cfg.usage.enabled) return send(res, 503, { error: 'Usage dashboard disabled' });
    if (req.method !== 'GET') return send(res, 404, { error: 'not found' });
    return p === '/api/usage/deepseek' ? getDeepseekUsage(req, res) : getZaiUsage(req, res);
  }

  /* ---- 静态页面 ---- */
  // SPA：所有页面路径统一返回 index.html，登录 / 仪表盘由前端按鉴权态切换
  if (p === '/' || p === '/index.html' || p === '/login') {
    return serveIndex(res);
  }

  // PWA 文件：manifest / Service Worker / 图标（basePath 根下的固定路径，无鉴权）
  if (p === '/manifest.webmanifest' || p === '/sw.js' || p.startsWith('/icons/')) {
    return servePwaFile(res, p.slice(1));
  }

  // 静态资源：仅构建产物 assets/（带内容 hash），其余路径一律 404
  if (p.startsWith('/assets/')) {
    return serveFile(res, p.slice(1));
  }

  return send(res, 404, { error: 'not found' });
}

/**
 * 拒绝 WS 升级：先回一句 HTTP 错误再断开。
 * 静默 destroy 会被反向代理翻成 502 Bad Gateway，把「Origin 不匹配 / 未登录」等
 * 真实原因掩盖掉（浏览器只报 WebSocket connection failed）；明确的状态码可在
 * 浏览器 Network 面板与外代日志里直接看到，是排障第一手线索。
 */
function rejectUpgrade(socket, status, reason) {
  try {
    socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  } catch {
    /* socket 已损坏时放弃写响应，直接断开 */
    socket.destroy();
  }
}

/** WebSocket 升级：仅放行鉴权后的终端代理路径（与 route() 相同的 BASE 前缀剥离逻辑）。
 *  401 优先于 503/403（与 HTTP 路由一致：未通过鉴权者无法据此探测终端配置）。 */
function handleUpgrade(req, socket) {
  try {
    const url = new URL(req.url, 'http://localhost');
    let p = url.pathname;
    if (BASE !== '/') {
      if (p === BASE || p === BASE + '/') p = '/';
      else if (p.startsWith(BASE + '/')) p = p.slice(BASE.length);
      else return rejectUpgrade(socket, 404, 'Not Found');
    }
    if (p !== '/api/terminal/ws') return rejectUpgrade(socket, 404, 'Not Found');
    // 鉴权在前、来源校验在后：未通过鉴权者无法据此探测 Origin 配置
    if (!checkAuth(req)) {
      audit.logUnauthorized(req);
      return rejectUpgrade(socket, 401, 'Unauthorized');
    }
    if (!cfg.terminal.enabled) return rejectUpgrade(socket, 503, 'Terminal disabled');
    if (!terminal.ttydReady()) return rejectUpgrade(socket, 503, 'Terminal unavailable');
    if (!originAllowed(req)) return rejectUpgrade(socket, 403, 'Origin not allowed');
    terminal.proxyTerminalWs(req, socket, url.search);
  } catch {
    socket.destroy();
  }
}

module.exports = { route, handleUpgrade };
