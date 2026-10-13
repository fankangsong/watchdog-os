import { useCallback, useEffect } from 'react';
import {
  ClassicyAppManagerProvider,
  ClassicyDesktop,
  ClassicyIcons,
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

const APPLE_MENU_LOGOUT_ID = 'sp-menu-logout';

// 一次性迁移：classicy 把桌面状态持久化在 localStorage 的 classicyDesktopState，
// 应用更名（FileManager → Finder）后旧 id `srv-filemanager.app` 的注册条目仍留在快照里，
// 会在桌面持续渲染旧「File Manager」图标。这里在桌面启动前把残留条目清掉。
try {
  const raw = localStorage.getItem('classicyDesktopState');
  if (raw) {
    const state = JSON.parse(raw);
    const apps = state?.System?.Manager?.Applications?.apps;
    if (apps && 'srv-filemanager.app' in apps) {
      delete apps['srv-filemanager.app'];
      localStorage.setItem('classicyDesktopState', JSON.stringify(state));
    }
  }
} catch {
  // 解析失败不影响启动（classicy 自身会因 schema 校验失败回退默认状态）
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

// 桌面：系统监控 / Docker / imcolin.fan / 终端 / Finder / 文本编辑器 / Runner / 打印机 / 聊天
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
        <MonitorApp onLogout={onLogout} />
        <DockerApp onLogout={onLogout} />
        <ImcolinApp onLogout={onLogout} />
        <TerminalApp onLogout={onLogout} />
        <FinderApp onLogout={onLogout} />
        <EditorApp onLogout={onLogout} />
        <RunnerApp onLogout={onLogout} />
        <PrinterApp onLogout={onLogout} />
        <ChatApp onLogout={onLogout} />
      </ClassicyDesktop>
      <AppleMenuLogoutItem onLogout={onLogout} />
    </ClassicyAppManagerProvider>
  );
}
