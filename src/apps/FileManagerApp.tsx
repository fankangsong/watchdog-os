// 文件管理器：左侧收藏夹 + 目录树（懒加载展开），右侧文件列表（名称/大小/修改时间/权限），
// 支持上传（进度/覆盖确认）、新建文件夹、重命名、删除、下载，以及图片/文本/Markdown 预览窗口。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ClassicyAlert,
  ClassicyApp,
  ClassicyButton,
  ClassicyCheckbox,
  ClassicyContextualMenuTarget,
  ClassicyIcons,
  ClassicyInput,
  ClassicyProgressBar,
  ClassicySplitView,
  ClassicyTable,
  ClassicyTree,
  ClassicyWindow,
  dispatch,
} from 'classicy';
import type { ClassicyMenuItem, ClassicyTableColumn, ClassicyTreeNode } from 'classicy';
import {
  fsDelete,
  fsGetFavorites,
  fsList,
  fsMkdir,
  fsRawUrl,
  fsRead,
  fsRename,
  fsSetFavorites,
  fsUpload,
  logout,
  Unauthorized,
} from '../api';
import type { FsEntry } from '../api';
import { fmtBytes } from '../format';
import { openInEditor } from '../editorBridge';
import { CodeEditor } from '../components/CodeEditor';
import { MarkdownPreview } from '../components/MarkdownPreview';

const APP_ID = 'srv-filemanager.app';
const APP_NAME = 'File Manager';
const MAIN_WIN = 'fm-main';
const ICON = ClassicyIcons.system.folders.directory;
const FILE_ICON = ClassicyIcons.system.files.file;
const TEXT_ICON = ClassicyIcons.system.files.fileText;
const IMAGE_ICON = ClassicyIcons.system.files.photo;
const MAX_PREVIEWS = 3;

function iconFor(entry: FsEntry): string {
  if (entry.type === 'dir') return ICON;
  if (entry.previewable === 'image') return IMAGE_ICON;
  if (entry.previewable === 'text' || entry.previewable === 'markdown') return TEXT_ICON;
  return FILE_ICON;
}

/** 预览窗口 id：路径转安全 id */
function winIdFor(p: string): string {
  return 'fm-preview-' + p.replace(/[^a-zA-Z0-9_-]/g, (c) => '_' + c.charCodeAt(0).toString(36));
}

/** 上一级目录；根目录返回 ''（根列表视图） */
function parentPath(p: string): string {
  const norm = p.replace(/[\\/]+$/, '');
  if (!norm) return '';
  const i = Math.max(norm.lastIndexOf('\\'), norm.lastIndexOf('/'));
  if (i < 0) return '';
  if (i === 0) return norm[0] === '/' ? '/' : '';
  if (i === 2 && /^[a-zA-Z]:$/.test(norm.slice(0, 2))) return norm.slice(0, 3);
  return norm.slice(0, i);
}

function joinPath(dir: string, name: string): string {
  const sep = dir.includes('\\') ? '\\' : '/';
  return dir.replace(/[\\/]+$/, '') + sep + name;
}

function baseName(p: string): string {
  const norm = p.replace(/[\\/]+$/, '');
  const i = Math.max(norm.lastIndexOf('\\'), norm.lastIndexOf('/'));
  return i >= 0 ? norm.slice(i + 1) : norm;
}

