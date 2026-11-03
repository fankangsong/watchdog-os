/**
 * 编辑器偏好的纯逻辑：首屏兜底解析、服务端值合并、推送判定。
 *
 * 单独抽出的原因：这三件事决定了「改了 Word Wrap / Show Preview 下次打开还在不在」，
 * 是纯数据变换，最容易写错也最值得单测（GUI 里只能靠反复刷新页面观察）。
 */
import { DEFAULT_EDITOR_FONT, DEFAULT_EDITOR_THEME, EDITOR_FONTS, EDITOR_THEMES } from './editorThemes';
import type { EditorThemeId } from './editorThemes';
import type { EditorServerPrefs } from './api';

export interface EditorPrefs {
  theme: EditorThemeId;
  fontSize: number;
  fontFamily: string;
  wordWrap: boolean;
  showPreview: boolean;
}

export type PrefKey = keyof EditorPrefs;

export const DEFAULT_PREFS: EditorPrefs = {
  theme: DEFAULT_EDITOR_THEME,
  fontSize: 14,
  fontFamily: DEFAULT_EDITOR_FONT,
  wordWrap: false,
  showPreview: false,
};

export const PREF_KEYS: PrefKey[] = ['theme', 'fontSize', 'fontFamily', 'wordWrap', 'showPreview'];

/* 枚举白名单：fontFamily 会进入 CodeMirror 的主题 CSS，服务端存的值也必须按已知栈校验 */
export function pickTheme(v: unknown): EditorThemeId {
  return EDITOR_THEMES.some((t) => t.id === v) ? (v as EditorThemeId) : DEFAULT_PREFS.theme;
}

export function pickFont(v: unknown): string {
  return EDITOR_FONTS.some((f) => f.value === v) ? (v as string) : DEFAULT_PREFS.fontFamily;
}

export function pickSize(v: unknown): number {
  const n = typeof v === 'number' ? v : parseInt(String(v), 10);
  return Number.isInteger(n) && n >= 10 && n <= 24 ? n : DEFAULT_PREFS.fontSize;
}

/** localStorage 首屏兜底：任何损坏 / 缺失都回落到内置默认值（不能抛，否则白屏） */
export function parseStoredPrefs(raw: string | null): EditorPrefs {
  try {
    const j = JSON.parse(raw || '');
    return {
      theme: j.theme === undefined ? DEFAULT_PREFS.theme : pickTheme(j.theme),
      fontSize: j.fontSize === undefined ? DEFAULT_PREFS.fontSize : pickSize(j.fontSize),
      fontFamily: j.fontFamily === undefined ? DEFAULT_PREFS.fontFamily : pickFont(j.fontFamily),
      wordWrap: typeof j.wordWrap === 'boolean' ? j.wordWrap : DEFAULT_PREFS.wordWrap,
      showPreview: typeof j.showPreview === 'boolean' ? j.showPreview : DEFAULT_PREFS.showPreview,
    };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

/**
 * 逐字段合并服务端值：
 *  - mutated 里的字段 = 用户在本会话亲自改过 → 以本地为准（hydration 不能把刚点的开关弹回去）
 *  - 其余字段：服务端有就采用（含非法枚举 → 回退默认），缺键保留本地（升级迁移载体）
 */
export function mergeServerPrefs(
  local: EditorPrefs,
  server: EditorServerPrefs,
  mutated: ReadonlySet<PrefKey>
): EditorPrefs {
  return {
    wordWrap: mutated.has('wordWrap') || typeof server.wordWrap !== 'boolean' ? local.wordWrap : server.wordWrap,
    showPreview:
      mutated.has('showPreview') || typeof server.showPreview !== 'boolean' ? local.showPreview : server.showPreview,
    theme: mutated.has('theme') || server.theme === undefined ? local.theme : pickTheme(server.theme),
    fontSize: mutated.has('fontSize') || server.fontSize === undefined ? local.fontSize : pickSize(server.fontSize),
    fontFamily:
      mutated.has('fontFamily') || server.fontFamily === undefined ? local.fontFamily : pickFont(server.fontFamily),
  };
}

/**
 * 是否需要推送：
 *  - 服务端有该键 → 值不同才推；
 *  - 服务端缺该键 → 只有「非默认值」才推。
 * 后者保证从未动过设置的用户零写盘（不凭空创建 editor 键），同时让老用户
 * localStorage 里的自定义值在首次同步时被上传一次。
 */
export function prefsNeedPush(local: EditorPrefs, server: EditorServerPrefs): boolean {
  return PREF_KEYS.some((k) => {
    const remote = server[k];
    return remote === undefined ? local[k] !== DEFAULT_PREFS[k] : remote !== local[k];
  });
}
