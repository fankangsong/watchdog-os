/**
 * 终端链路临时验证：直连 127.0.0.1:<port>（WSL2 转发口）验证真实 ttyd 的 WS 帧协议是否可用。
 * 验证点：1) /token 有响应；2) /ws 以子协议 'tty' 升级成功；3) 首条发送 ttyd 1.7.x 认证 JSON 帧后
 *          收到输出帧（首字节 '0'）；4) 发送输入帧后能收到回显（证明 -W 可写生效）。
 * 用法：node test/test-terminal-ws.js [port]
 */
'use strict';

const http = require('http');
const crypto = require('crypto');
const net = require('net');

const port = Number(process.argv[2] || 7681);

function getToken() {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: '/token', method: 'GET', timeout: 5000 },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve(body));
      }
    );
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

/** 裸 TCP 完成 WebSocket 握手（避免为一次验证引入 ws 依赖） */
function wsHandshake() {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString('base64');
    const sock = net.connect(port, '127.0.0.1', () => {
      sock.write(
        `GET /ws HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\n` +
          `Connection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n` +
          `Sec-WebSocket-Protocol: tty\r\n\r\n`
      );
    });
    let buf = Buffer.alloc(0);
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const idx = buf.indexOf('\r\n\r\n');
      if (idx === -1) return;
      sock.removeListener('data', onData);
      resolve({ sock, head: buf.slice(0, idx).toString('utf8'), rest: buf.slice(idx + 4) });
    };
    sock.on('data', onData);
    sock.on('error', reject);
    setTimeout(() => reject(new Error('握手超时')), 5000);
  });
}

/** 解服务端帧（ttyd 服务端帧未掩码、不分片） */
function decode(buf) {
  const out = [];
  let i = 0;
  while (i + 2 <= buf.length) {
    const op = buf[i] & 0x0f;
    let len = buf[i + 1] & 0x7f;
    let off = i + 2;
    if (len === 126) { len = buf.readUInt16BE(off); off += 2; }
    else if (len === 127) { len = Number(buf.readBigUInt64BE(off)); off += 8; }
    if (off + len > buf.length) break;
    out.push({ op, payload: buf.slice(off, off + len) });
    i = off + len;
  }
  return { frames: out, rest: buf.slice(i) };
}

/** 客户端→服务端必须掩码 */
function encode(op, payload) {
  const mask = crypto.randomBytes(4);
  const masked = Buffer.from(payload.map((b, k) => b ^ mask[k % 4]));
  let header;
  if (payload.length < 126) {
    header = Buffer.from([0x80 | op, 0x80 | payload.length]);
  } else {
    header = Buffer.alloc(4);
    header[0] = 0x80 | op;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(payload.length, 2);
  }
  return Buffer.concat([header, mask, masked]);
}

/** 收集帧直到 predicate 满足或超时 */
function waitFrames(state, predicate, timeoutMs) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const tick = () => {
      if (predicate(state.frames) || Date.now() > deadline) return resolve(state.frames);
      setTimeout(tick, 100);
    };
    tick();
  });
}

(async () => {
  let sock;
  try {
    console.log(`[1] GET http://127.0.0.1:${port}/token`);
    const tokenBody = await getToken();
    console.log('    ->', tokenBody);
    let token = '';
    try { token = JSON.parse(tokenBody).token || ''; } catch { /* 保留空串 */ }

    console.log(`[2] WS 握手（子协议 tty）`);
    const hs = await wsHandshake();
    sock = hs.sock;
    console.log('    ->', hs.head.split('\r\n')[0]);
    if (!/101/.test(hs.head)) throw new Error('握手失败：' + hs.head.split('\r\n')[0]);

    const state = { frames: [], acc: hs.rest };
    sock.on('data', (c) => {
      state.acc = Buffer.concat([state.acc, c]);
      const d = decode(state.acc);
      state.acc = d.rest;
      state.frames.push(...d.frames);
    });

    console.log('[3] 发送 ttyd 1.7.x 首帧（text 帧裸 JSON 认证，不加命令前缀）');
    sock.write(encode(1, Buffer.from(JSON.stringify({ AuthToken: token, columns: 100, rows: 30 }))));
    await waitFrames(state, (fs) => fs.some((f) => f.payload.length && String.fromCharCode(f.payload[0]) === '0'), 6000);
    const outputs = state.frames.filter((f) => f.payload.length && String.fromCharCode(f.payload[0]) === '0');
    const text = outputs.map((f) => f.payload.slice(1).toString('utf8')).join('');
    console.log(`    -> 收到 ${state.frames.length} 帧（输出帧 ${outputs.length} 个）`);
    console.log('    ->', JSON.stringify(text.slice(0, 200)));
    if (!outputs.length) {
      console.log('    帧明细:');
      state.frames.forEach((f, i) => {
        console.log(`      #${i} opcode=${f.op} len=${f.payload.length} hex=${f.payload.slice(0, 48).toString('hex')}`);
        console.log(`         ascii=${JSON.stringify(f.payload.toString('utf8').slice(0, 80))}`);
      });
    }
    if (!outputs.length) throw new Error('未收到 ttyd 输出帧（首字节应为 "0"）');

    console.log('[4] 发送 resize + 输入帧（验证 -W 可写）');
    const before = state.frames.length;
    // ttyd 命令帧：首字节为命令字符（'0'=INPUT / '1'=RESIZE_TERMINAL），必须是 binary(opcode 2) 帧
    sock.write(encode(2, Buffer.concat([Buffer.from('1'), Buffer.from(JSON.stringify({ columns: 100, rows: 30 }))])));
    sock.write(encode(2, Buffer.concat([Buffer.from('0'), Buffer.from('echo-marker-987\r')])));
    await waitFrames(state, (fs) => fs.slice(before).some((f) => f.payload.toString('utf8').includes('echo-marker-987')), 5000);
    const newFrames = state.frames.slice(before);
    const echoed = newFrames.some((f) => f.payload.toString('utf8').includes('echo-marker-987'));
    console.log(`    -> 新增 ${newFrames.length} 帧`);
    newFrames.forEach((f, i) => {
      console.log(`      +${i} opcode=${f.op} len=${f.payload.length} ascii=${JSON.stringify(f.payload.toString('utf8').slice(0, 100))}`);
    });
    console.log('    -> 回显收到:', echoed ? '是' : '否');

    console.log(echoed
      ? '\n✅ 终端链路正常：真实 ttyd + WSL 转发 + 握手 + 帧协议 + 可写(-W)'
      : '\n⚠️ 输出正常但未见回显（-W 可能缺失）');
    process.exit(echoed ? 0 : 2);
  } catch (e) {
    console.error('\n❌ 验证失败:', e.message);
    process.exit(1);
  } finally {
    if (sock) sock.destroy();
  }
})();