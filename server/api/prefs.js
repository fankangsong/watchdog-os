/**
 * 用户偏好模块（Editor 视图选项的服务端持久化，零依赖）：
 * GET/PUT /api/prefs/editor，落盘用户目录 ~/.watchdog-os/data.json 的 editor 键
 * （经 lib/userdata 合并写，与收藏夹等其它键互不覆盖）。
 *
 * PUT 为部分合并语义：仅清洗并更新请求中出现的合法字段，未传字段保留原值
 * （区别于 /api/fs/favorites 的全量替换）。
 */
'use strict';

const { readBody, send } = require('../lib/http');
const { loadUserData, saveUserData } = require('../lib/userdata');

/* editor 偏好字段白名单：仅接受布尔开关，未知字段一律忽略（防止写入任意数据） */
const EDITOR_PREF_KEYS = ['wordWrap', 'showPreview'];

/** 清洗：从任意输入中提取合法的布尔字段（未设置 / 类型非布尔的键不出现） */
function sanitizeEditorPrefs(raw) {
  const out = {};
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const key of EDITOR_PREF_KEYS) {
      if (typeof raw[key] === 'boolean') out[key] = raw[key];
    }
  }
  return out;
}

/** 偏好 API 分发（进入前已完成 checkAuth，路径均已剥离 BASE 前缀） */
async function prefsRoute(req, res, p) {
  const method = req.method || 'GET';

  if (p === '/api/prefs/editor') {
    if (method === 'GET') {
      const data = await loadUserData();
      return send(res, 200, { editor: sanitizeEditorPrefs(data.editor) });
    }
    if (method === 'PUT') {
      let body = null;
      try {
        body = JSON.parse(await readBody(req, 64 * 1024));
      } catch {
        return send(res, 400, { error: 'Invalid request body' });
      }
      // 与磁盘现有值合并：未传字段不丢；损坏的历史值也被清洗掉
      const merged = Object.assign({}, sanitizeEditorPrefs((await loadUserData()).editor), sanitizeEditorPrefs(body && body.editor));
      const data = await saveUserData({ editor: merged });
      return send(res, 200, { ok: true, editor: sanitizeEditorPrefs(data.editor) });
    }
  }

  return send(res, 404, { error: 'not found' });
}

module.exports = { prefsRoute };
