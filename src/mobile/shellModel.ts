/**
 * 移动外壳的纯逻辑（无 React 依赖，便于 test/test-mobile-shell.mjs 直接断言）。
 *
 * 移动端不改造 classicy 的桌面图标（它是 #classicyDesktop 的直接子元素、靠内联
 * top/left 绝对定位，无法用 CSS 网格化），而是读同一份 store 数据重排成首页网格：
 * 图标顺序、名称、打开动作全部沿用桌面图标自带的数据，因此新增 app 无需改这里。
 */

/** classicy `System.Manager.Desktop.icons` 的元素（仅取本模型用到的字段） */
export interface WdDesktopIcon {
  appId: string;
  appName: string;
  icon: string;
  label?: string;
  kind: string;
  /** 图标自带的打开事件（如磁盘卷的 ClassicyAppFinderOpenFolder），优先于 ClassicyAppOpen */
  event?: string;
  eventData?: Record<string, unknown>;
  hidden?: boolean;
  /** false 表示明确排除在 Applications 之外（ClassicyDesktopManager 的既有语义） */
  inApplications?: boolean;
}

/** 打开动作：要么派发图标自带事件，要么走 ClassicyAppOpen 打开 app 的默认窗口 */
export type HomeOpenAction =
  | { type: 'event'; event: string; eventData: Record<string, unknown> }
  | { type: 'app'; app: { id: string; name: string; icon: string } };

export interface HomeEntry {
  /** React key：app 用 appId，磁盘卷用 `appId:卷名`（同名盘才可能重复） */
  key: string;
  label: string;
  icon: string;
  action: HomeOpenAction;
}

/** 自研 app 的 id 一律以 srv- 开头（见 src/apps/*.tsx 的 APP_ID），用于把 classicy 内置 app 挡在首页外 */
export const APP_ID_PREFIX = 'srv-';

/** 磁盘卷图标的 kind（Macintosh HD 等，由 Finder 依据 FS 根目录生成） */
export const DRIVE_KIND = 'drive';
/** 废纸篓不上手机首页：手机上无法把文件拖进废纸篓 */
export const TRASH_KIND = 'trash';

function isHomeIcon(icon: WdDesktopIcon): boolean {
  if (!icon || typeof icon.appId !== 'string') return false;
  if (icon.hidden) return false;
  if (icon.inApplications === false) return false;
  if (icon.kind === TRASH_KIND) return false;
  // 自研 app 与磁盘卷；classicy 内置的 Sound Manager / Date & Time / 示例 app 等一律不出现
  return icon.appId.startsWith(APP_ID_PREFIX) || icon.kind === DRIVE_KIND;
}

/** 打开动作：图标带 event 就照抄（eventData 可缺省），否则打开对应 app */
export function openActionFor(icon: WdDesktopIcon): HomeOpenAction {
  if (typeof icon.event === 'string' && icon.event.length > 0) {
    return { type: 'event', event: icon.event, eventData: icon.eventData ?? {} };
  }
  return { type: 'app', app: { id: icon.appId, name: icon.appName, icon: icon.icon } };
}

/**
 * 桌面图标数据 → 首页网格条目（保持 store 顺序，与桌面上的排列一致）。
 *
 * 按**显示名**去重：磁盘卷与自研文件管理器都叫 "Macintosh HD"（`srv-finder.app` 的
 * APP_NAME 就是 Macintosh HD，桌面端同名并存是预期行为——靠位置区分）。手机首页是
 * 网格、没有位置线索，两个同名图标只会让人点错，因此同名只留一个，且**优先自研 app**
 * （磁盘卷背后是深度受限的内置 Finder 门面，自研文件管理器功能完整）。
 * 不同名的磁盘（如 C: / D:）不受影响，仍会各自出现。
 */
export function homeIcons(icons: readonly WdDesktopIcon[] | undefined | null): HomeEntry[] {
  if (!Array.isArray(icons)) return [];
  // Map 保序：同名项被替换时位置不变，首页顺序仍与 store 一致
  const byLabel = new Map<string, { entry: HomeEntry; isApp: boolean }>();

  for (const icon of icons) {
    if (!isHomeIcon(icon)) continue;
    const isApp = icon.kind !== DRIVE_KIND;
    const key = isApp ? icon.appId : `${icon.appId}:${icon.appName}`;
    const label = icon.label ?? icon.appName;
    const prev = byLabel.get(label);
    // 已有同名项：app 优先保留；已保留的是 app（或被保留项本身是 app）时跳过当前项
    if (prev && (prev.isApp || !isApp)) continue;
    byLabel.set(label, {
      entry: { key, label, icon: icon.icon, action: openActionFor(icon) },
      isApp,
    });
  }

  return Array.from(byLabel.values(), (v) => v.entry);
}

interface AppLike {
  windows?: readonly { closed?: boolean }[];
}

interface WindowLike {
  id?: string;
  closed?: boolean;
  default?: boolean;
}

/**
 * app 的主窗口 id（打开 app 后应置顶的那个）。
 *
 * 为什么需要：classicy 的 `ClassicyAppOpen` 会把该 app **所有已注册窗口**的 `closed`
 * 置 false 并逐个聚焦，最后聚焦的那个胜出。srv-finder 的收藏夹窗口是常驻渲染树
 * （见 FinderApp 注释），于是「从首页点 Macintosh HD」会以 Favorites 空窗口盖住主浏览
 * 窗口。这里取注册顺序上的第一个窗口（各 app 都是主窗口先挂载）作为主窗口，
 * 缺 `default` 标记时的兜底顺序也一致。
 */
export function primaryWindowId(app: { windows?: readonly WindowLike[] } | undefined): string | undefined {
  const windows = (app?.windows ?? []).filter(
    (w): w is WindowLike & { id: string } => !!w && typeof w.id === 'string'
  );
  const picked = windows.find((w) => w.default === true) ?? windows[0];
  return picked?.id;
}

/**
 * 首页可见 = 没有任何未关闭窗口。
 * 刻意不读 `focusedAppId`：返回首页后它可能仍指向上一个 app（classicy 不会清空），
 * 以它为判据会导致首页永远不出现。
 */
export function isHomeVisible(apps: Record<string, AppLike> | undefined | null): boolean {
  if (!apps) return true;
  for (const app of Object.values(apps)) {
    const windows = app?.windows ?? [];
    if (windows.some((w) => w && !w.closed)) return false;
  }
  return true;
}

export interface CloseAction {
  appId: string;
  windowId: string;
}

/** 返回首页：枚举所有未关闭窗口，供逐个 dispatch ClassicyWindowClose（幂等） */
export function closeAllActions(apps: Record<string, AppLike & { windows?: readonly { id?: string; closed?: boolean }[] }> | undefined | null): CloseAction[] {
  if (!apps) return [];
  const out: CloseAction[] = [];
  for (const [appId, app] of Object.entries(apps)) {
    for (const w of app?.windows ?? []) {
      if (!w || w.closed || typeof w.id !== 'string') continue;
      out.push({ appId, windowId: w.id });
    }
  }
  return out;
}
