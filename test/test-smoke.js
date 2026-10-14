/* 端到端冒烟测试：鉴权 + basePath
 * 依赖已在运行的服务（BASE_HOST，默认 http://localhost:3000）；
 * 密码从环境变量 PASSWORD 读取（服务端已移除内置默认口令，必须显式配置）。 */
const BASE_HOST = process.env.BASE_HOST || 'http://localhost:3000';
const PASSWORD = process.env.PASSWORD;

async function req(path, opts = {}, cookies = '') {
  const headers = Object.assign({}, opts.headers || {});
  if (cookies) headers['Cookie'] = cookies;
  const r = await fetch(BASE_HOST + path, Object.assign({}, opts, { headers, redirect: 'manual' }));
  let body = await r.text();
  let setCookie = r.headers.get('set-cookie') || '';
  return { status: r.status, body, setCookie };
}

(async () => {
  if (!PASSWORD) {
    console.error('缺少 PASSWORD 环境变量（服务端已移除内置默认口令）：');
    console.error('  PowerShell: $env:PASSWORD="<访问密码>"; node test/test-smoke.js');
    process.exit(1);
  }
  const log = (...a) => console.log(...a);
  let pass = 0, fail = 0;
  const check = (name, cond, detail) => {
    if (cond) { pass++; log(`  ✅ ${name}`); }
    else { fail++; log(`  ❌ ${name}  ${detail || ''}`); }
  };

  log('--- 未登录 ---');
  let r = await req('/');
  // dist/ 存在时服务端走 SPA 分支：未登录/已登录都返回同一份 Vite index.html，
  // 登录页与仪表盘由前端按鉴权态切换，故首页断言按是否 SPA 自适应
  const isSpa = r.body.includes('id="root"');
  check(
    isSpa ? '首页返回 SPA 入口(200)' : '首页返回登录页(200)',
    r.status === 200 && (isSpa || r.body.includes('login-form')),
    `status=${r.status} spa=${isSpa}`
  );
  r = await req('/api/metrics');
  check('metrics 未授权 401', r.status === 401, `status=${r.status}`);
  r = await req('/api/docker');
  check('docker 未授权 401', r.status === 401, `status=${r.status}`);

  log('--- 登录 ---');
  r = await req('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'wrong' }) });
  check('错误密码 401', r.status === 401, `status=${r.status}`);
  r = await req('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) });
  check('正确密码 200', r.status === 200, `status=${r.status}`);
  // 安全约定：token 只存在于 HttpOnly Cookie，响应体不再回传（避免落入代理 / devtools 日志）
  const loginBody = JSON.parse(r.body || '{}');
  check('响应体不含 token', !loginBody.token, JSON.stringify(loginBody));
  check('响应体含 expiresIn', typeof loginBody.expiresIn === 'number');
  const cookie = r.setCookie.split(';')[0];
  check('Set-Cookie 已下发', cookie.startsWith('sp_token='), cookie);
  check('Cookie 为 HttpOnly', /;\s*HttpOnly/i.test(r.setCookie), r.setCookie);
  check('Cookie 为 SameSite=Lax', /;\s*SameSite=Lax/i.test(r.setCookie), r.setCookie);

  // Cookie Secure（默认 auto）：HTTP 请求不加；带反代 HTTPS 标记时必须加
  check('auto 模式：HTTP 请求不加 Secure', !/;\s*Secure/i.test(r.setCookie), r.setCookie);
  r = await req('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-Proto': 'https' }, body: JSON.stringify({ password: PASSWORD }) });
  check('auto 模式：X-Forwarded-Proto=https 加 Secure', /;\s*Secure/i.test(r.setCookie), r.setCookie);
  r = await req('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-Ssl': 'on' }, body: JSON.stringify({ password: PASSWORD }) });
  check('auto 模式：X-Forwarded-Ssl=on 加 Secure', /;\s*Secure/i.test(r.setCookie), r.setCookie);

  // 匿名面收敛：health 不再返回主机名
  r = await req('/api/health');
  check('health 不含 hostname', r.status === 200 && !JSON.parse(r.body || '{}').hostname, r.body.slice(0, 120));

  // 鉴权只认 Cookie：伪造的 Authorization / x-auth-token 头必须被拒（负向回归）
  r = await req('/api/metrics', { headers: { Authorization: 'Bearer forged-token-should-be-rejected' } });
  check('Bearer 头不通鉴权', r.status === 401, `status=${r.status}`);
  r = await req('/api/metrics', { headers: { 'x-auth-token': 'forged-token-should-be-rejected' } });
  check('x-auth-token 头不通鉴权', r.status === 401, `status=${r.status}`);
  // 畸形 Cookie（非法百分号编码）应稳定 401，而非 500
  r = await req('/api/metrics', {}, 'sp_token=%');
  check('畸形 Cookie 401（非 500）', r.status === 401, `status=${r.status}`);

  log('--- 已登录 ---');
  r = await req('/', {}, cookie);
  check(
    isSpa ? '已登录首页仍为 SPA 入口' : '首页返回仪表盘',
    r.status === 200 && (isSpa || r.body.includes('cpu-arc')),
    `status=${r.status} spa=${isSpa}`
  );
  r = await req('/api/metrics', {}, cookie);
  const m = JSON.parse(r.body);
  check('metrics 200', r.status === 200);
  check('CPU 数据有效', m.cpu && m.cpu.usage >= 0 && Array.isArray(m.cpu.cores), JSON.stringify(m.cpu && m.cpu.usage));
  check('内存数据有效', m.mem && m.mem.total > 0, JSON.stringify(m.mem));
  check('磁盘数据有效', Array.isArray(m.disks) && m.disks.length > 0, JSON.stringify(m.disks));
  check('温度字段存在(可为空)', Array.isArray(m.temps), JSON.stringify(m.temps));
  check('docker 字段存在', m.docker && Array.isArray(m.docker.containers), JSON.stringify(m.docker && m.docker.error));
  check('主机信息', m.host && m.host.hostname);
  r = await req('/api/health');
  check('health 公开 200', r.status === 200);
  r = await req('/api/processes');
  check('processes 未授权 401', r.status === 401, `status=${r.status}`);
  r = await req('/api/processes', {}, cookie);
  const pr = JSON.parse(r.body);
  check('processes 200 + available', r.status === 200 && pr.available === true, `status=${r.status}`);
  check('进程列表非空', Array.isArray(pr.list) && pr.list.length > 0, JSON.stringify(pr.error));
  check('进程字段完整', pr.list[0] && pr.list[0].pid >= 0 && typeof pr.list[0].cmd === 'string' && typeof pr.list[0].cpuPct === 'number', JSON.stringify(pr.list && pr.list[0]));
  r = await req('/api/logout', { method: 'POST' }, cookie);
  check('logout 200', r.status === 200);

  console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();
