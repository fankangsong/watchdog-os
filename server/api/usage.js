/**
 * 大模型用量 Dashboard 代理模块（/api/usage/*）：
 *  - GET /api/usage/deepseek → 上游 GET {deepseekBaseUrl}/user/balance（官方公开接口）
 *  - GET /api/usage/zai     → 上游 GET {zaiBaseUrl}/api/monitor/usage/quota/limit
 *    （智谱 Coding 套餐配额，官方前端在用的半官方接口，字段解析容错放前端）
 * API Key 解析顺序：服务端本地配置（DEEPSEEK_API_KEY / ZAI_API_KEY）优先；
 * 留空时经 SSH 读取 Mac 上 ~/.hermes/.env（USAGE_SSH_CMD，默认按键名 grep）并缓存，仍无 → 503。
 * key 只存服务端，不写入任何响应；上游 401/403 映射 502（避免前端把 401 当 watchdog 登出信号）；
 * 超时 504；连接类错误 503。零依赖：Node ≥18 内置全局 fetch + child_process。
 */
'use strict';

const { exec } = require('child_process');
const { cfg } = require('../config');
const { send } = require('../lib/http');

/** SSH 读取缓存：成功 5 分钟 / 失败 30 秒（失败短 TTL 避免每次请求都打 SSH，又能较快自愈） */
const SSH_CACHE_OK_MS = 5 * 60 * 1000;
const SSH_CACHE_FAIL_MS = 30 * 1000;
let sshCache = { at: 0, ok: false, deepseek: '', zai: '', deepseekBaseUrl: '' };

/** 解析 hermes .env 中所需的键：DEEPSEEK_API_KEY / DEEPSEEK_BASE_URL / GLM_API_KEY|ZAI_API_KEY（智谱） */
function parseHermesEnv(text) {
  const out = { deepseek: '', zai: '', deepseekBaseUrl: '' };
  for (const line of String(text || '').split('\n')) {
    const m = line.match(/^(DEEPSEEK_API_KEY|DEEPSEEK_BASE_URL|GLM_API_KEY|ZAI_API_KEY)=(.*)$/);
    if (!m) continue;
    const v = m[2].trim().replace(/^['"]|["']$/g, '');
    if (!v) continue;
    if (m[1] === 'DEEPSEEK_API_KEY') out.deepseek = v;
    else if (m[1] === 'DEEPSEEK_BASE_URL') out.deepseekBaseUrl = v;
    else out.zai = v; // GLM_API_KEY / ZAI_API_KEY → 智谱（ZAI）
  }
  return out;
}

/** SSH 读 Mac 上 ~/.hermes/.env（USAGE_SSH_CMD 可整体覆盖读取命令，便于测试与换机器） */
function runSshRead() {
  return new Promise((resolve, reject) => {
    exec(cfg.usage.sshCmd, { timeout: cfg.usage.timeoutMs }, (err, stdout) => {
      if (err) return reject(err);
      resolve(parseHermesEnv(stdout));
    });
  });
}

/** 取 SSH 缓存（过期则重新读取；失败也占住缓存位，短 TTL 后重试） */
async function resolveSshKeys() {
  const ttl = sshCache.ok ? SSH_CACHE_OK_MS : SSH_CACHE_FAIL_MS;
  if (Date.now() - sshCache.at > ttl) {
    try {
      sshCache = { at: Date.now(), ok: true, ...(await runSshRead()) };
    } catch {
      sshCache = { at: Date.now(), ok: false, deepseek: '', zai: '', deepseekBaseUrl: '' };
    }
  }
  return sshCache;
}

/**
 * 解析 provider 的上游 key：本地配置优先；留空走 SSH 读取结果。
 * 返回 { key, ssh }（ssh 为 null 表示本地 key 命中、未触发读取）或 null（无可用 key）。
 */
async function resolveProvider(provider) {
  const localKey = provider === 'deepseek' ? cfg.usage.deepseekKey : cfg.usage.zaiKey;
  if (localKey) return { key: localKey, ssh: null };
  const ssh = await resolveSshKeys();
  const k = provider === 'deepseek' ? ssh.deepseek : ssh.zai;
  return k ? { key: k, ssh } : null;
}

/** DeepSeek 上游地址：本地配置 > hermes .env 的 DEEPSEEK_BASE_URL > 官方默认 */
function resolveDeepseekBaseUrl(ssh) {
  return cfg.usage.deepseekBaseUrl || (ssh && ssh.deepseekBaseUrl) || 'https://api.deepseek.com';
}

/** 单个 provider 的转发：无可用 key 503；上游 401/403 → 502；其余按上游状态归一 */
async function proxyUsage(res, provider) {
  const resolved = await resolveProvider(provider);
  if (!resolved) return send(res, 503, { error: `${provider} usage not configured` });
  const base =
    provider === 'deepseek' ? resolveDeepseekBaseUrl(resolved.ssh) : cfg.usage.zaiBaseUrl;
  const path = provider === 'deepseek' ? '/user/balance' : '/api/monitor/usage/quota/limit';
  let upstream;
  try {
    upstream = new URL(path, base);
  } catch {
    return send(res, 503, { error: 'usage upstream invalid', detail: `${provider} baseUrl 配置非法` });
  }
  try {
    const r = await fetch(upstream, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${resolved.key}` },
      signal: AbortSignal.timeout(cfg.usage.timeoutMs),
    });
    if (r.status === 401 || r.status === 403) {
      return send(res, 502, { error: 'usage upstream rejected the API key' });
    }
    const text = await r.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = { raw: text.slice(0, 2000) }; // 非 JSON 上游响应兜底（截断防巨型）
    }
    return send(res, r.ok ? 200 : 502, json);
  } catch (e) {
    if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
      return send(res, 504, { error: 'usage upstream timeout' });
    }
    return send(res, 503, {
      error: 'usage upstream unreachable',
      detail: e instanceof Error ? e.message : String(e),
    });
  }
}

function getDeepseekUsage(req, res) {
  return proxyUsage(res, 'deepseek');
}

function getZaiUsage(req, res) {
  return proxyUsage(res, 'zai');
}

module.exports = { getDeepseekUsage, getZaiUsage };
