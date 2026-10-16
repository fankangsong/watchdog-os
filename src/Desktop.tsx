import { useCallback, useEffect } from 'react';
import {
  ClassicyAppManagerProvider,
  ClassicyDesktop,
  ClassicyIcons,
  dispatch,
  useAppManager,
} from 'classicy';
import type { ClassicyStore } from 'classicy';
import { logout } from './api';
import { MonitorApp } from './apps/MonitorApp';
import { DockerApp } from './apps/DockerApp';
import { ImcolinApp } from './apps/ImcolinApp';
import { TerminalApp } from './apps/TerminalApp';
import { FinderApp } from './apps/FinderApp';
import { EditorApp } from './apps/EditorApp';
import { RunnerApp } from './apps/RunnerApp';
import { PrinterApp } from './apps/PrinterApp';
import { ChatApp } from './apps/ChatApp';
import { ConverterApp } from './apps/ConverterApp';

const APPLE_MENU_LOGOUT_ID = 'sp-menu-logout';

/**
 * classicy 内置示例应用（Finder.app）的 id。
 *
 * 本项目不渲染它，但 classicy 启动时会自行往桌面塞一个虚拟磁盘图标：
 * `appId: 'Finder.app' / appName: 'Macintosh HD' / kind: 'drive'`
 * （DOM 上是 `#Finder.app.shortcut`），与本项目的文件管理器图标同名并排出现。
 * 注意它**不是**持久化脏数据——当前版本根本不写 localStorage，清缓存后依旧复现，
 * 所以只能在运行时移除，且要订阅 store：子组件的 effect 先于父组件执行，
 * 固定延时的做法会与 classicy 内部的添加时机竞态。
 */
const CLASSICY_SAMPLE_FINDER_ID = 'Finder.app';

/** 移除 classicy 示例 Finder 的桌面图标（订阅式：无论何时被添加都会清掉） */
function RemoveClassicySampleFinderIcon() {
  const hasSampleIcon = useAppManager((s) =>
    s.System.Manager.Desktop.icons.some((i) => i.appId === CLASSICY_SAMPLE_FINDER_ID)
  );
  useEffect(() => {
    if (!hasSampleIcon) return;
    dispatch({ type: 'ClassicyDesktopIconRemove', app: { id: CLASSICY_SAMPLE_FINDER_ID } });
  }, [hasSampleIcon]);
  return null;
}

// Zustand v5 将 setState 等 API 挂在 create 返回的 hook 函数对象上，
// 而 useAppManager() 调用得到的是状态本身；这里显式收敛成所需的写入接口。
type AppleMenuStoreApi = {
  setState: (updater: (state: ClassicyStore) => ClassicyStore | Partial<ClassicyStore>) => void;
};

// 在左上角苹果 LOGO 下拉菜单（系统菜单）中追加「退出登录」
function AppleMenuLogoutItem({ onLogout }: { onLogout: () => void }) {
  const setAppleMenuState = useAppManager as unknown as AppleMenuStoreApi;

  const handleLogout = useCallback(async () => {
    try {
      await logout();
    } catch {
      // 登出接口失败也照常回到登录页（如 token 已过期）
    }
    onLogout();
  }, [onLogout]);

  useEffect(() => {
    setAppleMenuState.setState((s) => {
      if (s.System.Manager.Desktop.systemMenu.some((i) => i.id === APPLE_MENU_LOGOUT_ID)) {
        return s;
      }
      return {
        System: {
          ...s.System,
          Manager: {
            ...s.System.Manager,
            Desktop: {
              ...s.System.Manager.Desktop,
              systemMenu: [
                ...s.System.Manager.Desktop.systemMenu,
                { id: 'spacer' },
                { id: APPLE_MENU_LOGOUT_ID, title: 'Sign Out', onClickFunc: handleLogout },
              ],
            },
          },
        },
      };
    });
  }, [setAppleMenuState, handleLogout]);

  return null;
}

// 桌面：系统监控 / Docker / imcolin.fan / 终端 / Macintosh HD（文件管理器）/ 文本编辑器 / Runner / 打印机 / 聊天 / HEIC 转换器
export function Desktop({ onLogout }: { onLogout: () => void }) {
  return (
    <ClassicyAppManagerProvider
      disableSimpleText
      disablePDFViewer
      disableMoviePlayer
      disablePictureViewer
      disableHyperCard
      disableWebViewer
      defaultMuted
    >
      <ClassicyDesktop startupScreen={false} startupLogo={ClassicyIcons.system.macosSvg}>
        <RemoveClassicySampleFinderIcon />
        <MonitorApp onLogout={onLogout} />
        <DockerApp onLogout={onLogout} />
        <ImcolinApp />
        <TerminalApp onLogout={onLogout} />
        <FinderApp onLogout={onLogout} />
        <EditorApp onLogout={onLogout} />
        <RunnerApp onLogout={onLogout} />
        <PrinterApp onLogout={onLogout} />
        <ChatApp onLogout={onLogout} />
        <ConverterApp onLogout={onLogout} />
      </ClassicyDesktop>
      <AppleMenuLogoutItem onLogout={onLogout} />
    </ClassicyAppManagerProvider>
  );
}
