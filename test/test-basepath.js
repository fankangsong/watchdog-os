/* basePath=/probe 冒烟测试
 * 依赖已在运行的服务（BASE_HOST，默认 http://localhost:3001，且以 BASE_PATH=/probe 启动）；
 * 密码从环境变量 PASSWORD 读取（服务端已移除内置默认口令，必须显式配置）。 */
const HOST = process.env.BASE_HOST || 'http://localhost:3001';
const P = '/probe';
const PASSWORD = process.env.PASSWORD;

(async () => {
  if (!PASSWORD) {
    console.error('缺少 PASSWORD 环境变量（服务端已移除内置默认口令）：');
    console.error('  PowerShell: $env:PASSWORD="<访问密码>"; node test/test-basepath.js');
    process.exit(1);
  }
  const pass = []; const fail = [];
  const check = (name, cond, detail) => (cond ? pass : fail).push(name + (cond ? '' : '  ' + (detail || '')));

  // 未带前缀 → 404
  let r = await fetch(HOST + '/api/metrics', { redirect: 'manual' });
  check('无前缀 /api/metrics → 404', r.status === 404, 'got ' + r.status);

  // 前缀下首页 200：SPA 分支下未登录/已登录返回同一份 Vite index.html，
  // 登录页与仪表盘由前端按鉴权态切换
  r = await fetch(HOST + P + '/', { redirect: 'manual' });
  const body = await r.text();
  const isSpa = body.includes('id="root"');
  check(
    '带前缀首页 → SPA 入口 200',
    r.status === 200 && isSpa,
    'got ' + r.status + ' spa=' + isSpa
  );

  // 未授权接口 401
  r = await fetch(HOST + P + '/api/metrics', { redirect: 'manual' });
  check('带前缀未授权 → 401', r.status === 401, 'got ' + r.status);

  // 登录（校验 Cookie Path=/probe）
  r = await fetch(HOST + P + '/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD }),
  });
  const sc = r.headers.get('set-cookie') || '';
  const cookie = sc.split(';')[0];
  check('登录 200 + Cookie Path=/probe', r.status === 200 && sc.includes('Path=/probe'), sc);

  // 带 Cookie 访问 metrics
  r = await fetch(HOST + P + '/api/metrics', { headers: { Cookie: cookie } });
  const m = await r.json();
  check('带前缀 metrics 200', r.status === 200);
  check('指标完整', m.cpu && m.mem && Array.isArray(m.disks));

  // 登录后首页：与未登录时同一份 index.html，鉴权态由前端切换
  r = await fetch(HOST + P + '/', { headers: { Cookie: cookie } });
  const dash = await r.text();
  check(
    '已登录首页仍为 SPA 入口',
    r.status === 200 && dash.includes('id="root"'),
    'got ' + r.status + ' spa=' + isSpa
  );

  // 静态资源带前缀可访问：SPA index.html 引用的 /assets/* 哈希文件
  const asset = (body.match(/src="\.?\/?(assets\/[^"]+\.js)"/) || [])[1];
  check('首页引用了 assets 脚本', !!asset, body.slice(0, 120));
  if (asset) {
    r = await fetch(HOST + P + '/' + asset);
    check('带前缀 ' + asset + ' 200', r.status === 200, 'got ' + r.status);
  }
  const css = (body.match(/href="\.?\/?(assets\/[^"]+\.css)"/) || [])[1];
  if (css) {
    r = await fetch(HOST + P + '/' + css);
    check('带前缀 ' + css + ' 200', r.status === 200, 'got ' + r.status);
  }

  // 模拟 Nginx 场景：health 公开
  r = await fetch(HOST + P + '/api/health');
  check('带前缀 health 200', r.status === 200);

  console.log('PASS ' + pass.length + ' / FAIL ' + fail.length);
  pass.forEach((s) => console.log('  OK ' + s));
  fail.forEach((s) => console.log('  FAIL ' + s));
  process.exit(fail.length ? 1 : 0);
})();
