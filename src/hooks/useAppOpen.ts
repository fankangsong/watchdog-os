import { useAppManager } from 'classicy';

/**
 * 应用是否已启动（进入 classicy 运行列表，直到菜单 Quit）。
 * classicy 关窗不卸载组件，因此轮询/请求必须用此信号门控，
 * 否则桌面一加载（所有 App 组件都被 Desktop 无条件挂载）就会开始请求。
 */
export function useAppOpen(appId: string): boolean {
  return Boolean(useAppManager((s) => s.System.Manager.Applications.apps[appId]?.open));
}
