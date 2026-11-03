/**
 * 编辑器草稿 API（文本编辑器未保存内容的自动缓存，零依赖）：
 *
 *   GET    /api/drafts                  列表（不含正文，附源文件 disk 状态）
 *   GET    /api/drafts/:id              单条（含正文）
 *   PUT    /api/drafts?path=&baseMtime= 写入（body 为 UTF-8 正文原文）
 *   DELETE /api/drafts?path=            按路径删除（幂等）
 *   DELETE /api/drafts/:id              按 id 删除（幂等）
 *   DELETE /api/drafts                  全部丢弃
 *
 * 写 / 删按 path 寻址（编辑器手里只有 path），读取按 id（恢复对话框用列表返回的 id）。
 * 存储格式与原子性见 lib/drafts.js；进入本模块前 router 已完成 checkAuth。
 */
'use strict';

const { readBody, send } = require('../lib/http');
const { cfg } = require('../config');
const store = require('../lib/drafts');

const ID_PATH_RE = /^\/api\/drafts\/([0-9a-f]{40})$/;

/** 初始化（建目录 + 清理残留 / 过期 / 超条数）；失败只 warn，不影响编辑器保存 */
async function startDrafts() {
  await store.startDrafts();
}

async function draftsRoute(req, res, p, url) {
  const method = req.method || 'GET';
  const q = url.searchParams;

  /* ---- 集合级：列表 / 写入 / 按路径删除 / 全部丢弃 ---- */
  if (p === '/api/drafts') {
    if (method === 'GET') {
      const drafts = await store.listDrafts();
      return send(res, 200, {
        drafts,
        limits: {
          maxBytes: store.MAX_TEXT,
          maxEntries: cfg.drafts.maxEntries,
          retentionDays: cfg.drafts.retentionDays,
        },
        dir: store.draftDir(),
      });
    }

    if (method === 'PUT') {
      const key = store.draftKey(q.get('path'));
      if (!key) return send(res, 400, { error: 'Invalid path' });
      let body;
      try {
        body = await readBody(req, store.MAX_TEXT + 1);
      } catch {
        return send(res, 413, { error: 'Content exceeds the size limit' });
      }
      if (Buffer.byteLength(body, 'utf8') > store.MAX_TEXT) {
        return send(res, 413, { error: 'Content exceeds the size limit' });
      }
      const raw = q.get('baseMtime');
      const baseMtime = raw == null || raw.trim() === '' ? null : parseInt(raw, 10);
      const meta = await store.writeDraft({
        path: key.path,
        content: body,
        baseMtime: Number.isFinite(baseMtime) ? baseMtime : null,
      }).catch((e) => {
        if (e && e.code === 'EBADPATH') return null;
        throw e;
      });
      if (!meta) return send(res, 400, { error: 'Invalid path' });
      return send(res, 200, { ok: true, ...meta });
    }

    if (method === 'DELETE') {
      const rawPath = q.get('path');
      if (rawPath == null) return send(res, 200, { ok: true, deleted: await store.deleteAllDrafts() });
      const key = store.draftKey(rawPath);
      if (!key) return send(res, 400, { error: 'Invalid path' });
      return send(res, 200, { ok: true, deleted: await store.deleteDraftByPath(key.path) });
    }

    return send(res, 404, { error: 'not found' });
  }

  /* ---- 单条：读取 / 删除 ---- */
  const m = ID_PATH_RE.exec(p);
  if (m) {
    const id = m[1];
    if (method === 'GET') {
      const draft = await store.readDraft(id);
      if (!draft) return send(res, 404, { error: 'Draft not found' });
      const disk = await store.diskState(draft.path);
      return send(res, 200, { ...draft, disk });
    }
    if (method === 'DELETE') {
      return send(res, 200, { ok: true, deleted: await store.deleteDraftById(id) });
    }
    return send(res, 404, { error: 'not found' });
  }

  return send(res, 404, { error: 'not found' });
}

module.exports = { draftsRoute, startDrafts };