function fmtDate(ms: number): string {
  const d = new Date(ms);
  if (isNaN(+d)) return '—';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

interface UploadTask {
  key: string;
  name: string;
  loaded: number;
  total: number;
}

interface FmAlert {
  alertType: 'caution' | 'stop';
  label: string;
  message?: string;
  buttons: Array<{ id: string; label: string; role?: 'default' | 'cancel' | 'normal'; onClick?: () => void }>;
}

type FmDialog = { kind: 'mkdir'; value: string } | { kind: 'rename'; value: string; target: FsEntry };

export function FileManagerApp({ onLogout }: { onLogout: () => void }) {
  const [roots, setRoots] = useState<string[]>([]);
  const [favorites, setFavorites] = useState<string[]>([]);
  const [current, setCurrent] = useState('');
  const [entries, setEntries] = useState<FsEntry[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [showHidden, setShowHidden] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [backStack, setBackStack] = useState<string[]>([]);
  const [previews, setPreviews] = useState<FsEntry[]>([]);
  const [uploads, setUploads] = useState<UploadTask[]>([]);
  const [alert, setAlert] = useState<FmAlert | null>(null);
  const [dialog, setDialog] = useState<FmDialog | null>(null);
  const [dialogValue, setDialogValue] = useState('');
  const [treeVersion, setTreeVersion] = useState(0);
  const [pathInput, setPathInput] = useState('');

  const childrenCache = useRef(new Map<string, FsEntry[]>());
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const abortRef = useRef(new Map<string, () => void>());
  const cascadeRef = useRef(0);

  const handleLogout = useCallback(async () => {
    try {
      await logout();
    } catch {
      // 登出接口失败也照常回到登录页（如 token 已过期）
    }
    onLogout();
  }, [onLogout]);

  const stopAlert = useCallback((label: string, message: string) => {
    setAlert({ alertType: 'stop', label, message, buttons: [{ id: 'ok', label: '好', role: 'default' }] });
  }, []);

  const fetchDir = useCallback(
    async (p: string) => {
      setLoading(true);
      setError('');
      try {
        const r = await fsList(p);
        setRoots(r.roots);
        setEntries(r.entries);
        setSelected([]);
        setCurrent(r.path);
        setPathInput(r.path);
        if (r.path) {
          childrenCache.current.set(r.path, r.entries);
          setTreeVersion((v) => v + 1);
        }
      } catch (e) {
        if (e instanceof Unauthorized) return handleLogout();
        setError((e as Error).message);
        setEntries([]);
      } finally {
        setLoading(false);
      }
    },
    [handleLogout]
  );

  const navigate = useCallback(
    (p: string, pushHistory = true) => {
      if (pushHistory) {
        setBackStack((s) => (current && current !== p ? [...s.slice(-30), current] : s));
      }
      void fetchDir(p);
    },
    [fetchDir, current]
  );

  // 目录树懒加载：首次展开时拉取子目录
  const ensureChildren = useCallback(
    async (dir: string) => {
      if (childrenCache.current.has(dir)) return;
      try {
        const r = await fsList(dir);
        childrenCache.current.set(dir, r.entries);
        setTreeVersion((v) => v + 1);
      } catch (e) {
        if (e instanceof Unauthorized) return handleLogout();
        stopAlert('读取目录失败', (e as Error).message);
      }
    },
    [handleLogout, stopAlert]
  );

  const handleToggleNode = useCallback(
    (id: string, open: boolean) => {
      if (open) void ensureChildren(id);
    },
    [ensureChildren]
  );

  // 收藏夹：服务端持久化
  const applyFavorites = useCallback(
    async (next: string[]) => {
      try {
        setFavorites((await fsSetFavorites(next)).favorites);
      } catch (e) {
        if (e instanceof Unauthorized) return handleLogout();
        stopAlert('收藏保存失败', (e as Error).message);
      }
    },
    [handleLogout, stopAlert]
  );

  const toggleFavorite = useCallback(
    (p: string) => {
      const norm = p.replace(/[\\/]+$/, '');
      const has = favorites.some((f) => f.replace(/[\\/]+$/, '') === norm);
      void applyFavorites(has ? favorites.filter((f) => f.replace(/[\\/]+$/, '') !== norm) : [...favorites, p]);
    },
    [favorites, applyFavorites]
  );

  useEffect(() => {
    void (async () => {
      try {
        setFavorites((await fsGetFavorites()).favorites);
      } catch {
        // 收藏读取失败不阻塞主流程
      }
    })();
    void fetchDir('');
  }, [fetchDir]);

  const openEntry = useCallback(
    (entry: FsEntry) => {
      if (entry.type === 'dir') return navigate(entry.path);
      if (entry.previewable === 'none') {
        setAlert({
          alertType: 'caution',
          label: '无法预览',
          message: `“${entry.name}” 不是可预览类型，可下载后打开。`,
          buttons: [{ id: 'ok', label: '好', role: 'default' }],
        });
        return;
      }
      setPreviews((prev) => {
        const next = [...prev.filter((p) => p.path !== entry.path), entry];
        return next.slice(Math.max(0, next.length - MAX_PREVIEWS));
      });
      const off = (cascadeRef.current++ % 6) * 26;
      dispatch({
        type: 'ClassicyWindowOpen',
        app: { id: APP_ID },
        window: {
          id: winIdFor(entry.path),
          minimumSize: [420, 320],
          size: [720, 520],
          position: [120 + off, 80 + off],
        },
      });
    },
    [navigate]
  );

  const downloadEntries = useCallback((list: FsEntry[]) => {
    for (const e of list) {
      if (e.type !== 'file') continue;
      const a = document.createElement('a');
      a.href = fsRawUrl(e.path, true);
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      a.remove();
    }
  }, []);

  const doDelete = useCallback(
    async (list: FsEntry[]) => {
      try {
        for (const e of list) await fsDelete(e.path);
        childrenCache.current.delete(current);
        const del = new Set(list.map((e) => e.path));
        if (favorites.some((f) => del.has(f))) {
          await applyFavorites(favorites.filter((f) => !del.has(f)));
        }
        await fetchDir(current);
      } catch (e) {
        if (e instanceof Unauthorized) return handleLogout();
        stopAlert('删除失败', (e as Error).message);
      }
    },
    [current, favorites, applyFavorites, fetchDir, handleLogout, stopAlert]
  );

  const requestDelete = useCallback(
    (list: FsEntry[]) => {
      if (!list.length) return;
      setAlert({
        alertType: 'caution',
        label: list.length === 1 ? `删除“${list[0].name}”？` : `删除这 ${list.length} 项？`,
        message: `将永久删除 ${list.map((e) => e.name).join('、')}（目录会递归删除），此操作不可撤销。`,
        buttons: [
          { id: 'cancel', label: '取消', role: 'cancel' },
          { id: 'ok', label: '删除', role: 'default', onClick: () => void doDelete(list) },
        ],
      });
    },
    [doDelete]
  );

  const uploadOne = useCallback(
    async (dir: string, file: File, key: string, overwrite: boolean) => {
      setUploads((u) => [...u, { key, name: file.name, loaded: 0, total: file.size }]);
      const { promise, abort } = fsUpload(dir, file, overwrite, (loaded) =>
        setUploads((u) => u.map((x) => (x.key === key ? { ...x, loaded } : x)))
      );
      abortRef.current.set(key, abort);
      try {
        await promise;
      } catch (e) {
        if (e instanceof Unauthorized) return handleLogout();
        const msg = (e as Error).message;
        if (msg === '同名文件已存在') {
          setAlert({
            alertType: 'caution',
            label: '文件已存在',
            message: `“${file.name}” 已存在，是否覆盖？`,
            buttons: [
              { id: 'cancel', label: '取消', role: 'cancel' },
              {
                id: 'ok',
                label: '覆盖',
                role: 'default',
                onClick: () => void uploadOne(dir, file, key, true),
              },
            ],
          });
          return;
        }
        if (msg !== '上传已取消') stopAlert('上传失败', `${file.name}：${msg}`);
      } finally {
        abortRef.current.delete(key);
        setUploads((u) => u.filter((x) => x.key !== key));
      }
    },
    [handleLogout, stopAlert]
  );

  const uploadFiles = useCallback(
    async (files: FileList | File[]) => {
      if (!current) {
        setAlert({
          alertType: 'caution',
          label: '无法上传',
          message: '请先进入一个目录再上传。',
          buttons: [{ id: 'ok', label: '好', role: 'default' }],
        });
        return;
      }
      for (const file of Array.from(files)) {
        await uploadOne(current, file, `${file.name}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, false);
      }
      await fetchDir(current);
    },
    [current, fetchDir, uploadOne]
  );

  const submitDialog = useCallback(async () => {
    if (!dialog) return;
    const name = dialogValue.trim();
    try {
      if (dialog.kind === 'mkdir') {
        if (!name || !current) return;
        await fsMkdir(joinPath(current, name));
      } else if (dialog.kind === 'rename') {
        if (!name) return;
        const target = dialog.target;
        const r = await fsRename(target.path, name);
        if (target.type === 'dir') {
          const next = favorites.map((f) => (f === target.path ? r.path : f));
          if (next.some((f, i) => f !== favorites[i])) await applyFavorites(next);
        }
        childrenCache.current.delete(parentPath(target.path));
      }
      childrenCache.current.delete(current);
      setDialog(null);
      await fetchDir(current);
    } catch (e) {
      if (e instanceof Unauthorized) return handleLogout();
      stopAlert(dialog.kind === 'mkdir' ? '新建文件夹失败' : '重命名失败', (e as Error).message);
    }
  }, [dialog, dialogValue, current, favorites, applyFavorites, fetchDir, handleLogout, stopAlert]);

  const selectedEntries = useMemo(() => entries.filter((e) => selected.includes(e.path)), [entries, selected]);
  const visibleEntries = useMemo(
    () => (showHidden ? entries : entries.filter((e) => !e.name.startsWith('.'))),
    [entries, showHidden]
  );
  const favPaths = useMemo(() => new Set(favorites.map((f) => f.replace(/[\\/]+$/, ''))), [favorites]);

  const goBack = useCallback(() => {
    setBackStack((s) => {
      if (!s.length) return s;
      const prev = s[s.length - 1];
      void fetchDir(prev);
      return s.slice(0, -1);
    });
  }, [fetchDir]);

  const goUp = useCallback(() => {
    navigate(parentPath(current), false);
  }, [navigate, current]);

  const columns: Array<ClassicyTableColumn<FsEntry>> = useMemo(
    () => [
      {
        id: 'name',
        title: '名称',
        accessor: (r) => r.name,
        render: (r) => (
          <span className="sp-fm-name">
            <img src={iconFor(r)} alt="" />
            {r.name}
          </span>
        ),
      },
      {
        id: 'size',
        title: '大小',
        accessor: (r) => (r.type === 'dir' ? -1 : r.size),
        align: 'right',
        render: (r) => (r.type === 'dir' ? '—' : fmtBytes(r.size)),
      },
      {
        id: 'mtime',
        title: '修改时间',
        accessor: (r) => r.mtime,
        render: (r) => (r.mtime ? fmtDate(r.mtime) : '—'),
      },
      { id: 'mode', title: '权限', accessor: (r) => r.mode },
    ],
    []
  );

  // 目录树节点：未加载的目录显示占位节点，展开时懒加载
  const treeNodes: ClassicyTreeNode[] = useMemo(() => {
    const build = (path: string, label: string): ClassicyTreeNode => {
      const kids = childrenCache.current.get(path);
      const childDirs = kids ? kids.filter((e) => e.type === 'dir') : null;
      return {
        id: path,
        label,
        leftIcon: ICON,
        // 分支节点单击即选中并导航（默认 false 是切换展开）
        branchSelectable: true,
        children: childDirs
          ? childDirs.map((d) => build(d.path, d.name))
          : [{ id: `${path}::loading`, label: '加载中…', disabled: true }],
      };
    };
    return roots.map((r) => build(r, r === '/' ? '根目录' : r));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roots, treeVersion]);

  // 右键菜单：有选中项时针对条目操作，否则针对当前目录
  const menuItems: ClassicyMenuItem[] = useMemo(() => {
    const items: ClassicyMenuItem[] = [];
    if (selectedEntries.length > 0) {
      const first = selectedEntries[0];
      items.push({ id: 'fm-cm-open', title: '打开', onClickFunc: () => openEntry(first) });
      if (first.type === 'file' && first.previewable !== 'none') {
        items.push({ id: 'fm-cm-edit', title: '用编辑器打开', onClickFunc: () => openInEditor(first.path) });
      }
      if (first.type === 'file') {
        items.push({ id: 'fm-cm-download', title: '下载', onClickFunc: () => downloadEntries(selectedEntries) });
      }
      if (selectedEntries.length === 1) {
        items.push({
          id: 'fm-cm-rename',
          title: '重命名…',
          onClickFunc: () => {
            setDialogValue(first.name);
            setDialog({ kind: 'rename', value: first.name, target: first });
          },
        });
      }
      items.push({
        id: 'fm-cm-delete',
        title: `删除${selectedEntries.length > 1 ? ` ${selectedEntries.length} 项` : ''}…`,
        onClickFunc: () => requestDelete(selectedEntries),
      });
      if (selectedEntries.length === 1 && first.type === 'dir') {
        const isFav = favPaths.has(first.path.replace(/[\\/]+$/, ''));
        items.push({
          id: 'fm-cm-fav',
          title: isFav ? '从收藏夹移除' : '添加到收藏夹',
          onClickFunc: () => toggleFavorite(first.path),
        });
      }
    } else {
      items.push(
        {
          id: 'fm-cm-newdir',
          title: '新建文件夹…',
          disabled: !current,
          onClickFunc: () => {
            setDialogValue('');
            setDialog({ kind: 'mkdir', value: '' });
          },
        },
        { id: 'fm-cm-upload', title: '上传文件…', disabled: !current, onClickFunc: () => fileInputRef.current?.click() },
        { id: 'fm-cm-refresh', title: '刷新', onClickFunc: () => void fetchDir(current) }
      );
      if (current) {
        const isFav = favPaths.has(current.replace(/[\\/]+$/, ''));
        items.push({
          id: 'fm-cm-favcur',
          title: isFav ? '从收藏夹移除当前目录' : '收藏当前目录',
          onClickFunc: () => toggleFavorite(current),
        });
      }
    }
    return items;
  }, [selectedEntries, current, favPaths, openEntry, downloadEntries, requestDelete, fetchDir, toggleFavorite]);

  const appMenu = useMemo(
    () => [
      {
        id: 'fm-file',
        title: '文件',
        menuChildren: [
          {
            id: 'fm-m-newdir',
            title: '新建文件夹…',
            onClickFunc: () => {
              setDialogValue('');
              setDialog({ kind: 'mkdir', value: '' });
            },
          },
          { id: 'fm-m-upload', title: '上传文件…', onClickFunc: () => fileInputRef.current?.click() },
        ],
      },
      {
        id: 'fm-view',
        title: '显示',
        menuChildren: [
          { id: 'fm-m-hidden', title: '显示隐藏文件', checked: showHidden, onClickFunc: () => setShowHidden((v) => !v) },
          { id: 'fm-m-refresh', title: '刷新', onClickFunc: () => void fetchDir(current) },
        ],
      },
    ],
    [showHidden, current, fetchDir]
  );

  return (
    <ClassicyApp id={APP_ID} name={APP_NAME} icon={ICON} defaultWindow={MAIN_WIN}>
      <ClassicyWindow
        id={MAIN_WIN}
        title={`${APP_NAME}${current ? ' · ' + (baseName(current) || current) : ''}`}
        icon={ICON}
        appId={APP_ID}
        scrollable={false}
        resizable
        zoomable
        collapsable
        closable
        initialSize={[940, 640]}
        initialPosition={['center', 'center']}
        minimumSize={[680, 480]}
        appMenu={appMenu}
      >
        <div className="sp-fm">
          <div className="sp-fm-toolbar">
            <ClassicyButton buttonSize="small" onClickFunc={goBack} disabled={backStack.length === 0}>
              ◀ 后退
            </ClassicyButton>
            <ClassicyButton buttonSize="small" onClickFunc={goUp} disabled={!current}>
              ▲ 上级
            </ClassicyButton>
            <span className="sp-fm-toolbar-divider" aria-hidden="true" />
            <ClassicyButton buttonSize="small" onClickFunc={() => void fetchDir(current)}>
              刷新
            </ClassicyButton>
            <span className="sp-fm-toolbar-divider" aria-hidden="true" />
            <ClassicyButton
              buttonSize="small"
              disabled={!current}
              onClickFunc={() => {
                setDialogValue('');
                setDialog({ kind: 'mkdir', value: '' });
              }}
            >
              新建文件夹
            </ClassicyButton>
            <ClassicyButton buttonSize="small" disabled={!current} onClickFunc={() => fileInputRef.current?.click()}>
              上传
            </ClassicyButton>
            <span className="sp-fm-toolbar-divider" aria-hidden="true" />
            <ClassicyButton buttonSize="small" disabled={!selectedEntries.length} onClickFunc={() => downloadEntries(selectedEntries)}>
              下载
            </ClassicyButton>
            <ClassicyButton buttonSize="small" disabled={!selectedEntries.length} onClickFunc={() => requestDelete(selectedEntries)}>
              删除
            </ClassicyButton>
            <ClassicyButton
              buttonSize="small"
              disabled={selectedEntries.length !== 1}
              onClickFunc={() => {
                const t = selectedEntries[0];
                if (!t) return;
                setDialogValue(t.name);
                setDialog({ kind: 'rename', value: t.name, target: t });
              }}
            >
              重命名
            </ClassicyButton>
            <div className="sp-fm-path">
              <ClassicyInput
                id="fm-path"
                key={current}
                prefillValue={current}
                placeholder="输入路径后回车跳转"
                onChangeFunc={(e) => setPathInput(e.target.value)}
                onEnterFunc={() => {
                  const p = pathInput.trim();
                  if (p) navigate(p);
                }}
              />
            </div>
            <ClassicyCheckbox id="fm-hidden" checked={showHidden} label="隐藏文件" onClickFunc={setShowHidden} />
          </div>

          <ClassicySplitView direction="horizontal" defaultSizes={[26, 74]} minPaneSize={180} className="sp-fm-split">
            <div className="sp-fm-side">
              <div className="sp-fm-side-title">收藏夹</div>
              {favorites.length === 0 ? (
                <div className="sp-fm-empty">右键目录可添加收藏</div>
              ) : (
                favorites.map((f) => (
                  <div key={f} className="sp-fm-fav">
                    <button type="button" className="sp-fm-fav-btn" title={f} onClick={() => navigate(f)}>
                      <img src={ICON} alt="" />
                      <span>{baseName(f) || f}</span>
                    </button>
                    <button type="button" className="sp-fm-fav-del" title="移除收藏" onClick={() => toggleFavorite(f)}>
                      ×
                    </button>
                  </div>
                ))
              )}
              <div className="sp-fm-side-title">目录</div>
              <ClassicyTree
                nodes={treeNodes}
                selectionMode="single"
                selectedIds={current ? [current] : []}
                onSelectNode={(id) => navigate(id)}
                onToggleNode={handleToggleNode}
              />
            </div>

            <ClassicyContextualMenuTarget menuItems={menuItems}>
              <div className="sp-fm-main">
                <div className="sp-fm-table">
                  <ClassicyTable
                    columns={columns}
                    rows={visibleEntries}
                    getRowId={(r) => r.path}
                    selectionMode="multi"
                    selected={selected}
                    onSelectionChange={setSelected}
                    onActivateRow={(_id, row) => openEntry(row)}
                    defaultSort={{ columnId: 'name' }}
                  />
                </div>
                {uploads.length > 0 && (
                  <div className="sp-fm-uploads">
                    {uploads.map((u) => (
                      <div key={u.key} className="sp-fm-upload-row">
                        <span className="sp-fm-upload-name" title={u.name}>
                          {u.name}
                        </span>
                        <span className="sp-fm-upload-bar">
                          <ClassicyProgressBar value={u.loaded} max={u.total || 1} />
                        </span>
                        <span>
                          {fmtBytes(u.loaded)} / {fmtBytes(u.total)}
                        </span>
                        <button type="button" className="sp-fm-fav-del" title="取消上传" onClick={() => abortRef.current.get(u.key)?.()}>
                          ×
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                <div className="sp-fm-status">
                  <span>{loading ? '读取中…' : error ? `错误：${error}` : current || '根目录列表'}</span>
                  <span>
                    {visibleEntries.length} 项 · 已选 {selected.length} 项
                  </span>
                </div>
              </div>
            </ClassicyContextualMenuTarget>
          </ClassicySplitView>
        </div>

        {alert && (
          <ClassicyAlert
            appId={APP_ID}
            alertType={alert.alertType}
            label={alert.label}
            message={alert.message}
            buttons={alert.buttons}
            onClose={() => setAlert(null)}
          />
        )}

        {dialog && (
          <div
            className="sp-dialog-mask"
            onMouseDown={(e) => {
              if (e.target === e.currentTarget) setDialog(null);
            }}
          >
            <div className="sp-dialog">
              <div className="sp-dialog-title">{dialog.kind === 'mkdir' ? '新建文件夹' : '重命名'}</div>
              <div className="sp-dialog-body">
                <ClassicyInput
                  id="fm-dialog-name"
                  key={dialog.kind + dialog.value}
                  prefillValue={dialog.value}
                  labelTitle={dialog.kind === 'mkdir' ? '名称' : '新名称'}
                  labelPosition="left"
                  onChangeFunc={(e) => setDialogValue(e.target.value)}
                  onEnterFunc={() => void submitDialog()}
                />
                <div className="sp-dialog-actions">
                  <ClassicyButton onClickFunc={() => setDialog(null)}>取消</ClassicyButton>
                  <ClassicyButton isDefault onClickFunc={() => void submitDialog()}>
                    {dialog.kind === 'mkdir' ? '创建' : '重命名'}
                  </ClassicyButton>
                </div>
              </div>
            </div>
          </div>
        )}

        <input
          ref={fileInputRef}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            if (e.target.files?.length) void uploadFiles(e.target.files);
            e.target.value = '';
          }}
        />
      </ClassicyWindow>

      {previews.map((pv) => (
        <PreviewWindow
          key={pv.path}
          entry={pv}
          winId={winIdFor(pv.path)}
          onEdit={(e) => openInEditor(e.path)}
          onDownload={() => downloadEntries([pv])}
          onClose={() => setPreviews((p) => p.filter((x) => x.path !== pv.path))}
          onLogout={handleLogout}
        />
      ))}
    </ClassicyApp>
  );
}

/** 预览窗口：图片内联 / Markdown 渲染（可切源码）/ 文本只读高亮 */
function PreviewWindow({
  entry,
  winId,
  onEdit,
  onDownload,
  onClose,
  onLogout,
}: {
  entry: FsEntry;
  winId: string;
  onEdit: (entry: FsEntry) => void;
  onDownload: () => void;
  onClose: () => void;
  onLogout: () => void;
}) {
  const [state, setState] = useState<{ loading: boolean; error: string; content: string }>({
    loading: true,
    error: '',
    content: '',
  });
  const [source, setSource] = useState(false);

  useEffect(() => {
    let alive = true;
    if (entry.previewable === 'image') {
      setState({ loading: false, error: '', content: '' });
      return;
    }
    setState({ loading: true, error: '', content: '' });
    void (async () => {
      try {
        const r = await fsRead(entry.path);
        if (!alive) return;
        if (r.tooLarge) {
          setState({ loading: false, error: `文件过大（${fmtBytes(r.size)}），仅支持预览 2MB 以内文本`, content: '' });
        } else if (r.binary) {
          setState({ loading: false, error: '二进制文件，暂不支持预览，可下载查看', content: '' });
        } else {
          setState({ loading: false, error: '', content: r.content ?? '' });
        }
      } catch (e) {
        if (!alive) return;
        if (e instanceof Unauthorized) return onLogout();
        setState({ loading: false, error: (e as Error).message, content: '' });
      }
    })();
    return () => {
      alive = false;
    };
  }, [entry.path, entry.previewable, onLogout]);

  const isMd = entry.previewable === 'markdown';
  const canEdit = entry.previewable === 'text' || isMd;

  return (
    <ClassicyWindow
      id={winId}
      appId="srv-filemanager.app"
      title={`预览 · ${entry.name}`}
      icon={iconFor(entry)}
      closable
      resizable
      zoomable
      collapsable
      scrollable={false}
      initialSize={[720, 520]}
      initialPosition={['center', 'center']}
      minimumSize={[420, 320]}
      onCloseFunc={onClose}
    >
      <div className="sp-fm-preview">
        <div className="sp-fm-preview-toolbar">
          <span className="sp-dim" title={entry.path}>
            {entry.path}
          </span>
          {isMd && (
            <ClassicyButton buttonSize="small" onClickFunc={() => setSource((v) => !v)}>
              {source ? '渲染视图' : '源码视图'}
            </ClassicyButton>
          )}
          {canEdit && (
            <ClassicyButton buttonSize="small" onClickFunc={() => onEdit(entry)}>
              编辑
            </ClassicyButton>
          )}
          <ClassicyButton buttonSize="small" onClickFunc={onDownload}>
            下载
          </ClassicyButton>
        </div>
        {state.loading ? (
          <div className="sp-fm-preview-body">
            <span className="sp-dim">加载中…</span>
          </div>
        ) : state.error ? (
          <div className="sp-fm-preview-body">
            <span className="sp-pulse">{state.error}</span>
          </div>
        ) : entry.previewable === 'image' ? (
          <div className="sp-fm-preview-body sp-fm-img">
            <img src={fsRawUrl(entry.path)} alt={entry.name} />
          </div>
        ) : isMd && !source ? (
          <div className="sp-fm-preview-body sp-fm-md">
            <MarkdownPreview source={state.content} />
          </div>
        ) : (
          <div className="sp-fm-preview-body sp-fm-code">
            <CodeEditor path={entry.path} value={state.content} readOnly theme="dracula" fontSize={13} />
          </div>
        )}
      </div>
    </ClassicyWindow>
  );
}
