#!/usr/bin/env node
/* 移动外壳逻辑回归（src/responsive.ts + src/mobile/shellModel.ts）：
   零依赖（esbuild 仅作 TS 转译，缺失时 SKIP）。
   覆盖 docs/mobile-adaptation.md 的四条硬约定：
     1. 断点边界：<768 mobile（含 iPad 分屏 320/507）、768~1024 tablet、>1024 desktop；
     2. 首页图标来源：自研 app（srv- 前缀）与磁盘卷才出现，classicy 内置 app / 废纸篓 / hidden 一律排除；
     3. 同名项去重（内置 Finder 与自研 Finder 都叫 Macintosh HD，手机上 app 优先）；
     4. 「无未关闭窗口 = 首页可见」与「返回首页逐个关闭窗口」，以及打开 app 后置顶主窗口。 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// fileURLToPath 而非 new URL().pathname：后者在 Windows 上会保留前导 "/"，
// join 出 "\D:\..." 这种无效路径（同目录其它测试因此在本机一律 SKIP）
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'srv-mobile-shell-'));

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
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/* ---------- 加载被测模块 ----------
   两条链路：① Node 原生 TS 类型剥离（node ≥22.6，本机与 CI 的 Node 22 直接可用）；
   ② 回退 esbuild 转译（与同目录其它 store 测试同一链路）。
   本测试只调用纯函数，不渲染组件，因此不需要 react 订阅桩——responsive.ts 里
   useViewport 之外的副作用都被 `typeof window` 守卫住，在 Node 里是 no-op。 */
async function loadMod() {
  const p = (rel) => pathToFileURL(path.join(ROOT, rel)).href;
  try {
    const [responsive, shell] = await Promise.all([import(p('src/responsive.ts')), import(p('src/mobile/shellModel.ts'))]);
    return { ...responsive, ...shell, via: 'native-type-strip' };
  } catch (nativeErr) {
    const esbuild = await import('esbuild').catch(() => null);
    if (!esbuild) throw new Error(`原生导入失败（${nativeErr.message}），且 esbuild 不可用`);
    const entry = path.join(TMP, 'entry.ts');
    const q = (rel) => JSON.stringify(path.join(ROOT, rel).replace(/\\/g, '/'));
    fs.writeFileSync(entry, `export * from ${q('src/responsive.ts')};\nexport * from ${q('src/mobile/shellModel.ts')};\n`);
    const out = path.join(TMP, 'mobile-shell.mjs');
    await esbuild.build({
      entryPoints: [entry],
      bundle: true,
      format: 'esm',
      platform: 'node',
      outfile: out,
      logLevel: 'silent',
    });
    return { ...(await import(pathToFileURL(out).href)), via: 'esbuild' };
  }
}

let mod;
try {
  mod = await loadMod();
} catch (e) {
  console.log(`SKIP 移动外壳逻辑测试（无法加载 TS 模块：${(e && e.message) || e}）`);
  process.exit(0);
}
console.log(`（加载方式：${mod.via}）\n`);

const {
  layoutForWidth,
  MOBILE_MAX_WIDTH,
  TABLET_MAX_WIDTH,
  homeIcons,
  isHomeVisible,
  closeAllActions,
  primaryWindowId,
  openActionFor,
} = mod;

/* ---------- 1. 断点边界 ---------- */
{
  ok('320（iPhone SE / iPad 分屏最窄）→ mobile', layoutForWidth(320) === 'mobile');
  ok('390（iPhone 14/15）→ mobile', layoutForWidth(390) === 'mobile');
  ok('430（iPhone Pro Max）→ mobile', layoutForWidth(430) === 'mobile');
  ok('507（iPad 1/3 分屏）→ mobile', layoutForWidth(507) === 'mobile');
  ok(`${MOBILE_MAX_WIDTH}（手机上限）→ mobile`, layoutForWidth(MOBILE_MAX_WIDTH) === 'mobile');
  ok('768（iPad 竖屏）→ tablet', layoutForWidth(768) === 'tablet');
  ok('834（iPad Air 横屏）→ tablet', layoutForWidth(834) === 'tablet');
  ok(`${TABLET_MAX_WIDTH}（iPad Pro 横屏）→ tablet`, layoutForWidth(TABLET_MAX_WIDTH) === 'tablet');
  ok('1025 → desktop', layoutForWidth(1025) === 'desktop');
  ok('1440 → desktop', layoutForWidth(1440) === 'desktop');
  ok('非法宽度（0 / NaN）回退 desktop', layoutForWidth(0) === 'desktop' && layoutForWidth(Number.NaN) === 'desktop');
}

/* ---------- 2. 首页图标过滤 ---------- */
{
  const icons = [
    { appId: 'Finder.app', appName: 'Macintosh HD', icon: 'drive.png', kind: 'drive' },
    { appId: 'srv-audit.app', appName: 'Audit Log', icon: 'audit.svg', kind: 'app_shortcut' },
    { appId: 'DriveSetup.app', appName: 'Drive Setup', icon: 'd.svg', kind: 'app_shortcut', hidden: true },
    { appId: 'SoundManager.app', appName: 'Sound Manager', icon: 's.svg', kind: 'app_shortcut' },
    { appId: 'srv-chat.app', appName: 'Chat', icon: 'chat.svg', kind: 'app_shortcut' },
    { appId: 'srv-chat.app', appName: 'Chat', icon: 'chat.svg', kind: 'app_shortcut' },
    { appId: 'Trash', appName: 'Trash', icon: 't.svg', kind: 'trash' },
    { appId: 'srv-old.app', appName: 'Old', icon: 'o.svg', kind: 'app_shortcut', inApplications: false },
    { appId: 'srv-monitor.app', appName: 'WatchDog OS', icon: 'mon.svg', kind: 'app_shortcut' },
  ];
  const entries = homeIcons(icons);
  const labels = entries.map((e) => e.label);
  ok('过滤 classicy 内置 app（Sound Manager）', !labels.includes('Sound Manager'));
  ok('过滤 hidden 项（Drive Setup）', !labels.includes('Drive Setup'));
  ok('过滤废纸篓', !labels.includes('Trash'));
  ok('过滤 inApplications:false', !labels.includes('Old'));
  ok('保留自研 app 与磁盘卷（store 顺序）', labels.join(',') === 'Macintosh HD,Audit Log,Chat,WatchDog OS', labels.join(','));
  ok('同一 app 重复条目只出现一次', labels.filter((l) => l === 'Chat').length === 1);
  ok('条目字段完整', entries.every((e) => e.key && e.label && e.icon && e.action));
  ok('空输入安全', eq(homeIcons(undefined), []) && eq(homeIcons(null), []));
}

