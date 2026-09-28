// 文件管理器 → 文本编辑器 联动桥：
// 记录待打开路径并打开/聚焦编辑器窗口；窗口内容挂载时消费 pendingPath，
// 若窗口已打开则通过 DOM 事件即时通知加载（两条路径互补，避免竞态）。
import { ClassicyIcons, dispatch } from 'classicy';

export const EDITOR_APP_ID = 'srv-editor.app';
export const EDITOR_APP_NAME = 'Text Editor';
export const EDITOR_ICON = ClassicyIcons.applications.simpletext.app;
export const EDITOR_WIN_ID = 'editor-main';
export const EDITOR_OPEN_EVENT = 'srv-editor:open';

let pendingPath: string | null = null;

/** 取出并清空待打开路径（编辑器窗口内容挂载时调用） */
export function takePendingEditorPath(): string | null {
  const p = pendingPath;
  pendingPath = null;
  return p;
}

/** 从文件管理器等外部打开编辑器指定文件 */
export function openInEditor(path: string) {
  pendingPath = path;
  // 打开（或聚焦）编辑器 App
  dispatch({
    type: 'ClassicyAppOpen',
    app: { id: EDITOR_APP_ID, name: EDITOR_APP_NAME, icon: EDITOR_ICON },
  });
  // 确保编辑器主窗口处于打开状态（窗口已注册则仅重新打开并聚焦）
  dispatch({
    type: 'ClassicyWindowOpen',
    app: { id: EDITOR_APP_ID },
    window: { id: EDITOR_WIN_ID, minimumSize: [520, 380], size: [880, 620], position: [120, 90] },
  });
  // 窗口内容已挂载时立即通知加载；未挂载时由挂载 effect 消费 pendingPath
  window.dispatchEvent(new CustomEvent(EDITOR_OPEN_EVENT, { detail: { path } }));
}
