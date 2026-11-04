/**
 * 全局快捷键：动作表 + 可自定义键位 + localStorage 持久化。
 *
 * 设计要点：
 *   1. 动作表 SHORTCUT_ACTIONS 是唯一事实来源；新增系统级动作只需追加一项并
 *      在 GlobalShortcuts 的执行分支里补上处理。设置面板自动渲染所有动作。
 *   2. 键位用规范串（"ctrl+q"）保存：修饰键顺序固定、字母统一小写，避免
 *      "Ctrl+Q" / "q+ctrl" 这类写法在比较时被当成两个快捷键。
 *   3. 空串表示「未绑定」；清除绑定后动作仍留在面板里，便于重新设置。
 *   4. 存储损坏 / 浏览器禁用 localStorage 时逐字段回落到默认值，绝不抛错
 *      （白屏代价远高于丢一次自定义键位）。
 */

/** 可绑定快捷键的系统级动作 */
export type ShortcutActionId = 'quit-app';

export interface ShortcutAction {
  id: ShortcutActionId;
  /** 设置面板中的动作名称 */
  label: string;
  /** 一句话说明动作做什么 */
  description: string;
  /** 默认键位（规范串） */
  defaultChord: string;
}

/** 默认 Ctrl+Q 退出当前应用 —— 与 macOS 的 Quit 习惯一致，也避开浏览器的 Ctrl+W/T/N */
export const SHORTCUT_ACTIONS: readonly ShortcutAction[] = [
  {
    id: 'quit-app',
    label: '退出当前应用',
    description: '关闭最前面应用的全部窗口',
    defaultChord: 'ctrl+q',
  },
];

export type ShortcutBindings = Record<ShortcutActionId, string>;

export const SHORTCUTS_STORAGE_KEY = 'srv-keyboard-shortcuts';

interface ParsedChord {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
  key: string;
}

/** 事件对象中真正需要的字段（测试可直接传普通对象） */
export type ChordEvent = Pick<
  KeyboardEvent,
  'key' | 'code' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey'
>;

const MODIFIER_KEYS = new Set(['Control', 'Alt', 'Shift', 'Meta', 'OS', 'Super', 'Hyper']);

/** 修饰键的规范顺序（也是展示顺序） */
const MODIFIER_ORDER = ['ctrl', 'alt', 'shift', 'meta'] as const;

/** 解析键位串；修饰键别名归一，含多个主键 / 只有修饰键时返回 null */
export function parseChord(raw: string | null | undefined): ParsedChord | null {
  if (!raw) return null;
  const parts = raw
    .trim()
    .toLowerCase()
    .split('+')
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) return null;

  const mods = { ctrl: false, alt: false, shift: false, meta: false };
  let key = '';
  for (const part of parts) {
    if (part === 'ctrl' || part === 'control') mods.ctrl = true;
    else if (part === 'alt' || part === 'option') mods.alt = true;
    else if (part === 'shift') mods.shift = true;
    else if (part === 'meta' || part === 'cmd' || part === 'command' || part === 'super') mods.meta = true;
    else if (!key) key = part;
    else return null; // 一个快捷键只能有一个主键
  }
  if (!key || MODIFIER_KEYS.has(key)) return null;
  return { ...mods, key };
}

/** 归一为规范串；非法键位返回 null */
export function canonicalChord(raw: string | null | undefined): string | null {
  const parsed = parseChord(raw);
  if (!parsed) return null;
  const parts: string[] = [];
  for (const mod of MODIFIER_ORDER) if (parsed[mod]) parts.push(mod);
  parts.push(parsed.key);
  return parts.join('+');
}

/**
 * 从键盘事件取主键。字母/数字优先用物理键位（e.code），这样中文、俄文等
 * 非拉丁布局下 Ctrl+Q 仍落在 Q 键上；其余键（F1、方向键、标点）用 e.key。
 */
export function keyFromEvent(e: ChordEvent): string | null {
  if (MODIFIER_KEYS.has(e.key)) return null;
  if (e.key === 'Dead' || e.key === 'Unidentified' || e.key === 'Process') return null;

  // 单字符但非 ASCII（中文/俄文/希腊文等布局）也按物理键位归一
  const isAsciiChar = e.key.length === 1 && /^[a-z0-9]$/i.test(e.key);
  if (!isAsciiChar) {
    if (e.code?.startsWith('Key')) return e.code.slice(3).toLowerCase();
    if (e.code?.startsWith('Digit')) return e.code.slice(5);
  }
  if (e.key === ' ') return 'space';
  return e.key.toLowerCase();
}

/** 键盘事件 → 规范键位串；必须带至少一个修饰键，否则返回 null（避免劫持普通输入） */
export function chordFromEvent(e: ChordEvent): string | null {
  const key = keyFromEvent(e);
  if (!key) return null;

  const parts: string[] = [];
  if (e.ctrlKey) parts.push('ctrl');
  if (e.altKey) parts.push('alt');
  if (e.shiftKey) parts.push('shift');
  if (e.metaKey) parts.push('meta');
  if (parts.length === 0) return null;
  parts.push(key);
  return canonicalChord(parts.join('+'));
}

