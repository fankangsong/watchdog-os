import { useCallback, useEffect } from 'react';
import {
  ClassicyAppManagerProvider,
  ClassicyDesktop,
  ClassicyIcons,
  useAppManager,
} from 'classicy';
import type { ClassicyStore } from 'classicy';
import { logout } from './api';
import { HostFsLazyLoader } from './hostFsAdapter';
import { MonitorApp } from './apps/MonitorApp';
import { DockerApp } from './apps/DockerApp';
import { ImcolinApp } from './apps/ImcolinApp';
import { TerminalApp } from './apps/TerminalApp';
import { FinderApp } from './apps/FinderApp';
import { EditorApp } from './apps/EditorApp';
import { RunnerApp } from './apps/RunnerApp';
import { BlogApp } from './apps/BlogApp';
import { PrinterApp } from './apps/PrinterApp';
import { ChatApp } from './apps/ChatApp';
import { ConverterApp } from './apps/ConverterApp';

const APPLE_MENU_LOGOUT_ID = 'sp-menu-logout';

/**
 * 关于 classicy 内置示例应用 Finder.app（桌面图标「Macintosh HD」，DOM 上是
 * `#Finder.app.shortcut`）：曾计划运行时移除该图标（见 git 历史 RemoveClassicySampleFinderIcon），
 * 但接入 hostFsAdapter 后内置 Finder 已由宿主机真实目录驱动（双击文本文件还会
 * 路由到 EditorApp），与自研 srv-finder.app 并存、各有分工，故图标保留不再清理。
 */

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

// 桌面：系统监控 / Docker / imcolin.fan / 终端 / Macintosh HD（文件管理器）/ 文本编辑器 / Runner / Blog / 打印机 / 聊天 / HEIC 转换器
export function Desktop({ onLogout }: { onLogout: () => void }) {
  return (
    <ClassicyAppManagerProvider
      // disableSimpleText
      // disablePDFViewer
      // disableMoviePlayer
      // disablePictureViewer
      // disableHyperCard
      // disableWebViewer
      // defaultMuted
    >
      <ClassicyDesktop startupScreen={false} startupLogo={ClassicyIcons.system.macosSvg}>
        <HostFsLazyLoader />
        <FinderApp onLogout={onLogout} />
        <MonitorApp onLogout={onLogout} />
        <DockerApp onLogout={onLogout} />
        <ImcolinApp />
        <TerminalApp onLogout={onLogout} />
        <EditorApp onLogout={onLogout} />
        <RunnerApp onLogout={onLogout} />
        <BlogApp onLogout={onLogout} />
        <PrinterApp onLogout={onLogout} />
        <ChatApp onLogout={onLogout} />
        <ConverterApp onLogout={onLogout} />
      </ClassicyDesktop>
      <AppleMenuLogoutItem onLogout={onLogout} />
    </ClassicyAppManagerProvider>
  );
}
