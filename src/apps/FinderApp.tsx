// Macintosh HD 应用外壳：主浏览窗口 + 收藏夹列表窗口 + 收藏目标文件夹窗口注册表。
// 浏览主体为 FinderBrowser（按 winId + initialPath 多实例，各自独立导航状态）；
// 收藏夹数据经 favoritesStore（服务端 ~/.watchdog-os/data.json 持久化）在各窗口间共享——
// 右键文件夹 Add/Remove from Favorites、工具栏 Favorites 按钮、菜单栏 Favorites 菜单
// 均可打开收藏夹列表窗口；选中/双击条目（或菜单项）在已有主浏览窗口覆盖打开目标目录
// （经 requestMainNavigate 导航桥，不新开窗口）；浏览窗口内 Favorites 菜单直达仍新开
// 文件夹窗口（同路径复用窗口）。
import { useCallback, useMemo, useState } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import {
  ClassicyAlert,
  ClassicyApp,
  ClassicyIcons,
  ClassicyTable,
  ClassicyWindow,
  dispatch,
  useClassicyAboutMenu,
  useClassicyContextualMenu,
} from 'classicy';
import type { ClassicyMenuItem, ClassicyTableColumn } from 'classicy';
import { baseName, FAVORITES_WIN_ID, FinderBrowser, folderWinId, requestMainNavigate, APP_NAME, ICON, MAIN_WIN_ID } from './FinderBrowser';
import { removeFavorites, useFavorites } from '../favoritesStore';

import { quitMenuItem } from '../quitMenuItem';

const APP_ID = 'srv-finder.app';
/** 收藏夹窗口图标（classicy 内建 Favorites 文件夹图标） */
const FAV_ICON = ClassicyIcons.system.folders.favorites;

/** 收藏夹列表行模型（路径 + 展示名） */
interface FavRow {
  path: string;
  name: string;
}

interface FavAlert {
  alertType: 'caution' | 'stop';
  label: string;
  message?: string;
  /** 指定默认按钮 id；有数据丢失风险的确认必须指向安全项（Cancel） */
  defaultButtonId?: string;
  buttons: Array<{ id: string; label: string; role?: 'default' | 'cancel' | 'normal'; onClick?: () => void }>;
}

