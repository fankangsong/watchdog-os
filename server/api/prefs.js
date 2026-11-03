/**
 * 用户偏好模块（各应用视图选项的服务端持久化，零依赖）：
 * GET/PUT /api/prefs/:scope，落盘用户目录 ~/.watchdog-os/data.json 对应顶层键
 * （经 lib/userdata 合并写，与收藏夹等其它键互不覆盖）。
 *
 * 现有作用域（PREF_SCHEMAS 白名单，未列出的 path 一律 404）：
 *   editor —— wordWrap / showPreview / theme / fontSize / fontFamily
 *   finder —— showFavoritesSidebar（Files 收藏夹侧栏显隐，默认展开由前端决定）
 *
 * PUT 为部分合并语义：仅清洗并更新请求中出现的合法字段，未传字段保留原值
 * （区别于 /api/fs/favorites 的全量替换）。
 */
'use strict';

const { readBody, send } = require('../lib/http');
const { loadUserData, saveUserData, DATA_FILE } = require('../lib/userdata');

/* 各作用域的字段表：只描述「类型 + 长度/范围」，不复制前端的枚举白名单
   （主题 id 与字体栈来自前端的 EDITOR_THEMES / EDITOR_FONTS，服务端复制一份必然漂移；
   未知枚举值由前端读取时回退默认，服务端只保证不写入超长 / 类型错误的数据）。 */
const PREF_SCHEMAS = {
  editor: {
    wordWrap: { type: 'boolean' },
    showPreview: { type: 'boolean' },
    theme: { type: 'string', max: 32 },
    fontSize: { type: 'int', min: 10, max: 24 },
    fontFamily: { type: 'string', max: 64 },
  },
  finder: {
    showFavoritesSidebar: { type: 'boolean' },
  },
};

/** 清洗：从任意输入中提取符合字段表的键（未设置 / 类型或范围不符的键不出现） */
function sanitizePrefs(schema, raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [key, rule] of Object.entries(schema)) {
    const v = raw[key];
    if (rule.type === 'boolean') {
      if (typeof v === 'boolean') out[key] = v;
      continue;
    }
    if (rule.type === 'string') {
      if (typeof v !== 'string') continue;
      const s = v.trim();
      if (!s || s.length > rule.max) continue;
      out[key] = s;
      continue;
    }
    if (rule.type === 'int') {
      if (typeof v !== 'number' || !Number.isInteger(v)) continue;
      if (v < rule.min || v > rule.max) continue;
      out[key] = v;
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
  const schema = PREF_SCHEMAS[scope];

  if (method === 'GET') {
    const data = await loadUserData();
    // file 一并回传：编辑器设置面板直接展示落盘位置，省去"到底存哪了"的猜测
    return send(res, 200, { [scope]: sanitizePrefs(schema, data[scope]), file: DATA_FILE });
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
      sanitizePrefs(schema, (await loadUserData())[scope]),
      sanitizePrefs(schema, body && body[scope])
    );
    const data = await saveUserData({ [scope]: merged });
    return send(res, 200, { ok: true, [scope]: sanitizePrefs(schema, data[scope]) });
  }

  return send(res, 404, { error: 'not found' });
}

module.exports = { prefsRoute };
