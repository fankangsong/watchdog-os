/**
 * 路由模块：HTTP 请求分发（公开接口 / 鉴权接口 / 各 app API / 静态页面回退）
 * 与 WebSocket 升级处理（终端代理）。
 * 从 server.js 原样搬移（原 1608-1797 行），分发顺序、鉴权次序（401 优先于 503）
 * 与 basePath 剥离语义均保持不变。
 */
'use strict';

const crypto = require('crypto');
const os = require('os');
const { cfg, BASE, COOKIE_NAME, JWT_EXPIRES, SPA_MODE } = require('./config');
const { send, redirect, safeEqual, readBody } = require('./lib/http');
const { signJwt, checkAuth } = require('./lib/auth');
const { state } = require('./api/metrics');
const { serveFile } = require('./static');
const terminal = require('./api/terminal');
const runner = require('./api/runner');
const { proxyHermesChat, proxyHermesSessions } = require('./api/chat');
const { fsRoute } = require('./api/fs');

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
  if (p === '/api/metrics' || p === '/api/docker' || p === '/api/processes' || p === '/api/printer' || p === '/api/logout') {
    if (!checkAuth(req)) {
      return send(res, 401, { error: 'Unauthorized' }, { 'WWW-Authenticate': 'Bearer' });
    }
    if (p === '/api/metrics') {
      state.host.uptime = os.uptime();
      return send(res, 200, state);
    }
    if (p === '/api/docker') return send(res, 200, state.docker);
    if (p === '/api/processes') return send(res, 200, state.processes);
    // 未启用时 503；已启用但 CUPS 不可用时仍返回 200 + available=false（与 docker 一致）
    if (p === '/api/printer') {
      if (!cfg.printer.enabled) return send(res, 503, { error: 'Printer disabled' });
      return send(res, 200, state.printer);
    }
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
    if (!terminal.ttydReady()) {
      return send(res, 503, { error: 'Terminal unavailable', detail: terminal.ttydError() || 'ttyd 正在启动' });
    }
    if (p === '/api/terminal/token') return terminal.proxyTerminalToken(req, res);
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

  /* ---- Hermes 聊天代理（OpenAI 兼容 API + Sessions 转发，统一 JWT 鉴权）---- */
  if (
    p === '/api/chat/status' ||
    p === '/api/chat/completions' ||
    p.startsWith('/api/chat/sessions')
  ) {
    if (!checkAuth(req)) {
      return send(res, 401, { error: 'Unauthorized' }, { 'WWW-Authenticate': 'Bearer' });
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

/** WebSocket 升级：仅放行鉴权后的终端代理路径（与 route() 相同的 BASE 前缀剥离逻辑） */
function handleUpgrade(req, socket) {
  try {
    const url = new URL(req.url, 'http://localhost');
    let p = url.pathname;
    if (BASE !== '/') {
      if (p === BASE || p === BASE + '/') p = '/';
      else if (p.startsWith(BASE + '/')) p = p.slice(BASE.length);
      else { socket.destroy(); return; }
    }
    if (p !== '/api/terminal/ws') { socket.destroy(); return; }
    if (!cfg.terminal.enabled || !terminal.ttydReady() || !checkAuth(req)) { socket.destroy(); return; }
    terminal.proxyTerminalWs(req, socket, url.search);
  } catch {
    socket.destroy();
  }
}

module.exports = { route, handleUpgrade };