/* ---------- 3. 同名项去重：app 优先于磁盘卷 ---------- */
{
  const driveFirst = homeIcons([
    { appId: 'Finder.app', appName: 'Macintosh HD', icon: 'drive.png', kind: 'drive' },
    { appId: 'srv-finder.app', appName: 'Macintosh HD', icon: 'finder.svg', kind: 'app_shortcut' },
  ]);
  ok('同名时保留自研 app（drive 在前）', driveFirst.length === 1 && driveFirst[0].icon === 'finder.svg', JSON.stringify(driveFirst.map((e) => e.icon)));

  const appFirst = homeIcons([
    { appId: 'srv-finder.app', appName: 'Macintosh HD', icon: 'finder.svg', kind: 'app_shortcut' },
    { appId: 'Finder.app', appName: 'Macintosh HD', icon: 'drive.png', kind: 'drive' },
  ]);
  ok('同名时保留自研 app（app 在前）', appFirst.length === 1 && appFirst[0].icon === 'finder.svg');

  const distinctDrives = homeIcons([
    { appId: 'Finder.app', appName: 'C:', icon: 'c.png', kind: 'drive' },
    { appId: 'Finder.app', appName: 'D:', icon: 'd.png', kind: 'drive' },
  ]);
  ok('不同名磁盘各自保留', distinctDrives.length === 2, JSON.stringify(distinctDrives.map((e) => e.label)));
}

/* ---------- 4. 打开动作：图标自带 event 优先 ---------- */
{
  const drive = {
    appId: 'Finder.app',
    appName: 'Macintosh HD',
    icon: 'i',
    kind: 'drive',
    event: 'ClassicyAppFinderOpenFolder',
    eventData: { path: 'Macintosh HD' },
  };
  const action = openActionFor(drive);
  ok(
    '磁盘卷走自带事件',
    action.type === 'event' && action.event === 'ClassicyAppFinderOpenFolder' && action.eventData.path === 'Macintosh HD'
  );

  const app = { appId: 'srv-chat.app', appName: 'Chat', icon: 'chat.svg', kind: 'app_shortcut' };
  const appAction = openActionFor(app);
  ok('app 走 ClassicyAppOpen 数据', appAction.type === 'app' && appAction.app.id === 'srv-chat.app' && appAction.app.name === 'Chat');

  ok('空 event 视为无事件', openActionFor({ ...app, event: '' }).type === 'app');
}

/* ---------- 5. 首页可见性（只看未关闭窗口，不看 focusedAppId） ---------- */
{
  ok('无 app → 首页可见', isHomeVisible({}) === true);
  ok('全部窗口已关闭 → 首页可见', isHomeVisible({ 'srv-chat.app': { windows: [{ closed: true }, { closed: true }] } }) === true);
  ok('存在未关闭窗口 → 首页隐藏', isHomeVisible({ 'srv-chat.app': { windows: [{ closed: true }, { closed: false }] } }) === false);
  ok('空输入安全', isHomeVisible(undefined) === true && isHomeVisible(null) === true);
}

/* ---------- 6. 返回首页：枚举需要关闭的窗口 ---------- */
{
  const apps = {
    'srv-finder.app': {
      windows: [
        { id: 'fm-main', closed: false },
        { id: 'fm-favorites', closed: false },
        { id: 'fm-old', closed: true },
      ],
    },
    'srv-chat.app': { windows: [{ id: 'chat-main', closed: false }] },
    'srv-monitor.app': { windows: [{ id: 'monitor-main', closed: true }] },
  };
  const actions = closeAllActions(apps);
  ok(
    '只枚举未关闭窗口',
    eq(actions, [
      { appId: 'srv-finder.app', windowId: 'fm-main' },
      { appId: 'srv-finder.app', windowId: 'fm-favorites' },
      { appId: 'srv-chat.app', windowId: 'chat-main' },
    ]),
    JSON.stringify(actions)
  );
  ok('空输入安全', eq(closeAllActions(undefined), []));
}

/* ---------- 7. 主窗口（打开 app 后置顶的那个） ---------- */
{
  ok('无 windows → undefined', primaryWindowId({ windows: [] }) === undefined);
  ok('取注册顺序第一个', primaryWindowId({ windows: [{ id: 'fm-main' }, { id: 'fm-favorites' }] }) === 'fm-main');
  ok('default 标记优先', primaryWindowId({ windows: [{ id: 'a' }, { id: 'b', default: true }] }) === 'b');
  ok('跳过无 id 的脏数据', primaryWindowId({ windows: [{}, { id: 'x' }] }) === 'x');
  ok('空输入安全', primaryWindowId(undefined) === undefined);
}

try {
  fs.rmSync(TMP, { recursive: true, force: true });
} catch {
  /* 临时目录清理失败忽略 */
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
