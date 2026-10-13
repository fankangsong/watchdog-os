// 应用菜单通用「退出」项：点击后派发 ClassicyAppClose，
// 从 classicy 运行列表移除该应用并关闭其全部窗口（真正的应用退出）。
import type { ClassicyMenuItem } from 'classicy';

export function quitMenuItem(appId: string, appName: string, icon: string): ClassicyMenuItem {
  return {
    id: `${appId}-m-quit`,
    title: 'Quit',
    event: 'ClassicyAppClose',
    eventData: { app: { id: appId, title: appName, icon } },
  };
}