export function FinderApp({ onLogout }: { onLogout: () => void }) {
  // 已打开的收藏目标文件夹窗口（按路径去重：同路径重复打开仅聚焦既有窗口，不新开）
  const [openFolders, setOpenFolders] = useState<string[]>([]);
  const favorites = useFavorites();
  const [favSelected, setFavSelected] = useState<string | null>(null);
  const [alert, setAlert] = useState<FavAlert | null>(null);
  const { showContextMenu } = useClassicyContextualMenu();
  const { aboutMenuItem, aboutWindow } = useClassicyAboutMenu(APP_ID, APP_NAME, ICON);

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

  /** 收藏夹列表条目覆盖打开：导航已有主浏览窗口到目标目录并置前聚焦，不新开窗口。
   *  主 FinderBrowser 常驻挂载（关窗不卸载），导航桥请求总是可达；
   *  对已有窗口记录 ClassicyWindowOpen 仅置 closed=false，保留用户调整过的几何 */
  const openFolderInMain = useCallback((path: string) => {
    requestMainNavigate(path);
    dispatch({ type: 'ClassicyWindowOpen', app: { id: APP_ID }, window: { id: MAIN_WIN_ID } });
    dispatch({ type: 'ClassicyWindowFocus', app: { id: APP_ID }, window: { id: MAIN_WIN_ID } });
  }, []);

  const closeFavoritesWindow = useCallback(() => {
    dispatch({ type: 'ClassicyWindowClose', app: { id: APP_ID }, window: { id: FAVORITES_WIN_ID } });
  }, []);

  const doRemoveFavorite = useCallback(async (path: string) => {
    try {
      await removeFavorites([path]);
      setFavSelected((s) => (s === path ? null : s));
    } catch (e) {
      setAlert({
        alertType: 'stop',
        label: 'Favorites Update Failed',
        message: (e as Error).message,
        buttons: [{ id: 'ok', label: 'OK', role: 'default' }],
      });
    }
  }, []);

  /** 移出收藏夹确认（破坏性命令以 … 结尾 + 默认按钮为安全项 Cancel） */
  const requestRemoveFavorite = useCallback(
    (path: string) => {
      setAlert({
        alertType: 'caution',
        label: 'Remove from Favorites?',
        message: `“${baseName(path) || path}” will be removed from the favorites list. The folder itself is not affected.`,
        defaultButtonId: 'cancel',
        buttons: [
          { id: 'cancel', label: 'Cancel', role: 'cancel' },
          { id: 'ok', label: 'Remove', role: 'normal', onClick: () => void doRemoveFavorite(path) },
        ],
      });
    },
    [doRemoveFavorite]
  );

  // 收藏夹列表行（名称取 basename，根路径回退全路径）
  const favRows = useMemo<FavRow[]>(
    () => favorites.map((p) => ({ path: p, name: baseName(p) || p })),
    [favorites]
  );

  const favColumns = useMemo<Array<ClassicyTableColumn<FavRow>>>(
    () => [
      {
        id: 'name',
        title: 'Name',
        accessor: (r) => r.name,
        width: 180,
        render: (r) => (
          <span className="sp-fm-fav-name">
            <img src={FAV_ICON} alt="" />
            {r.name}
          </span>
        ),
      },
      {
        id: 'path',
        title: 'Path',
        accessor: (r) => r.path,
        width: 320,
        render: (r) => (
          <span className="sp-fm-fav-path" title={r.path}>
            {r.path}
          </span>
        ),
      },
    ],
    []
  );

  // 右键菜单：作用于选中行（无选中时不弹菜单，仅屏蔽浏览器默认菜单）
  const favMenuItems = useMemo<ClassicyMenuItem[]>(
    () => [
      {
        id: 'fm-fav-cm-open',
        title: 'Open',
        onClickFunc: () => {
          if (favSelected) openFolderInMain(favSelected);
        },
      },
      {
        id: 'fm-fav-cm-remove',
        title: 'Remove from Favorites…',
        onClickFunc: () => {
          if (favSelected) requestRemoveFavorite(favSelected);
        },
      },
    ],
    [favSelected, openFolderInMain, requestRemoveFavorite]
  );

  const handleFavContextMenu = useCallback(
    (e: ReactMouseEvent<HTMLDivElement>) => {
      e.preventDefault();
      if (favSelected) showContextMenu(favMenuItems, [e.clientX, e.clientY]);
    },
    [favSelected, favMenuItems, showContextMenu]
  );

  // 收藏夹窗口聚焦时的菜单栏：File 组与右键菜单两路等价
  const favAppMenu = useMemo<ClassicyMenuItem[]>(
    () => [
      {
        id: 'fm-fav-app',
        title: APP_NAME,
        menuChildren: [aboutMenuItem, { id: 'spacer' }, quitMenuItem(APP_ID, APP_NAME, ICON)],
      },
      {
        id: 'fm-fav-file',
        title: 'File',
        menuChildren: [
          {
            id: 'fm-fav-m-open',
            title: 'Open',
            disabled: !favSelected,
            onClickFunc: () => {
              if (favSelected) openFolderInMain(favSelected);
            },
          },
          {
            id: 'fm-fav-m-remove',
            title: 'Remove from Favorites…',
            disabled: !favSelected,
            onClickFunc: () => {
              if (favSelected) requestRemoveFavorite(favSelected);
            },
          },
          { id: 'spacer' },
          { id: 'fm-fav-m-close', title: 'Close Window', onClickFunc: closeFavoritesWindow },
        ],
      },
    ],
    [aboutMenuItem, favSelected, openFolderInMain, requestRemoveFavorite, closeFavoritesWindow]
  );

  // 选中项可能已被其它窗口移出收藏：表格选中态以当前列表为准，避免悬挂高亮
  const favTableSelected = useMemo(
    () => (favSelected && favorites.includes(favSelected) ? [favSelected] : []),
    [favSelected, favorites]
  );

  return (
    <ClassicyApp id={APP_ID} name={APP_NAME} icon={ICON} defaultWindow={MAIN_WIN_ID}>
      <FinderBrowser winId={MAIN_WIN_ID} onLogout={handleLogout} onOpenFolder={openFolderWindow} />

      {/* 收藏夹列表窗口：常驻渲染树（内容由 favorites store 驱动），Open/Focus 控制显隐；
          选中/双击条目在已有主浏览窗口覆盖打开目标目录 */}
      <ClassicyWindow
        id={FAVORITES_WIN_ID}
        title="Favorites"
        icon={FAV_ICON}
        appId={APP_ID}
        resizable
        closable
        scrollable={false}
        initialSize={[540, 400]}
        initialPosition={['center', 'center']}
        minimumSize={[380, 260]}
        appMenu={favAppMenu}
      >
        {favRows.length === 0 ? (
          <div className="sp-fm-fav-empty">
            No favorites yet.
            <br />
            Right-click a folder and choose “Add to Favorites”.
          </div>
        ) : (
          <div className="sp-fm-fav" onContextMenu={handleFavContextMenu}>
            <ClassicyTable
              columns={favColumns}
              rows={favRows}
              getRowId={(r) => r.path}
              selectionMode="single"
              selected={favTableSelected}
              onSelectionChange={(ids) => setFavSelected(ids[0] ?? null)}
              onActivateRow={(id) => openFolderInMain(id)}
              defaultSort={{ columnId: 'name' }}
            />
          </div>
        )}
      </ClassicyWindow>

      {/* 收藏目标文件夹窗口：双击收藏夹条目 / Favorites 菜单新开；同路径复用同一窗口 */}
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

      {alert && (
        <ClassicyAlert
          appId={APP_ID}
          alertType={alert.alertType}
          label={alert.label}
          message={alert.message}
          defaultButtonId={alert.defaultButtonId}
          buttons={alert.buttons}
          onClose={() => setAlert(null)}
        />
      )}
      {aboutWindow}
    </ClassicyApp>
  );
}
