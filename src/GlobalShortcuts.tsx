import { useEffect, useState, useSyncExternalStore } from 'react';
import { ClassicyButton, pickSuccessorApp, useAppManager } from 'classicy';
import type { ClassicyStore, ClassicyStoreSystemApp } from 'classicy';
import {
  SHORTCUT_ACTIONS,
  chordFromEvent,
  chordLabel,
  findShortcutConflict,
  formatChord,
  getShortcutBindings,
  isShortcutCaptureActive,
  resetShortcutBindings,
  setShortcutBinding,
  setShortcutCaptureActive,
  shortcutActionForEvent,
  subscribeShortcuts,
} from './shortcuts';
import type { ShortcutActionId } from './shortcuts';

/** 订阅快捷键绑定（设置面板与全局监听共用） */
function useShortcutBindings() {
  return useSyncExternalStore(subscribeShortcuts, getShortcutBindings, getShortcutBindings);
}

/** 当前有焦点且确实打开的应用；focusedAppId 可能残留在已关闭的 app 上 */
function focusedOpenAppId(state: ClassicyStore): string | undefined {
  const { apps, focusedAppId } = state.System.Manager.Applications;
  if (focusedAppId && apps[focusedAppId]?.open) return focusedAppId;
  return Object.values(apps).find((app) => app.open && app.focused && !app.extension)?.id;
}

/** 应用最前面（或上次访问）的窗口 */
function topWindow(app: ClassicyStoreSystemApp) {
  const open = app.windows.filter((w) => !w.closed);
  if (open.length === 0) return undefined;
  // 与 classicy 的选窗规则一致：优先文档窗，只有全是实用窗时才退而求其次
  const docs = open.filter((w) => w.windowType !== 'utility');
  const pool = docs.length > 0 ? docs : open;
  const last = pool.find((w) => w.id === app.lastAccessedWindowId);
  if (last) return last;
  return pool.reduce((best, win) => ((win.zOrder ?? 0) > (best.zOrder ?? 0) ? win : best), pool[0]);
}

/**
 * 退出当前应用 —— 语义与各 app 菜单里的 Quit（ClassicyAppClose）一致：
 * 关闭该应用全部窗口、取消焦点，并把菜单栏交给最近使用过的下一个应用。
 *
 * 这里直接写 store 而不是派发 ClassicyAppClose：classicy 没有公开的 dispatch
 * 函数，其内部派发器依赖私有克隆辅助函数。因此改为返回新的顶层状态对象，
 * 保证 zustand 能感知变更（直接原地改再返回同一引用会静默不更新）。
 */
export function quitFocusedApp(): void {
  const snapshot = useAppManager.getState();
  const appId = focusedOpenAppId(snapshot);
  if (!appId) return;
  const target = snapshot.System.Manager.Applications.apps[appId];
  if (!target?.open) return;

  const successorId = pickSuccessorApp(snapshot, appId);

  useAppManager.setState((state) => {
    const current = state.System.Manager.Applications;
    const app = current.apps[appId];
    if (!app?.open) return state;

    const nextApps: Record<string, ClassicyStoreSystemApp> = { ...current.apps };
    nextApps[appId] = {
      ...app,
      open: false,
      focused: false,
      windows: app.windows.map((w) => (w.closed && !w.focused ? w : { ...w, closed: true, focused: false })),
    };

    // 先清掉其它应用/窗口上的焦点标记，再单独点亮继任者
    for (const [id, other] of Object.entries(nextApps)) {
      if (id === appId) continue;
      const hasFocusedWindow = other.windows.some((w) => w.focused);
      if (other.focused || hasFocusedWindow) {
        nextApps[id] = {
          ...other,
          focused: false,
          windows: hasFocusedWindow
            ? other.windows.map((w) => (w.focused ? { ...w, focused: false } : w))
            : other.windows,
        };
      }
    }

    let nextFocusedId: string | undefined;
    let nextMenuBar: ClassicyStore['System']['Manager']['Desktop']['appMenu'] | undefined;
    const focusApp = (id: string) => {
      const appToFocus = nextApps[id];
      if (!appToFocus?.open) return;
      const win = topWindow(appToFocus);
      if (win?.menuBar) nextMenuBar = win.menuBar;
      nextApps[id] = {
        ...appToFocus,
        focused: true,
        lastFocusedAt: Date.now(),
        ...(win
          ? {
              lastAccessedWindowId: win.id,
              windows: appToFocus.windows.map((w) =>
                w.id === win.id ? { ...w, focused: true, zOrder: Date.now() } : w
              ),
            }
          : {}),
      };
      nextFocusedId = id;
    };

    if (successorId) focusApp(successorId);
    // 没有可聚焦的继任者时让菜单栏清空即可；不再兜底聚焦已移除的内置 Finder.app

    return {
      ...state,
      System: {
        ...state.System,
        Manager: {
          ...state.System.Manager,
          // 菜单栏读的是 Desktop.appMenu：不换掉会继续显示刚退出的应用的菜单
          Desktop: { ...state.System.Manager.Desktop, appMenu: nextMenuBar ?? [] },
          Applications: {
            ...current,
            apps: nextApps,
            focusedAppId: nextFocusedId,
          },
        },
      },
    };
  });
}

