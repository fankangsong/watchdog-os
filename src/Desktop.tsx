import { useCallback, useEffect, useState } from 'react';
import {
  ClassicyAppManagerProvider,
  ClassicyDesktop,
  ClassicyIcons,
  dispatch,
  useAppManager,
} from 'classicy';
import type { ClassicyStore } from 'classicy';
import { logout } from './api';
import { MobileShell } from './mobile/MobileShell';
import { GlobalShortcuts, ShortcutsDialog } from './GlobalShortcuts';
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
import { AuditApp } from './apps/AuditApp';
import { DiskApp } from './apps/DiskApp';

const APPLE_MENU_LOGOUT_ID = 'sp-menu-logout';
const APPLE_MENU_SHORTCUTS_ID = 'sp-menu-shortcuts';

/**
 * classicy 内置示例应用（Finder.app）的 id。
 * 本项目不渲染它，且已停用 hostFsAdapter（内置 Finder 不再读取宿主机文件系统），
 * 但 classicy 启动时会自行往桌面塞一个虚拟磁盘图标
 * （appId: 'Finder.app' / appName: 'Macintosh HD' / kind: 'drive'，DOM 上是 `#Finder.app.shortcut`），
 * 与自研文件管理器图标同名并排出现。它**不是**持久化脏数据——清缓存后依旧复现，
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

// 在左上角苹果 LOGO 下拉菜单（系统菜单）中追加「快捷键设置」与「退出登录」。
// 两项必须由同一个组件重建：systemMenu 会被 classicy 持久化到 localStorage，
// 函数无法序列化；分两个 effect 各自清理/追加会互相覆盖，且刷新后残留空壳项。
function SystemMenuExtras({
  onLogout,
  onOpenShortcuts,
}: {
  onLogout: () => void;
  onOpenShortcuts: () => void;
}) {
  const setAppleMenuState = useAppManager as unknown as AppleMenuStoreApi;

  const handleLogout = useCallback(async () => {
    try {
      await logout();
    } catch {
      // 登出接口失败也照常收尾（如 token 已过期 / 后端不可达）：本地会话必须清干净
    }
    // onLogout = endSession：清本地会话存储 + 整页重载回登录页
    onLogout();
  }, [onLogout]);

  useEffect(() => {
    setAppleMenuState.setState((s) => {
      const menu = s.System.Manager.Desktop.systemMenu;
      // ⚠️ 这里**不能**写成「已存在同 id 项就跳过」：classicy 会把 systemMenu 持久化进
      // localStorage（classicyDesktopState），而函数无法被 JSON 序列化——刷新后残留项只剩
      // { id, title }，点击没有任何处理函数（表现为「点 Sign Out 没反应」）。
      // 因此每次挂载都先剔除旧项（连同尾部的分隔线），再用带 onClickFunc 的新项重建。
      const cleaned = menu.filter((i) => i.id !== APPLE_MENU_LOGOUT_ID && i.id !== APPLE_MENU_SHORTCUTS_ID);
      while (cleaned.length > 0 && cleaned[cleaned.length - 1].id === 'spacer') cleaned.pop();
      return {
        System: {
          ...s.System,
          Manager: {
            ...s.System.Manager,
            Desktop: {
              ...s.System.Manager.Desktop,
              systemMenu: [
                ...cleaned,
                { id: 'spacer' },
                { id: APPLE_MENU_SHORTCUTS_ID, title: 'Keyboard Shortcuts…', onClickFunc: onOpenShortcuts },
                { id: APPLE_MENU_LOGOUT_ID, title: 'Sign Out', onClickFunc: handleLogout },
              ],
            },
          },
        },
      };
    });
  }, [setAppleMenuState, handleLogout, onOpenShortcuts]);

  return null;
}

// 桌面：系统监控 / Docker / imcolin.fan / 终端 / Files（文件管理器）/ 文本编辑器 / Runner / Blog / 打印机 / 聊天 / HEIC 转换器 / 登录审计 / 磁盘容量
export function Desktop({ onLogout }: { onLogout: () => void }) {
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const openShortcuts = useCallback(() => setShortcutsOpen(true), []);
  const closeShortcuts = useCallback(() => setShortcutsOpen(false), []);

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
        <RemoveClassicySampleFinderIcon />
        {/* 全局快捷键（默认 Ctrl+Q 退出当前应用）：挂在 Desktop 根节点，覆盖所有应用窗口 */}
        <GlobalShortcuts />
        {/* 移动外壳：仅在手机断点（<768px）渲染首页网格与「返回首页」悬浮键，
            平板/桌面不渲染任何东西，13 个 app 的注册与窗口行为完全不变 */}
        <MobileShell />
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
        <AuditApp onLogout={onLogout} />
        <DiskApp onLogout={onLogout} />
        {/* 设置面板必须留在 ClassicyDesktop 内部：主题 CSS 变量（--color-system-*）
            由 classicy 以内联样式注入在 .classicyDesktop 上，挂到根节点外侧会全部
            取不到 → 背景/标题条变透明。 */}
        <ShortcutsDialog open={shortcutsOpen} onClose={closeShortcuts} />
      </ClassicyDesktop>
      <SystemMenuExtras onLogout={onLogout} onOpenShortcuts={openShortcuts} />
    </ClassicyAppManagerProvider>
  );
}
