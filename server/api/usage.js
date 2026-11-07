/**
 * 大模型用量 Dashboard 代理模块（/api/usage/*）：
 *  - GET /api/usage/deepseek → 上游 GET {deepseekBaseUrl}/user/balance（官方公开接口）
 *  - GET /api/usage/bigmodel → 上游 GET {zaiBaseUrl}/api/biz/account/query-customer-account-report
 *    （智谱账户报告：按量付费余额/充值/赠送/累计消费；国内站用原始 API Key，国际站 z.ai 用 Bearer）
 * API Key 解析顺序：服务端本地配置（DEEPSEEK_API_KEY / ZAI_API_KEY）优先；
 * 留空时读取本机 hermes 的 .env（USAGE_ENV_FILE，默认 /root/.hermes/.env）并缓存，仍无 → 503。
 * key 只存服务端，不写入任何响应；上游 401/403 映射 502（避免前端把 401 当 watchdog 登出信号）；
 * 超时 504；连接类错误 503。零依赖：Node ≥18 内置全局 fetch。
 */
'use strict';

const fs = require('fs/promises');
const { cfg } = require('../config');
const { send } = require('../lib/http');

/** hermes 配置读取缓存：成功 5 分钟 / 失败 30 秒（失败短 TTL 避免每次请求都读盘，又能较快自愈） */
const ENV_CACHE_OK_MS = 5 * 60 * 1000;
const ENV_CACHE_FAIL_MS = 30 * 1000;
let hermesCache = { at: 0, ok: false, deepseek: '', zai: '', deepseekBaseUrl: '' };

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

/** 读本机 hermes 的 .env（USAGE_ENV_FILE 可覆盖，便于测试与换机器） */
async function readHermesEnv() {
  const text = await fs.readFile(cfg.usage.envFile, 'utf8');
  return parseHermesEnv(text);
}

/** 取 hermes 配置缓存（过期则重新读取；失败也占住缓存位，短 TTL 后重试） */
async function resolveHermesKeys() {
  const ttl = hermesCache.ok ? ENV_CACHE_OK_MS : ENV_CACHE_FAIL_MS;
  if (Date.now() - hermesCache.at > ttl) {
    try {
      hermesCache = { at: Date.now(), ok: true, ...(await readHermesEnv()) };
    } catch {
      hermesCache = { at: Date.now(), ok: false, deepseek: '', zai: '', deepseekBaseUrl: '' };
    }
  }
  return hermesCache;
}

/**
 * 解析 provider 的上游 key：本地配置优先；留空走 hermes 配置读取结果。
 * 返回 { key, hermes }（hermes 为 null 表示本地 key 命中、未触发读取）或 null（无可用 key）。
 */
async function resolveProvider(provider) {
  // 智谱（BigModel 余额）与 DeepSeek 各自一个 key 槽位；智谱 key 沿用 ZAI_API_KEY / hermes 的 GLM_API_KEY
  const slot = provider === 'deepseek' ? 'deepseek' : 'zai';
  const localKey = slot === 'deepseek' ? cfg.usage.deepseekKey : cfg.usage.zaiKey;
  if (localKey) return { key: localKey, hermes: null };
  const hermes = await resolveHermesKeys();
  const k = slot === 'deepseek' ? hermes.deepseek : hermes.zai;
  return k ? { key: k, hermes } : null;
}

/**
 * 智谱的区域认证差异：国内站（bigmodel.cn）账户接口用原始 API Key（无 Bearer 前缀），
 * 国际站（z.ai）用 Bearer。按上游主机自动适配；DeepSeek 一律 Bearer。
 */
function authHeader(provider, baseUrl, key) {
  if (provider === 'bigmodel') {
    try {
      if (!/(^|\.)z\.ai$/i.test(new URL(baseUrl).hostname)) return key;
    } catch { /* 非法 baseUrl 留给下面 new URL 报错 */ }
  }
  return `Bearer ${key}`;
}

/** DeepSeek 上游地址：本地配置 > hermes .env 的 DEEPSEEK_BASE_URL > 官方默认 */
function resolveDeepseekBaseUrl(hermes) {
  return cfg.usage.deepseekBaseUrl || (hermes && hermes.deepseekBaseUrl) || 'https://api.deepseek.com';
}

/** 单个 provider 的转发：无可用 key 503；上游 401/403 → 502；其余按上游状态归一 */
async function proxyUsage(res, provider) {
  const resolved = await resolveProvider(provider);
  if (!resolved) return send(res, 503, { error: `${provider} usage not configured` });
  const base =
    provider === 'deepseek' ? resolveDeepseekBaseUrl(resolved.hermes) : cfg.usage.zaiBaseUrl;
  const path =
    provider === 'deepseek' ? '/user/balance' : '/api/biz/account/query-customer-account-report';
  let upstream;
  try {
    upstream = new URL(path, base);
  } catch {
    return send(res, 503, { error: 'usage upstream invalid', detail: `${provider} baseUrl 配置非法` });
  }
  try {
    const r = await fetch(upstream, {
      headers: { Accept: 'application/json', Authorization: authHeader(provider, base, resolved.key) },
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

function getBigmodelUsage(req, res) {
  return proxyUsage(res, 'bigmodel');
}

module.exports = { getDeepseekUsage, getBigmodelUsage };
