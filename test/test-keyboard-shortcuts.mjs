#!/usr/bin/env node
/* 全局快捷键纯逻辑回归（src/shortcuts.ts）：零依赖，esbuild 仅作 TS 转译。
   守护：键位归一、事件匹配、默认 Ctrl+Q、冲突检测、清除绑定、localStorage 落盘。 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src', 'shortcuts.ts');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-shortcuts-'));

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

async function loadEsbuild() {
  try {
    return await import('esbuild');
  } catch {
    const pnpmDir = path.join(ROOT, 'node_modules', '.pnpm');
    if (fs.existsSync(pnpmDir)) {
      for (const name of fs.readdirSync(pnpmDir)) {
        if (!name.startsWith('esbuild@')) continue;
        const entry = path.join(pnpmDir, name, 'node_modules', 'esbuild', 'lib', 'main.js');
        if (fs.existsSync(entry)) return import(pathToFileURL(entry).href);
      }
    }
    throw new Error('esbuild not found');
  }
}

let bundle;
try {
  const esbuild = await loadEsbuild();
  bundle = path.join(TMP, 'shortcuts.mjs');
  await esbuild.build({
    entryPoints: [SRC],
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile: bundle,
    logLevel: 'silent',
  });
} catch (e) {
  console.log(`SKIP 快捷键测试（esbuild 不可用：${(e && e.message) || e}）`);
  process.exit(0);
}

/* 假 localStorage：模块导入时读取一次，之后由 setShortcutBinding 写入 */
const storage = new Map();
globalThis.window = {
  localStorage: {
    getItem: (k) => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => storage.set(k, String(v)),
    removeItem: (k) => storage.delete(k),
  },
};

const S = await import(pathToFileURL(bundle).href);

/* ---------- 键位归一 ---------- */
ok('归一 Ctrl+Q', S.canonicalChord('Ctrl+Q') === 'ctrl+q');
ok('归一并排序修饰键', S.canonicalChord('Shift+Control+Q') === 'ctrl+shift+q');
ok('支持 ⌘/Command 别名', S.canonicalChord('Command+O') === 'meta+o');
ok('拒绝只有修饰键', S.canonicalChord('Ctrl+Shift') === null);
ok('拒绝多个主键', S.canonicalChord('Ctrl+Q+W') === null);
ok('拒绝空串', S.canonicalChord('') === null);
ok('默认键位是 Ctrl+Q', S.getShortcutBindings()['quit-app'] === 'ctrl+q');
ok('展示为 ⌃Q', S.formatChord('ctrl+q') === '⌃Q');

/* ---------- 事件匹配 ---------- */
const ev = (over = {}) => ({
  key: 'q',
  code: 'KeyQ',
  ctrlKey: true,
  altKey: false,
  shiftKey: false,
  metaKey: false,
  ...over,
});
ok('Ctrl+Q 命中', S.matchesChord(ev(), 'ctrl+q'));
ok('多按 Shift 不命中', !S.matchesChord(ev({ shiftKey: true }), 'ctrl+q'));
ok('少按 Ctrl 不命中', !S.matchesChord(ev({ ctrlKey: false }), 'ctrl+q'));
ok('从事件生成键位', S.chordFromEvent(ev()) === 'ctrl+q');
ok('非拉丁布局用物理键位', S.chordFromEvent(ev({ key: 'й' })) === 'ctrl+q');
ok('无修饰键不生成', S.chordFromEvent(ev({ ctrlKey: false })) === null);
ok('只有修饰键不生成', S.chordFromEvent(ev({ key: 'Control' })) === null);
ok('动作命中 quit-app', S.shortcutActionForEvent(ev()) === 'quit-app');

/* ---------- 自定义与冲突 ---------- */
ok('改成 Ctrl+Shift+Q', S.setShortcutBinding('quit-app', 'Ctrl+Shift+Q') === true);
ok('自定义后匹配新键位', S.shortcutActionForEvent(ev({ shiftKey: true })) === 'quit-app');
ok('旧键位不再命中', S.shortcutActionForEvent(ev()) === undefined);
ok('非法键位不写入', S.setShortcutBinding('quit-app', 'Ctrl') === false);
ok('清除绑定', S.setShortcutBinding('quit-app', '') === true);
ok('清除后不命中', S.shortcutActionForEvent(ev()) === undefined);
ok('清除后展示为 —', S.formatChord(S.getShortcutBindings()['quit-app']) === '—');

/* ---------- 持久化 ---------- */
ok('写入 localStorage', storage.get(S.SHORTCUTS_STORAGE_KEY) === JSON.stringify({ 'quit-app': '' }));
S.resetShortcutBindings();
ok('恢复默认', S.getShortcutBindings()['quit-app'] === 'ctrl+q');
ok('默认值已落盘', JSON.parse(storage.get(S.SHORTCUTS_STORAGE_KEY))['quit-app'] === 'ctrl+q');
ok('冲突检测（无误报）', S.findShortcutConflict('ctrl+q', 'quit-app') === undefined);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
