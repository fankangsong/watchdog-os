#!/usr/bin/env node
/* 编辑器偏好纯逻辑回归（src/editorPrefs.ts）：零依赖，用 Node 22+ 的原生 TS 类型擦除直接跑。
   守护「改了 Word Wrap / Show Preview / 主题，下次打开还在」这条链路里最容易错的三件事：
     1. 首屏兜底解析（localStorage 损坏 / 非法枚举不能污染偏好）；
     2. 服务端值合并（缺键保留本地、非法值回退默认、用户刚改过的字段不能被 hydration 弹回去）；
     3. 推送判定（服务端有值比差异，缺键时只有非默认值才推 —— 从未动过设置的用户零写盘）。 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'srv-editor-prefs-'));

let passed = 0;
let failed = 0;
function ok(name, cond, extra = '') {
  if (cond) {
    passed++;
    console.log(`PASS ${name}${extra ? ' — ' + extra : ''}`);
  } else {
    failed++;
    console.log(`FAIL ${name}${extra ? ' — ' + extra : ''}`);
  }
}

let mod;
try {
  /* 复制成 .mts 并补全相对导入扩展名：Node 的 ESM 解析不像打包器那样能省略扩展名 */
  fs.copyFileSync(path.join(ROOT, 'src', 'editorThemes.ts'), path.join(TMP, 'editorThemes.mts'));
  const src = fs
    .readFileSync(path.join(ROOT, 'src', 'editorPrefs.ts'), 'utf8')
    .replace(/from '\.\/editorThemes'/g, "from './editorThemes.mts'");
  fs.writeFileSync(path.join(TMP, 'editorPrefs.mts'), src, 'utf8');
  mod = await import(pathToFileURL(path.join(TMP, 'editorPrefs.mts')).href);
} catch (e) {
  console.log(`SKIP 编辑器偏好测试（当前 Node 不支持 TS 类型擦除：${(e && e.message) || e}）`);
  process.exit(0);
}

const { DEFAULT_PREFS, mergeServerPrefs, parseStoredPrefs, prefsNeedPush } = mod;
const NONE = new Set();
const prefs = (patch = {}) => ({ ...DEFAULT_PREFS, ...patch });

