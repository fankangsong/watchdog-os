// 临时脚本：触发 Runner build 并轮询到结束（验证完可删除）
const http = require('http');

const PORT = 1234;
const BASE = '/tkp';
const fs = require('fs');
const password = fs.readFileSync(__dirname + '/.env', 'utf8').match(/PASSWORD=(.*)/)[1].trim();

function req(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request(
      { host: '127.0.0.1', port: PORT, path: BASE + path, method,
        headers: Object.assign(
          { 'Content-Type': 'application/json' },
          data ? { 'Content-Length': Buffer.byteLength(data) } : {},
          token ? { Authorization: 'Bearer ' + token } : {}
        ) },
      (res) => {
        let buf = '';
        res.on('data', (c) => (buf += c));
        res.on('end', () => resolve({ status: res.statusCode, body: buf }));
      }
    );
    r.on('error', reject);
    r.setTimeout(15000, () => r.destroy(new Error('timeout')));
    if (data) r.write(data);
    r.end();
  });
}

(async () => {
  const login = await req('POST', '/api/login', { password });
  if (login.status !== 200) throw new Error('login failed: ' + login.status + ' ' + login.body);
  const token = JSON.parse(login.body).token;
  console.log('[login] ok');

  const start = await req('POST', '/api/runner/start', {}, token);
  console.log('[start]', start.status, start.body);
  if (start.status !== 200) process.exit(1);

  // 轮询 status，直到 running=false（至少 3 秒后才开始判断，避免竞态）
  const startedAt = Date.now();
  for (let i = 0; ; i++) {
    await new Promise((r) => setTimeout(r, 10000));
    const s = await req('GET', '/api/runner/status?lines=5', null, token);
    const j = JSON.parse(s.body);
    const tail = (j.logTail || []).join('\n');
    console.log(`[poll ${i}] running=${j.running} elapsed=${Math.round((Date.now() - startedAt) / 1000)}s`);
    if (!j.running && Date.now() - startedAt > 5000) {
      const full = await req('GET', '/api/runner/status?lines=100', null, token);
      const fj = JSON.parse(full.body);
      console.log('----- log tail -----');
      console.log((fj.logTail || []).join('\n'));
      const last = (fj.last && fj.last.exitCode) ?? 'unknown';
      console.log('----- exit code:', last, '-----');
      process.exit(last === 0 ? 0 : 2);
    }
  }
})().catch((e) => {
  console.error('[error]', e.message);
  process.exit(1);
});
