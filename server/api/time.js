/**
 * 权威时间源（ClockApp / GET /api/time）
 *
 * 零依赖：只用 Node 内置 dgram 做轻量 NTP 客户端。systemd-timesyncd 通常已把本机
 * 时钟同步好，但客户端浏览器的时钟/时区不可信；本模块周期性地向 NTP 校时，给出
 * 一个带偏差修正的 UTC 时间戳，前端据此校正并按显式时区渲染。
 *
 * 行为：
 *  - 启动即异步首校（不阻塞 HTTP 监听），成功后每 5 分钟重校；
 *  - 失败保留上一次成功的偏差（仍按 NTP 来源），从未成功则回退系统时间；
 *  - NTP_ENABLED=false 时完全不发网络请求（测试/离线部署用）。
 */
'use strict';

const dgram = require('dgram');
const { cfg } = require('../config');

/** 1900-01-01 到 1970-01-01 的秒数（NTP 时间戳以 1900 为纪元） */
const NTP_EPOCH_OFFSET_SEC = 2208988800;
const NTP_PORT = 123;
const QUERY_TIMEOUT_MS = 2000;
const SYNC_INTERVAL_MS = 5 * 60 * 1000;
const RETRY_INTERVAL_MS = 60 * 1000;
/** 超过这个偏移量的结果视为异常（5 年），避免坏包把时钟带偏 */
const MAX_PLAUSIBLE_OFFSET_MS = 5 * 365 * 24 * 3600 * 1000;

/* ---------- 时区 ---------- */
function resolveTimeZone(tz) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    if (tz) console.warn(`[time] TIME_ZONE="${tz}" 不是合法 IANA 时区，回退 Asia/Shanghai`);
    return 'Asia/Shanghai';
  }
}
const TIME_ZONE = resolveTimeZone(cfg.time.timeZone);

/* ---------- 校时状态 ---------- */
let offsetMs = 0;
let delayMs = null;
let stratum = null;
let syncedAt = null;
let source = 'system';
let timer = null;
let inFlight = false;

function schedule(ms) {
  if (timer) clearTimeout(timer);
  timer = setTimeout(syncOnce, ms);
  // 校时定时器不应单独撑住事件循环（服务本身由 HTTP server 撑着）
  if (typeof timer.unref === 'function') timer.unref();
}

function msToNtp(ms) {
  const sec = Math.floor(ms / 1000) + NTP_EPOCH_OFFSET_SEC;
  const frac = Math.round((ms % 1000) / 1000 * 0x100000000);
  return { sec, frac };
}

function ntpToMs(buf, at) {
  const sec = buf.readUInt32BE(at) - NTP_EPOCH_OFFSET_SEC;
  const frac = buf.readUInt32BE(at + 4);
  return sec * 1000 + Math.round(frac / 0x100000000 * 1000);
}

/** 发一次 NTP 查询，resolve { offset, delay, stratum } */
function queryNtp() {
  return new Promise((resolve, reject) => {
    let socket;
    let watchdogGuard = null;
    let done = false;
    const finish = (fn, value) => {
      if (done) return;
      done = true;
      clearTimeout(watchdogGuard);
      try { if (socket) socket.close(); } catch { /* socket 可能已关闭 */ }
      fn(value);
    };

    try {
      socket = dgram.createSocket('udp4');
    } catch (e) {
      return reject(e);
    }

    const req = Buffer.alloc(48);
    req[0] = 0x1b; // LI=0, VN=3, Mode=3 (client)
    const t1 = Date.now();
    const ntp = msToNtp(t1);
    req.writeUInt32BE(ntp.sec, 40);
    req.writeUInt32BE(ntp.frac, 44);

    watchdogGuard = setTimeout(() => {
      finish(reject, new Error(`NTP ${cfg.time.ntpHost} 超时（${QUERY_TIMEOUT_MS}ms）`));
    }, QUERY_TIMEOUT_MS);

    socket.once('message', (res) => {
      if (res.length < 48) {
        return finish(reject, new Error('NTP 响应报文过短'));
      }
      const t2 = ntpToMs(res, 24); // 服务端收到请求
      const t3 = ntpToMs(res, 32); // 服务端发出响应
      const t4 = Date.now();       // 本地收到响应
      const delay = (t4 - t1) - (t3 - t2);
      const offset = ((t2 - t1) + (t3 - t4)) / 2;
      if (![t2, t3, offset, delay].every(Number.isFinite) ||
          delay < -1000 || delay > 2000 ||
          Math.abs(offset) > MAX_PLAUSIBLE_OFFSET_MS) {
        return finish(reject, new Error('NTP 响应数据异常，已丢弃'));
      }
      finish(resolve, { offset, delay, stratum: res[1] });
    });
    socket.once('error', (e) => finish(reject, e));

    try {
      socket.send(req, NTP_PORT, cfg.time.ntpHost, (err) => {
        if (err) finish(reject, err);
      });
    } catch (e) {
      finish(reject, e);
    }
  });
}

async function syncOnce() {
  if (inFlight) return;
  inFlight = true;
  try {
    const r = await queryNtp();
    offsetMs = r.offset;
    delayMs = r.delay;
    stratum = r.stratum;
    syncedAt = Date.now();
    source = 'ntp';
    console.log(
      `[time] NTP ${cfg.time.ntpHost} 校时成功：offset=${offsetMs.toFixed(1)}ms ` +
      `delay=${delayMs.toFixed(1)}ms stratum=${stratum}`
    );
    schedule(SYNC_INTERVAL_MS);
  } catch (e) {
    // 保留上次成功的 offset；从未成功则 offset 仍为 0（即系统时间）
    source = syncedAt ? 'ntp' : 'system';
    console.warn(`[time] NTP 校时失败（${(e && e.message) || e}），${syncedAt ? '沿用上次结果' : '回退系统时间'}`);
    schedule(RETRY_INTERVAL_MS);
  } finally {
    inFlight = false;
  }
}

/** 在 HTTP 监听建立后调用；失败只 warn，绝不影响主服务 */
function startTimeSync() {
  if (!cfg.time.ntpEnabled) {
    console.log('[time] NTP 校时已禁用（NTP_ENABLED=false），使用系统时间');
    return;
  }
  console.log(`[time] NTP 校时启动：host=${cfg.time.ntpHost} 时区=${TIME_ZONE}`);
  try {
    syncOnce();
  } catch (e) {
    console.warn('[time] NTP 校时启动异常（不影响其他接口）:', (e && e.message) || e);
  }
}

/** GET /api/time 的响应体：权威 UTC 毫秒 + 校时元数据 */
function getTimeSnapshot() {
  return {
    nowMs: Date.now() + offsetMs,
    timeZone: TIME_ZONE,
    source,
    offsetMs: Math.round(offsetMs * 100) / 100,
    delayMs: delayMs == null ? null : Math.round(delayMs * 100) / 100,
    stratum,
    syncedAt: syncedAt ? new Date(syncedAt).toISOString() : null,
  };
}

module.exports = { startTimeSync, getTimeSnapshot };