/**
 * 全局快捷键监听：挂在 Desktop 根节点，一次注册覆盖所有窗口与应用。
 * 读取 store 用 getState()（事件发生时的最新值），监听器只在绑定变化时重装。
 */
export function GlobalShortcuts() {
  const bindings = useShortcutBindings();

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // 设置面板正在录制 / 已被其它组件处理（如输入框、菜单快捷键）时不抢
      if (e.repeat || e.defaultPrevented || isShortcutCaptureActive()) return;
      const action = shortcutActionForEvent(e);
      if (!action) return;

      e.preventDefault();
      e.stopPropagation();
      if (action === 'quit-app') quitFocusedApp();
    };

    // capture：先于 classicy 菜单快捷键与 xterm 等窗口内处理器，保证「所有应用」都能退出
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [bindings]);

  return null;
}

/**
 * 快捷键设置面板。
 *
 * 录制逻辑：点「修改」后由窗口 capture 阶段接管键盘，阻止事件继续传播到
 * 全局监听器（否则刚按 Ctrl+Q 就会把当前应用退掉）；Esc 取消，Backspace /
 * Delete 清除绑定。保存即生效并写入 localStorage。
 */
export function ShortcutsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const bindings = useShortcutBindings();
  const [recording, setRecording] = useState<ShortcutActionId | null>(null);
  const [error, setError] = useState('');

  // 录制期间接管键盘；capture + stopPropagation 保证全局监听和 classicy 菜单快捷键都收不到
  useEffect(() => {
    if (!recording) {
      setShortcutCaptureActive(false);
      return;
    }
    setShortcutCaptureActive(true);
    const onKeyDown = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();

      if (e.key === 'Escape') {
        setRecording(null);
        return;
      }
      if (e.key === 'Backspace' || e.key === 'Delete') {
        setShortcutBinding(recording, '');
        setError('');
        setRecording(null);
        return;
      }

      const chord = chordFromEvent(e);
      if (!chord) return; // 只按了修饰键，继续等主键

      const conflict = findShortcutConflict(chord, recording);
      if (conflict) {
        const name = SHORTCUT_ACTIONS.find((a) => a.id === conflict)?.label ?? conflict;
        setError(`「${formatChord(chord)}」已被「${name}」占用，请换一个组合`);
        return;
      }

      setShortcutBinding(recording, chord);
      setError('');
      setRecording(null);
    };

    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      setShortcutCaptureActive(false);
    };
  }, [recording]);

  // 非录制状态下 Esc 关闭面板
  useEffect(() => {
    if (!open || recording) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, recording, onClose]);

  if (!open) return null;

  return (
    <div
      className="sp-dialog-mask sp-shortcuts-mask"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="sp-dialog sp-shortcuts-dialog" role="dialog" aria-modal="true" aria-label="快捷键设置">
        <div className="sp-dialog-title">Keyboard Shortcuts</div>
        <div className="sp-dialog-body">
          <div className="sp-shortcuts-desc">
            快捷键对所有应用窗口生效。点键位按钮后按下新的组合，Esc 取消，Backspace 清除。
          </div>

          <div className="sp-shortcuts-list">
            {SHORTCUT_ACTIONS.map((action) => (
              <div className="sp-shortcuts-row" key={action.id}>
                <div className="sp-shortcuts-info">
                  <div className="sp-shortcuts-name">{action.label}</div>
                  <div className="sp-shortcuts-action-desc">{action.description}</div>
                </div>
                <button
                  type="button"
                  className={`sp-shortcuts-key${recording === action.id ? ' is-recording' : ''}`}
                  aria-label={`修改${action.label}快捷键，当前 ${chordLabel(bindings[action.id])}`}
                  onClick={() => {
                    setError('');
                    setRecording(action.id);
                  }}
                >
                  {recording === action.id ? '按下按键…' : formatChord(bindings[action.id])}
                </button>
                <ClassicyButton
                  buttonSize="small"
                  disabled={!bindings[action.id]}
                  onClickFunc={() => setShortcutBinding(action.id, '')}
                >
                  清除
                </ClassicyButton>
              </div>
            ))}
          </div>

          {error ? <div className="sp-shortcuts-error">{error}</div> : null}

          <div className="sp-dialog-note">设置保存在当前浏览器（localStorage），退出登录后仍然保留。</div>

          <div className="sp-dialog-actions">
            <ClassicyButton
              buttonSize="small"
              onClickFunc={() => {
                resetShortcutBindings();
                setError('');
                setRecording(null);
              }}
            >
              恢复默认
            </ClassicyButton>
            <ClassicyButton buttonSize="small" isDefault onClickFunc={onClose}>
              好
            </ClassicyButton>
          </div>
        </div>
      </div>
    </div>
  );
}
