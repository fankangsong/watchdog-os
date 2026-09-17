/* 端到端冒烟测试：鉴权 + basePath */
const BASE_HOST = 'http://localhost:3000';

async function req(path, opts = {}, cookies = '') {
  const headers = Object.assign({}, opts.headers || {});
  if (cookies) headers['Cookie'] = cookies;
  const r = await fetch(BASE_HOST + path, Object.assign({}, opts, { headers, redirect: 'manual' }));
  let body = await r.text();
  let setCookie = r.headers.get('set-cookie') || '';
  return { status: r.status, body, setCookie };
}

(async () => {
  const log = (...a) => console.log(...a);
  let pass = 0, fail = 0;
  const check = (name, cond, detail) => {
    if (cond) { pass++; log(`  ✅ ${name}`); }
    else { fail++; log(`  ❌ ${name}  ${detail || ''}`); }
  };

  log('--- 未登录 ---');
  let r = await req('/');
  check('首页返回登录页(200)', r.status === 200 && r.body.includes('login-form'), `status=${r.status}`);
  r = await req('/api/metrics');
  check('metrics 未授权 401', r.status === 401, `status=${r.status}`);
  r = await req('/api/docker');
  check('docker 未授权 401', r.status === 401, `status=${r.status}`);

  log('--- 登录 ---');
  r = await req('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'wrong' }) });
  check('错误密码 401', r.status === 401, `status=${r.status}`);
  r = await req('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'admin123' }) });
  check('正确密码 200', r.status === 200, `status=${r.status}`);
  check('返回 token', JSON.parse(r.body).token && JSON.parse(r.body).token.length === 64);
  const cookie = r.setCookie.split(';')[0];
  check('Set-Cookie 已下发', cookie.startsWith('sp_token='), cookie);

  log('--- 已登录 ---');
  r = await req('/', {}, cookie);
  check('首页返回仪表盘', r.status === 200 && r.body.includes('cpu-arc'), `status=${r.status}`);
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
