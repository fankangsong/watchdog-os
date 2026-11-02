// Files 应用外壳（原 Macintosh HD）：主浏览窗口 + 收藏目标文件夹窗口注册表。
// 浏览主体为 FinderBrowser（按 winId + initialPath 多实例，各自独立导航状态）；
// 收藏夹数据经 favoritesStore（服务端 ~/.watchdog-os/data.json 持久化）在各实例间共享——
// 收藏夹列表改为主窗口内的可收起侧栏（工具栏 Favorites 按钮 / Favorites 菜单切换显隐，
// 见 FinderBrowser），本组件只负责窗口编排：双击侧栏条目在主窗口内导航，
// Favorites 菜单直达则注册收藏目标文件夹窗口（同路径复用窗口）。
import { useCallback, useState } from 'react';
import { ClassicyApp, dispatch } from 'classicy';
import { FinderBrowser, folderWinId, APP_NAME, ICON, MAIN_WIN_ID } from './FinderBrowser';

const APP_ID = 'srv-finder.app';

export function FinderApp({ onLogout }: { onLogout: () => void }) {
  // 已打开的收藏目标文件夹窗口（按路径去重：同路径重复打开仅聚焦既有窗口，不新开）
  const [openFolders, setOpenFolders] = useState<string[]>([]);

  // 401 只做本地收尾（清会话存储 + 回登录页），**不再**发 /api/logout（见 src/session.ts）
  const handleLogout = useCallback(() => onLogout(), [onLogout]);

  /** 在新窗口打开收藏的文件夹：注册窗口 + Open + Focus（已打开则仅聚焦）。
   *  仅浏览窗口内 Favorites 菜单「直达各收藏」使用 */
  const openFolderWindow = useCallback((path: string) => {
    setOpenFolders((prev) => (prev.includes(path) ? prev : [...prev, path]));
    const winId = folderWinId(path);
    dispatch({
      type: 'ClassicyWindowOpen',
      app: { id: APP_ID },
      window: { id: winId, minimumSize: [680, 480], size: [760, 540], position: [140, 90] },
    });
    dispatch({
      type: 'ClassicyWindowFocus',
      app: { id: APP_ID },
      window: { id: winId },
    });
  }, []);

  return (
    <ClassicyApp id={APP_ID} name={APP_NAME} icon={ICON} defaultWindow={MAIN_WIN_ID}>
      <FinderBrowser winId={MAIN_WIN_ID} onLogout={handleLogout} onOpenFolder={openFolderWindow} />

      {/* 收藏目标文件夹窗口：Favorites 菜单直达新开；同路径复用同一窗口 */}
      {openFolders.map((p) => (
        <FinderBrowser
          key={p}
          winId={folderWinId(p)}
          initialPath={p}
          onLogout={handleLogout}
          onOpenFolder={openFolderWindow}
          onCloseWindow={() => setOpenFolders((prev) => prev.filter((x) => x !== p))}
        />
      ))}
    </ClassicyApp>
  );
}
