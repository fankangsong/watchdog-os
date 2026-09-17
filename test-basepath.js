/* basePath=/probe 冒烟测试 */
const HOST = 'http://localhost:3001';
const P = '/probe';

(async () => {
  const pass = []; const fail = [];
  const check = (name, cond, detail) => (cond ? pass : fail).push(name + (cond ? '' : '  ' + (detail || '')));

  // 未带前缀 → 404
  let r = await fetch(HOST + '/api/metrics', { redirect: 'manual' });
  check('无前缀 /api/metrics → 404', r.status === 404, 'got ' + r.status);

  // 前缀下未登录 → 登录页
  r = await fetch(HOST + P + '/', { redirect: 'manual' });
  const body = await r.text();
  check('带前缀首页 → 登录页 200', r.status === 200 && body.includes('login-form'), 'got ' + r.status);

  // 未授权接口 401
  r = await fetch(HOST + P + '/api/metrics', { redirect: 'manual' });
  check('带前缀未授权 → 401', r.status === 401, 'got ' + r.status);

  // 登录（校验 Cookie Path=/probe）
  r = await fetch(HOST + P + '/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'admin123' }),
  });
  const sc = r.headers.get('set-cookie') || '';
  const cookie = sc.split(';')[0];
  check('登录 200 + Cookie Path=/probe', r.status === 200 && sc.includes('Path=/probe'), sc);

  // 带 Cookie 访问 metrics
  r = await fetch(HOST + P + '/api/metrics', { headers: { Cookie: cookie } });
  const m = await r.json();
  check('带前缀 metrics 200', r.status === 200);
  check('指标完整', m.cpu && m.mem && Array.isArray(m.disks));

  // 登录后首页为仪表盘
  r = await fetch(HOST + P + '/', { headers: { Cookie: cookie } });
  const dash = await r.text();
  check('登录后首页为仪表盘', r.status === 200 && dash.includes('cpu-arc'));

  // 静态资源带前缀可访问
  r = await fetch(HOST + P + '/app.js');
  check('带前缀 app.js 200', r.status === 200);
  r = await fetch(HOST + P + '/style.css');
  check('带前缀 style.css 200', r.status === 200);

  // 模拟 Nginx 场景：health 公开
  r = await fetch(HOST + P + '/api/health');
  check('带前缀 health 200', r.status === 200);

  console.log('PASS ' + pass.length + ' / FAIL ' + fail.length);
  pass.forEach((s) => console.log('  OK ' + s));
  fail.forEach((s) => console.log('  FAIL ' + s));
  process.exit(fail.length ? 1 : 0);
})();