/** 事件是否精确匹配某个键位（修饰键必须完全一致，不能多也不能少） */
export function matchesChord(e: ChordEvent, chord: string | null | undefined): boolean {
  const parsed = parseChord(chord);
  if (!parsed) return false;
  return (
    e.ctrlKey === parsed.ctrl &&
    e.altKey === parsed.alt &&
    e.shiftKey === parsed.shift &&
    e.metaKey === parsed.meta &&
    keyFromEvent(e) === parsed.key
  );
}

/** macOS 风格的按键字形（⌃⌥⇧⌘），设置面板和菜单提示共用 */
export function formatChord(chord: string | null | undefined): string {
  const parsed = parseChord(chord);
  if (!parsed) return '—';
  const glyphs: Record<(typeof MODIFIER_ORDER)[number], string> = {
    ctrl: '⌃',
    alt: '⌥',
    shift: '⇧',
    meta: '⌘',
  };
  let out = '';
  for (const mod of MODIFIER_ORDER) if (parsed[mod]) out += glyphs[mod];
  return out + parsed.key.toUpperCase();
}

/** 可读文本（用于 aria-label / title，浏览器支持不佳时也能表达清楚） */
export function chordLabel(chord: string | null | undefined): string {
  const parsed = parseChord(chord);
  if (!parsed) return '未设置';
  const names: Record<(typeof MODIFIER_ORDER)[number], string> = {
    ctrl: 'Ctrl',
    alt: 'Alt',
    shift: 'Shift',
    meta: 'Meta',
  };
  const parts: string[] = [];
  for (const mod of MODIFIER_ORDER) if (parsed[mod]) parts.push(names[mod]);
  parts.push(parsed.key.toUpperCase());
  return parts.join('+');
}

function defaultBindings(): ShortcutBindings {
  const out = {} as ShortcutBindings;
  for (const action of SHORTCUT_ACTIONS) {
    out[action.id] = canonicalChord(action.defaultChord) ?? '';
  }
  return out;
}

function readBindings(): ShortcutBindings {
  const out = defaultBindings();
  // 无浏览器环境（单元测试 / SSR）直接用默认值
  if (typeof window === 'undefined') return out;

  try {
    const raw = window.localStorage.getItem(SHORTCUTS_STORAGE_KEY);
    if (!raw) return out;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return out;

    for (const action of SHORTCUT_ACTIONS) {
      const value = (parsed as Record<string, unknown>)[action.id];
      if (typeof value !== 'string') continue;
      if (value === '') {
        out[action.id] = '';
        continue;
      }
      const canonical = canonicalChord(value);
      if (canonical) out[action.id] = canonical;
    }
  } catch (err) {
    console.warn('[shortcuts] load failed; keeping defaults', err);
  }
  return out;
}

let bindings: ShortcutBindings = readBindings();
const listeners = new Set<() => void>();

function emit(): void {
  for (const fn of listeners) fn();
}

export function getShortcutBindings(): ShortcutBindings {
  return bindings;
}

export function subscribeShortcuts(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function persist(next: ShortcutBindings): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(SHORTCUTS_STORAGE_KEY, JSON.stringify(next));
  } catch (err) {
    // 隐私模式 / 配额满：内存中仍然生效，只是下次刷新会回到旧值
    console.warn('[shortcuts] save failed', err);
  }
}

/** 更新某个动作的键位；'' 表示清除绑定。非法键位返回 false（不写盘） */
export function setShortcutBinding(action: ShortcutActionId, chord: string): boolean {
  const canonical = chord === '' ? '' : canonicalChord(chord);
  if (canonical === null) return false;
  if (bindings[action] === canonical) return true;

  bindings = { ...bindings, [action]: canonical };
  persist(bindings);
  emit();
  return true;
}

/** 恢复单个动作的默认键位 */
export function resetShortcutBinding(action: ShortcutActionId): void {
  const actionDef = SHORTCUT_ACTIONS.find((a) => a.id === action);
  if (!actionDef) return;
  setShortcutBinding(action, actionDef.defaultChord);
}

/** 恢复全部默认键位 */
export function resetShortcutBindings(): void {
  const next = defaultBindings();
  bindings = next;
  persist(next);
  emit();
}

/** 找出冲突的动作（同一键位只能绑定一个动作）；except 用于编辑时排除自身 */
export function findShortcutConflict(
  chord: string,
  except?: ShortcutActionId
): ShortcutActionId | undefined {
  const canonical = canonicalChord(chord);
  if (!canonical) return undefined;
  return SHORTCUT_ACTIONS.find(
    (action) => action.id !== except && bindings[action.id] === canonical
  )?.id;
}

/** 当前事件命中的动作；未绑定 / 不匹配返回 undefined */
export function shortcutActionForEvent(e: ChordEvent): ShortcutActionId | undefined {
  for (const action of SHORTCUT_ACTIONS) {
    const chord = bindings[action.id];
    if (chord && matchesChord(e, chord)) return action.id;
  }
  return undefined;
}

/* ------------------------------------------------------------------ */
/* 录制状态：设置面板录制时全局监听器必须让路，否则刚按下的键会直接触发动作 */
/* ------------------------------------------------------------------ */

let capturing = false;

export function setShortcutCaptureActive(active: boolean): void {
  capturing = active;
}

export function isShortcutCaptureActive(): boolean {
  return capturing;
}
