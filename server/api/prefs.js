/**
 * 用户偏好模块（各应用视图选项的服务端持久化，零依赖）：
 * GET/PUT /api/prefs/:scope，落盘用户目录 ~/.watchdog-os/data.json 对应顶层键
 * （经 lib/userdata 合并写，与收藏夹等其它键互不覆盖）。
 *
 * 现有作用域（PREF_SCHEMAS 白名单，未列出的 path 一律 404）：
 *   editor —— wordWrap / showPreview
 *   finder —— showFavoritesSidebar（Files 收藏夹侧栏显隐，默认展开由前端决定）
 *
 * PUT 为部分合并语义：仅清洗并更新请求中出现的合法字段，未传字段保留原值
 * （区别于 /api/fs/favorites 的全量替换）。
 */
'use strict';

const { readBody, send } = require('../lib/http');
const { loadUserData, saveUserData } = require('../lib/userdata');

/* 各作用域的字段白名单：仅接受布尔开关，未知字段一律忽略（防止写入任意数据） */
const PREF_SCHEMAS = {
  editor: ['wordWrap', 'showPreview'],
  finder: ['showFavoritesSidebar'],
};

/** 清洗：从任意输入中提取合法的布尔字段（未设置 / 类型非布尔的键不出现） */
function sanitizePrefs(keys, raw) {
  const out = {};
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const key of keys) {
      if (typeof raw[key] === 'boolean') out[key] = raw[key];
    }
  }
  return out;
}

/** 偏好 API 分发（进入前已完成 checkAuth，路径均已剥离 BASE 前缀） */
async function prefsRoute(req, res, p) {
  const method = req.method || 'GET';

  const m = /^\/api\/prefs\/([a-z0-9_-]+)$/.exec(p);
  const scope = m && Object.prototype.hasOwnProperty.call(PREF_SCHEMAS, m[1]) ? m[1] : null;
  if (!scope) return send(res, 404, { error: 'not found' });
  const keys = PREF_SCHEMAS[scope];

  if (method === 'GET') {
    const data = await loadUserData();
    return send(res, 200, { [scope]: sanitizePrefs(keys, data[scope]) });
  }
  if (method === 'PUT') {
    let body = null;
    try {
      body = JSON.parse(await readBody(req, 64 * 1024));
    } catch {
      return send(res, 400, { error: 'Invalid request body' });
    }
    // 与磁盘现有值合并：未传字段不丢；损坏的历史值也被清洗掉
    const merged = Object.assign(
      {},
      sanitizePrefs(keys, (await loadUserData())[scope]),
      sanitizePrefs(keys, body && body[scope])
    );
    const data = await saveUserData({ [scope]: merged });
    return send(res, 200, { ok: true, [scope]: sanitizePrefs(keys, data[scope]) });
  }

  return send(res, 404, { error: 'not found' });
}

module.exports = { prefsRoute };
