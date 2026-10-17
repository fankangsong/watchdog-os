// Converter（HEIC 转换器）→ Macintosh HD（Finder）选文件联动桥：
// Converter 点击 Select File 进入「选文件模式」并打开/聚焦 Macintosh HD 主窗口；
// 用户在任意浏览窗口双击文件确认选择（Esc 或关闭窗口取消），选择结果经
// window CustomEvent 广播回 Converter，同时关闭 Macintosh HD 主窗口回到 Converter。
// 结构对齐 editorBridge.ts：pending 状态 + 双路径通知（事件即时 / 挂载时读取），
// 避免与 FinderBrowser 相互 import 造成初始化环，Finder 常量在此处独立声明。
import { ClassicyIcons, dispatch } from 'classicy';
import type { FsEntry } from '../api';

/** Finder 应用常量（与 FinderBrowser.tsx 保持一致；独立声明避免 import 环） */
export const FINDER_APP_ID = 'srv-finder.app';
export const FINDER_APP_NAME = 'Macintosh HD';
export const FINDER_ICON = ClassicyIcons.system.drives.disk;
export const FINDER_MAIN_WIN_ID = 'fm-main';

/** 选中结果事件（detail: { entry: FsEntry | null }，null 表示取消） */
export const CONVERTER_PICK_EVENT = 'srv-converter:pick';
/** 选文件模式开关事件（Finder 窗口订阅以切换提示条/双击语义） */
export const CONVERTER_PICKING_EVENT = 'srv-converter:picking';

export interface ConverterPickDetail {
  entry: FsEntry | null;
}

let picking = false;

const pickingListeners = new Set<(v: boolean) => void>();

/** 当前是否处于选文件模式（Converter 调起后、确认/取消前） */
export function isConverterPicking(): boolean {
  return picking;
}

/** 订选文件模式开关；返回退订函数（Finder 窗口挂载时调用） */
export function onConverterPickingChange(fn: (v: boolean) => void): () => void {
  pickingListeners.add(fn);
  return () => pickingListeners.delete(fn);
}

function setPicking(v: boolean) {
  if (picking === v) return;
  picking = v;
  for (const fn of pickingListeners) fn(v);
  window.dispatchEvent(new CustomEvent(CONVERTER_PICKING_EVENT, { detail: { picking: v } }));
}

/** Converter 侧发起：进入选文件模式并打开（或聚焦）Macintosh HD 主窗口 */
export function startConverterPick(): void {
  setPicking(true);
  dispatch({ type: 'ClassicyAppOpen', app: { id: FINDER_APP_ID, name: FINDER_APP_NAME, icon: FINDER_ICON } });
  dispatch({
    type: 'ClassicyWindowOpen',
    app: { id: FINDER_APP_ID },
    window: { id: FINDER_MAIN_WIN_ID, minimumSize: [680, 480], size: [760, 540], position: [140, 90] },
  });
  dispatch({ type: 'ClassicyWindowFocus', app: { id: FINDER_APP_ID }, window: { id: FINDER_MAIN_WIN_ID } });
}

/** Finder 侧确认：回传选中文件并关闭主窗口（回到 Converter） */
export function confirmConverterPick(entry: FsEntry): void {
  if (!picking) return;
  setPicking(false);
  window.dispatchEvent(new CustomEvent(CONVERTER_PICK_EVENT, { detail: { entry } }));
  dispatch({ type: 'ClassicyWindowClose', app: { id: FINDER_APP_ID }, window: { id: FINDER_MAIN_WIN_ID } });
}

/** 取消选文件模式（Esc / 关闭主窗口）：回传 null 并关闭主窗口；幂等 */
export function cancelConverterPick(): void {
  if (!picking) return;
  setPicking(false);
  window.dispatchEvent(new CustomEvent(CONVERTER_PICK_EVENT, { detail: { entry: null } }));
  dispatch({ type: 'ClassicyWindowClose', app: { id: FINDER_APP_ID }, window: { id: FINDER_MAIN_WIN_ID } });
}