(async () => {
  /* ---------- 1. 首屏兜底解析 ---------- */
  {
    ok('null storage → defaults', JSON.stringify(parseStoredPrefs(null)) === JSON.stringify(DEFAULT_PREFS));
    ok('empty string → defaults', JSON.stringify(parseStoredPrefs('')) === JSON.stringify(DEFAULT_PREFS));
    ok('broken json → defaults', JSON.stringify(parseStoredPrefs('{oops')) === JSON.stringify(DEFAULT_PREFS));

    const p = parseStoredPrefs(JSON.stringify({ wordWrap: true, showPreview: true, theme: 'githubDark', fontSize: 18, fontFamily: 'monospace' }));
    ok(
      'valid stored values kept',
      p.wordWrap === true && p.showPreview === true && p.theme === 'githubDark' && p.fontSize === 18 && p.fontFamily === 'monospace',
      JSON.stringify(p)
    );

    const bad = parseStoredPrefs(JSON.stringify({ theme: 'nope', fontSize: '14', fontFamily: '} body{display:none}' }));
    ok(
      'invalid enum / size falls back',
      bad.theme === DEFAULT_PREFS.theme && bad.fontSize === DEFAULT_PREFS.fontSize && bad.fontFamily === DEFAULT_PREFS.fontFamily,
      JSON.stringify(bad)
    );
  }

  /* ---------- 2. 服务端合并 ---------- */
  {
    const merged = mergeServerPrefs(prefs(), { wordWrap: true, showPreview: true }, NONE);
    ok('server booleans applied', merged.wordWrap === true && merged.showPreview === true, JSON.stringify(merged));

    const typed = mergeServerPrefs(prefs(), { theme: 'vscodeDark', fontSize: 20, fontFamily: 'monospace' }, NONE);
    ok('server typed fields applied', typed.theme === 'vscodeDark' && typed.fontSize === 20 && typed.fontFamily === 'monospace');

    // 用户在本会话里刚点过 Word Wrap：hydration 晚到也不能把它弹回去
    const raced = mergeServerPrefs(prefs({ wordWrap: false }), { wordWrap: true }, new Set(['wordWrap']));
    ok('mutated field wins over server', raced.wordWrap === false && raced.showPreview === false, JSON.stringify(raced));

    // 未改过的字段仍以服务端为准（这是"只标记一个字段不能锁死整轮 hydration"的回归点）
    const partial = mergeServerPrefs(prefs({ wordWrap: false }), { wordWrap: true, theme: 'githubLight' }, new Set(['showPreview']));
    ok('untouched fields still hydrate', partial.wordWrap === true && partial.theme === 'githubLight', JSON.stringify(partial));

    // 服务端缺键 → 保留本地（老用户 localStorage 迁移载体）
    const migrated = mergeServerPrefs(prefs({ theme: 'githubDark', fontSize: 18 }), {}, NONE);
    ok('missing server keys keep local', migrated.theme === 'githubDark' && migrated.fontSize === 18, JSON.stringify(migrated));

    // 服务端存了非法主题 → 回退默认，不能把脏值塞进 CodeMirror
    const dirty = mergeServerPrefs(prefs(), { theme: 'evil', fontFamily: 'x;}' }, NONE);
    ok(
      'invalid server values fall back',
      dirty.theme === DEFAULT_PREFS.theme && dirty.fontFamily === DEFAULT_PREFS.fontFamily,
      JSON.stringify(dirty)
    );

    // showPreview:false 回归：程序化写入的本地 true 只要没进 mutated，hydration 必须采用服务端 false
    const previewOff = mergeServerPrefs(prefs({ showPreview: true }), { showPreview: false }, NONE);
    ok('server false overrides local true (unmutated)', previewOff.showPreview === false, JSON.stringify(previewOff));
    // 反向兼容：服务端历史值 true 仍要能盖过本地默认 false
    const previewOn = mergeServerPrefs(prefs({ showPreview: false }), { showPreview: true }, NONE);
    ok('server true overrides local false', previewOn.showPreview === true, JSON.stringify(previewOn));
    // 用户本会话亲自点过菜单时本地仍胜出（既有 mutated 语义，不能因修 bug 改坏）
    const previewMutated = mergeServerPrefs(prefs({ showPreview: true }), { showPreview: false }, new Set(['showPreview']));
    ok('mutated showPreview wins over server', previewMutated.showPreview === true, JSON.stringify(previewMutated));
  }

  /* ---------- 3. 推送判定 ---------- */
  {
    ok('never touched → no push', prefsNeedPush(DEFAULT_PREFS, {}) === false);
    ok('local custom → push', prefsNeedPush(prefs({ wordWrap: true }), {}) === true);
    ok('same as server → no push', prefsNeedPush(prefs({ wordWrap: true }), { wordWrap: true }) === false);
    ok('differs from server → push', prefsNeedPush(prefs({ wordWrap: false }), { wordWrap: true }) === true);
    ok('typed diff → push', prefsNeedPush(prefs({ fontSize: 20 }), { fontSize: 18 }) === true);
    ok(
      'multiple fields, one differs → push',
      prefsNeedPush(prefs({ wordWrap: true, theme: 'githubLight' }), { wordWrap: true, theme: 'dracula' }) === true
    );
    ok('unknown server keys ignored', prefsNeedPush(DEFAULT_PREFS, { legacy: 1 }) === false);

    // 关掉预览的核心链路：服务端 true → 本地 false，必须推送 false 覆盖
    ok('closing preview pushes false over server true', prefsNeedPush(prefs({ showPreview: false }), { showPreview: true }) === true);
    ok('opening preview pushes true when server has no key', prefsNeedPush(prefs({ showPreview: true }), {}) === true);
    // 服务端缺键 + 值等于默认 false = 从未动过设置，零写盘（既有语义）
    ok('server missing + default false → no push', prefsNeedPush(prefs({ showPreview: false }), {}) === false);
  }

  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
