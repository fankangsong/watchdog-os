// Finder（文件管理器）：左侧收藏夹 + 目录树（懒加载展开），右侧文件列表（名称/大小/修改时间/权限），
// 支持上传（进度/覆盖确认）、新建文件夹、新建文本文件、重命名（可改扩展名）、删除、下载，
// 以及图片/文本/Markdown 预览窗口。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ClassicyAlert,
  ClassicyApp,
  ClassicyBalloonHelp,
  ClassicyBevelButton,
  ClassicyButton,
  ClassicyButtonToolbar,
  ClassicyButtonToolbarGroup,
  ClassicyCheckbox,
  ClassicyContextualMenuTarget,
  ClassicyForm,
  ClassicyFormButtonRow,
  ClassicyIcons,
  ClassicyInput,
  ClassicyProgressBar,
  ClassicySplitView,
  ClassicyTable,
  ClassicyTree,
  ClassicyTriangle,
  ClassicyWindow,
  dispatch,
  useClassicyAboutMenu,
  useClassicyEditMenu,
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
  fsWrite,
  logout,
  Unauthorized,
} from '../api';
import type { FsEntry } from '../api';
import { fmtBytes } from '../format';
import { openInEditor } from '../editorBridge';
import { quitMenuItem } from '../quitMenuItem';
import { CodeEditor } from '../components/CodeEditor';
import { MarkdownPreview } from '../components/MarkdownPreview';

const APP_ID = 'srv-finder.app';
const APP_NAME = 'Files';
const MAIN_WIN = 'fm-main';
const ICON = ClassicyIcons.system.folders.directory;
const DRIVE_ICON = ClassicyIcons.system.drives.disk;
const FAV_ICON = ClassicyIcons.system.folders.favorites;
const ICON_BACK = ClassicyIcons.applications.internetExplorer.backward;
const ICON_UP = ClassicyIcons.ui.menuDropdownArrowUp;
const ICON_REFRESH = ClassicyIcons.applications.internetExplorer.refresh;
const ICON_UPLOAD = ClassicyIcons.applications.internetExplorer.documentMoveToFolder;
const ICON_DOWNLOAD = ClassicyIcons.applications.internetExplorer.documentDownload;
const ICON_RENAME = ClassicyIcons.applications.internetExplorer.editor;
const MAX_PREVIEWS = 3;

/** 文件种类：驱动行图标、种类列文案与扩展名细分映射 */
type FileKind =
  | 'folder'
  | 'image'
  | 'text'
  | 'markdown'
  | 'script'
  | 'audio'
  | 'video'
  | 'application'
  | 'archive'
  | 'font'
  | 'document'
  | 'other';

// 扩展名 → 种类（大小写不敏感）；未命中时回退到后端 previewable 标记
const EXT_KIND: Record<string, FileKind> = {
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  svg: 'image',
  webp: 'image',
  bmp: 'image',
  ico: 'image',
  txt: 'text',
  md: 'markdown',
  js: 'script',
  mjs: 'script',
  cjs: 'script',
  ts: 'script',
  tsx: 'script',
  jsx: 'script',
  py: 'script',
  sh: 'script',
  bash: 'script',
  zsh: 'script',
  json: 'script',
  yaml: 'script',
  yml: 'script',
  css: 'script',
  scss: 'script',
  html: 'script',
  htm: 'script',
  xml: 'script',
  sql: 'script',
  c: 'script',
  h: 'script',
  cpp: 'script',
  hpp: 'script',
  cc: 'script',
  go: 'script',
  rs: 'script',
  java: 'script',
  rb: 'script',
  php: 'script',
  lua: 'script',
  mp3: 'audio',
  wav: 'audio',
  flac: 'audio',
  aac: 'audio',
  ogg: 'audio',
  mp4: 'video',
  mov: 'video',
  avi: 'video',
  mkv: 'video',
  app: 'application',
  exe: 'application',
  command: 'application',
  zip: 'archive',
  tar: 'archive',
  gz: 'archive',
  tgz: 'archive',
  bz2: 'archive',
  '7z': 'archive',
  rar: 'archive',
  ttf: 'font',
  otf: 'font',
  pdf: 'document',
  doc: 'document',
  docx: 'document',
  xls: 'document',
  xlsx: 'document',
  ppt: 'document',
  pptx: 'document',
  rtf: 'document',
};

const KIND_META: Record<FileKind, { label: string; icon: string }> = {
  folder: { label: '文件夹', icon: ClassicyIcons.system.folders.directory },
  image: { label: '图片', icon: ClassicyIcons.system.files.photo },
  text: { label: '文本文档', icon: ClassicyIcons.system.files.fileText },
  markdown: { label: 'Markdown', icon: ClassicyIcons.system.files.note },
  script: { label: '脚本', icon: ClassicyIcons.system.files.script },
  audio: { label: '音频', icon: ClassicyIcons.system.files.sound },
  video: { label: '视频', icon: ClassicyIcons.system.files.slideshow },
  application: { label: '应用程序', icon: ClassicyIcons.system.files.application },
  archive: { label: '压缩包', icon: ClassicyIcons.system.folders.compressed },
  font: { label: '字体', icon: ClassicyIcons.system.folders.fonts },
  document: { label: '文档', icon: ClassicyIcons.system.files.document },
  other: { label: '其他', icon: ClassicyIcons.system.files.file },
};

function extOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toLowerCase() : '';
}

function kindFor(entry: FsEntry): FileKind {
  if (entry.type === 'dir') return 'folder';
  return (
    EXT_KIND[extOf(entry.name)] ??
    (entry.previewable === 'image'
      ? 'image'
      : entry.previewable === 'markdown'
        ? 'markdown'
        : entry.previewable === 'text'
          ? 'text'
          : 'other')
  );
}

function iconFor(entry: FsEntry): string {
  return KIND_META[kindFor(entry)].icon;
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

/** Finder 风格日期：今天「今天 HH:mm」，今年非今天「M月D日 HH:mm」，往年「YYYY年M月D日」 */
function fmtDate(ms: number): string {
  const d = new Date(ms);
  if (isNaN(+d)) return '—';
  const p = (n: number) => String(n).padStart(2, '0');
  const hm = `${p(d.getHours())}:${p(d.getMinutes())}`;
  const now = new Date();
  const today =
    d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  if (today) return `今天 ${hm}`;
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
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

type FmDialog =
  | { kind: 'mkdir'; value: string }
  | { kind: 'newfile'; value: string }
  | { kind: 'rename'; value: string; target: FsEntry };

export function FinderApp({ onLogout }: { onLogout: () => void }) {
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
  // Get Info 属性窗口：显示选中条目（或当前目录）的名称/路径/大小等
  const [infoEntry, setInfoEntry] = useState<FsEntry | null>(null);

  const { aboutMenuItem, aboutWindow } = useClassicyAboutMenu(APP_ID, APP_NAME, ICON);
  // 路径栏 / 对话框的 ClassicyInput 为标准文本框，编辑命令作用于最后聚焦的文本框
  const editMenuItem = useClassicyEditMenu('fm');
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
      const winId = winIdFor(entry.path);
      dispatch({
        type: 'ClassicyWindowOpen',
        app: { id: APP_ID },
        window: {
          id: winId,
          minimumSize: [420, 320],
          size: [720, 520],
          position: [120 + off, 80 + off],
        },
      });
      // 窗口关闭后记录仍保留在 classicy store（仅标记 closed），再次 Open 只重置
      // closed 不聚焦，导致重开的预览窗口被主窗口遮挡。追加 Focus 保证每次打开都
      // 置顶（与 classicy 内部重开窗口的 Open+Focus 组合一致，对已聚焦窗口无副作用）。
      dispatch({
        type: 'ClassicyWindowFocus',
        app: { id: APP_ID },
        window: { id: winId },
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
        for (const e of list) childrenCache.current.delete(e.path);
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
      } else if (dialog.kind === 'newfile') {
        if (!name || !current) return;
        // 文件名必须是纯名称（可含扩展名），禁止路径分隔符与相对路径片段
        if (/[\\/]/.test(name) || name === '.' || name === '..') {
          stopAlert('新建文件失败', '文件名不能包含路径分隔符');
          return;
        }
        await fsWrite(joinPath(current, name), '', true);
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
      stopAlert(
        dialog.kind === 'mkdir' ? '新建文件夹失败' : dialog.kind === 'newfile' ? '新建文件失败' : '重命名失败',
        (e as Error).message
      );
    }
  }, [dialog, dialogValue, current, favorites, applyFavorites, fetchDir, handleLogout, stopAlert]);

  // 选中条目索引：主列表 + 懒加载缓存（内联展开的子行也纳入选中与操作范围）
  const entryIndex = useMemo(() => {
    const m = new Map<string, FsEntry>();
    for (const e of entries) m.set(e.path, e);
    for (const kids of childrenCache.current.values()) for (const e of kids) m.set(e.path, e);
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries, treeVersion]);
  const selectedEntries = useMemo(
    () => selected.map((id) => entryIndex.get(id)).filter((e): e is FsEntry => !!e),
    [selected, entryIndex]
  );
  const visibleEntries = useMemo(
    () => (showHidden ? entries : entries.filter((e) => !e.name.startsWith('.'))),
    [entries, showHidden]
  );
  // 表格行数组：treeVersion 变化时强制新引用，让 ClassicyTable 重新求值 getSubRows
  //（子目录懒加载完成后立即在已展开的父行下渲染子行）
  const tableRows = useMemo(() => [...visibleEntries], [visibleEntries, treeVersion]);
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

  // 新建文本文件对话框（预填默认名，可在输入时修改扩展名）
  const openNewFileDialog = useCallback(() => {
    setDialogValue('新建文本.txt');
    setDialog({ kind: 'newfile', value: '新建文本.txt' });
  }, []);

  const columns: Array<ClassicyTableColumn<FsEntry>> = useMemo(
    () => [
      {
        id: 'name',
        title: '名称',
        accessor: (r) => r.name,
        // table-layout:fixed 下宽度按比例分配，名称列给大宽度以占据剩余空间
        width: 400,
        render: (r, ex) => (
          // 与 classicy 内建 Finder 列表视图一致：disclosure 三角 + 按深度缩进
          <div
            className="classicyFileBrowserViewTableRowContainer"
            style={{ paddingLeft: `calc(var(--window-control-size) * ${ex.depth})` }}
          >
            <span className="classicyFileBrowserViewTableDisclosure">
              {ex.canExpand && (
                <span
                  className="classicyFileBrowserViewTableDisclosureTriangle"
                  onClick={(e) => e.stopPropagation()}
                >
                  <ClassicyTriangle direction="right" open={ex.isExpanded} onToggle={ex.toggle} />
                </span>
              )}
            </span>
            <span className="sp-fm-name">
              <img src={iconFor(r)} alt="" />
              {r.name}
            </span>
          </div>
        ),
      },
      {
        id: 'size',
        title: '大小',
        accessor: (r) => (r.type === 'dir' ? -1 : r.size),
        align: 'right',
        width: 90,
        render: (r) => (r.type === 'dir' ? '—' : fmtBytes(r.size)),
      },
      {
        id: 'mtime',
        title: '修改时间',
        accessor: (r) => r.mtime,
        width: 150,
        render: (r) => (r.mtime ? fmtDate(r.mtime) : '—'),
      },
      {
        id: 'kind',
        title: '种类',
        accessor: (r) => kindFor(r),
        width: 120,
        render: (r) => <span title={`权限：${r.mode}`}>{KIND_META[kindFor(r)].label}</span>,
      },
    ],
    []
  );

  // 目录树节点：未加载的目录显示占位节点，展开时懒加载
  const treeNodes: ClassicyTreeNode[] = useMemo(() => {
    const build = (path: string, label: string, icon: string): ClassicyTreeNode => {
      const kids = childrenCache.current.get(path);
      const childDirs = kids ? kids.filter((e) => e.type === 'dir') : null;
      return {
        id: path,
        label,
        leftIcon: icon,
        // 分支节点单击即选中并导航（默认 false 是切换展开）
        branchSelectable: true,
        children: childDirs
          ? childDirs.map((d) => build(d.path, d.name, ICON))
          : [{ id: `${path}::loading`, label: '加载中…', disabled: true }],
      };
    };
    // 挂载点/树根用磁盘图标，子目录用文件夹图标
    return roots.map((r) => build(r, r === '/' ? '根目录' : r, DRIVE_ICON));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roots, treeVersion]);

  // 收藏夹单层树节点：label 用末级目录名，行内 × 按钮取消收藏（沿用原收藏逻辑）
  const favNodes: ClassicyTreeNode[] = useMemo(
    () =>
      favorites.map((f) => ({
        id: f,
        label: baseName(f) || f,
        leftIcon: FAV_ICON,
        buttons: [
          {
            label: '×',
            onClickFunc: (e) => {
              e.stopPropagation();
              toggleFavorite(f);
            },
          },
        ],
      })),
    [favorites, toggleFavorite]
  );

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
        {
          id: 'fm-cm-newfile',
          title: '新建文本文件…',
          disabled: !current,
          onClickFunc: openNewFileDialog,
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
  }, [selectedEntries, current, favPaths, openEntry, downloadEntries, requestDelete, fetchDir, toggleFavorite, openNewFileDialog]);

  const appMenu = useMemo(
    () => [
      {
        id: 'fm-app',
        title: APP_NAME,
        menuChildren: [
          aboutMenuItem,
          { id: 'spacer' },
          quitMenuItem(APP_ID, APP_NAME, ICON),
        ],
      },
      {
        id: 'fm-file',
        title: 'File',
        menuChildren: [
          {
            id: 'fm-m-newdir',
            title: 'New Folder…',
            // 无当前目录时不可执行（对齐右键菜单语义）：保留菜单项置灰而非隐藏
            disabled: !current,
            onClickFunc: () => {
              setDialogValue('');
              setDialog({ kind: 'mkdir', value: '' });
            },
          },
          { id: 'fm-m-newfile', title: 'New Text File…', disabled: !current, onClickFunc: openNewFileDialog },
          { id: 'fm-m-upload', title: 'Upload File…', disabled: !current, onClickFunc: () => fileInputRef.current?.click() },
          { id: 'spacer' },
          {
            id: 'fm-m-info',
            title: 'Get Info…',
            // 选中条目或当前目录均可查看属性；根列表且无选中时置灰（保留项不隐藏）
            disabled: selectedEntries.length === 0 && !current,
            onClickFunc: () => {
              if (selectedEntries.length > 0) {
                setInfoEntry(selectedEntries[0]);
              } else if (current) {
                setInfoEntry({
                  name: baseName(current) || current,
                  path: current,
                  type: 'dir',
                  size: 0,
                  mtime: 0,
                  mode: '',
                  previewable: 'none',
                });
              }
            },
          },
        ],
      },
      editMenuItem,
      {
        id: 'fm-view',
        title: 'View',
        menuChildren: [
          { id: 'fm-m-hidden', title: 'Show Hidden Files', checked: showHidden, onClickFunc: () => setShowHidden((v) => !v) },
          { id: 'fm-m-refresh', title: 'Refresh', onClickFunc: () => void fetchDir(current) },
        ],
      },
    ],
    [aboutMenuItem, editMenuItem, showHidden, current, selectedEntries, fetchDir, openNewFileDialog]
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
          <ClassicyButtonToolbar size="small" className="sp-fm-toolbar">
            <ClassicyButtonToolbarGroup>
              <ClassicyBalloonHelp content="后退到上一个目录">
                <ClassicyBevelButton
                  bevelWidth="small"
                  square
                  icon={ICON_BACK}
                  iconAlt="后退"
                  disabled={backStack.length === 0}
                  onClickFunc={goBack}
                />
              </ClassicyBalloonHelp>
              <ClassicyBalloonHelp content="转到上一级目录">
                <ClassicyBevelButton
                  bevelWidth="small"
                  square
                  icon={ICON_UP}
                  iconAlt="上级"
                  disabled={!current}
                  onClickFunc={goUp}
                />
              </ClassicyBalloonHelp>
              <ClassicyBalloonHelp content="重新读取当前目录">
                <ClassicyBevelButton
                  bevelWidth="small"
                  square
                  icon={ICON_REFRESH}
                  iconAlt="刷新"
                  onClickFunc={() => void fetchDir(current)}
                />
              </ClassicyBalloonHelp>
            </ClassicyButtonToolbarGroup>
            <ClassicyButtonToolbarGroup>
              <ClassicyBalloonHelp content="在当前目录新建文件夹">
                <ClassicyBevelButton
                  bevelWidth="small"
                  square
                  icon={ICON}
                  iconAlt="新建文件夹"
                  disabled={!current}
                  onClickFunc={() => {
                    setDialogValue('');
                    setDialog({ kind: 'mkdir', value: '' });
                  }}
                />
              </ClassicyBalloonHelp>
              <ClassicyBalloonHelp content="新建文本文件">
                <ClassicyBevelButton
                  bevelWidth="small"
                  square
                  icon={ClassicyIcons.system.files.fileText}
                  iconAlt="新建文本"
                  disabled={!current}
                  onClickFunc={openNewFileDialog}
                />
              </ClassicyBalloonHelp>
              <ClassicyBalloonHelp content="上传文件到当前目录">
                <ClassicyBevelButton
                  bevelWidth="small"
                  square
                  icon={ICON_UPLOAD}
                  iconAlt="上传"
                  disabled={!current}
                  onClickFunc={() => fileInputRef.current?.click()}
                />
              </ClassicyBalloonHelp>
            </ClassicyButtonToolbarGroup>
            <ClassicyButtonToolbarGroup>
              <ClassicyBalloonHelp content="下载选中的文件">
                <ClassicyBevelButton
                  bevelWidth="small"
                  square
                  icon={ICON_DOWNLOAD}
                  iconAlt="下载"
                  disabled={!selectedEntries.length}
                  onClickFunc={() => downloadEntries(selectedEntries)}
                />
              </ClassicyBalloonHelp>
              <ClassicyBalloonHelp content="删除选中的项目">
                <ClassicyBevelButton
                  bevelWidth="small"
                  square
                  icon={ClassicyIcons.system.desktop.trashEmpty}
                  iconAlt="删除"
                  disabled={!selectedEntries.length}
                  onClickFunc={() => requestDelete(selectedEntries)}
                />
              </ClassicyBalloonHelp>
              <ClassicyBalloonHelp content="重命名选中的项目">
                <ClassicyBevelButton
                  bevelWidth="small"
                  square
                  icon={ICON_RENAME}
                  iconAlt="重命名"
                  disabled={selectedEntries.length !== 1}
                  onClickFunc={() => {
                    const t = selectedEntries[0];
                    if (!t) return;
                    setDialogValue(t.name);
                    setDialog({ kind: 'rename', value: t.name, target: t });
                  }}
                />
              </ClassicyBalloonHelp>
            </ClassicyButtonToolbarGroup>
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
          </ClassicyButtonToolbar>

          <ClassicySplitView direction="horizontal" defaultSizes={[26, 74]} minPaneSize={180} className="sp-fm-split">
            <div className="sp-fm-side">
              <div className="sp-fm-side-title">收藏夹</div>
              {favorites.length === 0 ? (
                <div className="sp-fm-empty">右键目录可添加收藏</div>
              ) : (
                <ClassicyTree nodes={favNodes} selectionMode="single" selectedIds={[]} onSelectNode={(id) => navigate(id)} />
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
                  {!loading && !error && visibleEntries.length === 0 ? (
                    <div className="sp-fm-empty sp-fm-empty-dir">此文件夹为空</div>
                  ) : (
                    <ClassicyTable
                      columns={columns}
                      rows={tableRows}
                      getRowId={(r) => r.path}
                      selectionMode="multi"
                      selected={selected}
                      onSelectionChange={setSelected}
                      onActivateRow={(_id, row) => openEntry(row)}
                      defaultSort={{ columnId: 'name' }}
                      rowClassName={(_r, sel) => (sel ? 'sp-fm-row-selected' : undefined)}
                      // 目录行内联展开：首列 disclosure 三角就地预览子目录（双击/回车仍进目录）
                      rowCanExpand={(r) => {
                        if (r.type !== 'dir') return false;
                        const kids = childrenCache.current.get(r.path);
                        return kids ? kids.some((e) => e.type === 'dir') : true;
                      }}
                      getSubRows={(r) => childrenCache.current.get(r.path)}
                      onToggleRow={(id, open) => {
                        if (open) void ensureChildren(id);
                      }}
                    />
                  )}
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
                        <ClassicyBalloonHelp content="取消上传">
                          <button
                            type="button"
                            className="sp-fm-fav-del"
                            onClick={() => abortRef.current.get(u.key)?.()}
                          >
                            ×
                          </button>
                        </ClassicyBalloonHelp>
                      </div>
                    ))}
                  </div>
                )}
                <div className="sp-fm-status">
                  <span className="sp-fm-status-main">
                    {loading ? (
                      <ClassicyProgressBar indeterminate />
                    ) : error ? (
                      `错误：${error}`
                    ) : (
                      current || '根目录列表'
                    )}
                  </span>
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

      {dialog && (
        <ClassicyWindow
          id="fm-dialog"
          appId={APP_ID}
          title={dialog.kind === 'mkdir' ? '新建文件夹' : dialog.kind === 'newfile' ? '新建文本文件' : '重命名'}
          icon={ICON}
          modal
          closable={false}
          zoomable={false}
          collapsable={false}
          resizable={false}
          initialSize={[380, 0]}
          initialPosition={['center', 'center']}
        >
          <ClassicyForm
            layout="dialog"
            onSubmitFunc={(e) => {
              e.preventDefault();
              void submitDialog();
            }}
          >
            <ClassicyInput
              id="fm-dialog-name"
              key={dialog.kind + dialog.value}
              prefillValue={dialog.value}
              labelTitle={dialog.kind === 'rename' ? '新名称' : dialog.kind === 'newfile' ? '文件名' : '名称'}
              labelPosition="left"
              onChangeFunc={(e) => setDialogValue(e.target.value)}
            />
            <ClassicyFormButtonRow>
              <ClassicyButton onClickFunc={() => setDialog(null)}>取消</ClassicyButton>
              <ClassicyButton isDefault buttonType="submit">
                {dialog.kind === 'rename' ? '重命名' : '创建'}
              </ClassicyButton>
            </ClassicyFormButtonRow>
          </ClassicyForm>
        </ClassicyWindow>
      )}

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
      {infoEntry && (
        <ClassicyWindow
          id="fm-info"
          appId={APP_ID}
          title={`Info · ${infoEntry.name}`}
          icon={iconFor(infoEntry)}
          closable
          resizable
          scrollable={false}
          initialSize={[460, 250]}
          initialPosition={['center', 'center']}
          minimumSize={[380, 200]}
          onCloseFunc={() => setInfoEntry(null)}
        >
          <div className="sp-fm-info">
            <div className="sp-fm-info-row">
              <span className="sp-fm-info-label">Name</span>
              <span className="sp-fm-info-value">{infoEntry.name}</span>
            </div>
            <div className="sp-fm-info-row">
              <span className="sp-fm-info-label">Path</span>
              <span className="sp-fm-info-value sp-fm-info-path" title={infoEntry.path}>
                {infoEntry.path}
              </span>
            </div>
            <div className="sp-fm-info-row">
              <span className="sp-fm-info-label">Kind</span>
              <span className="sp-fm-info-value">{infoEntry.type === 'dir' ? 'Folder' : 'File'}</span>
            </div>
            <div className="sp-fm-info-row">
              <span className="sp-fm-info-label">Size</span>
              <span className="sp-fm-info-value">{infoEntry.type === 'dir' ? '—' : fmtBytes(infoEntry.size)}</span>
            </div>
            <div className="sp-fm-info-row">
              <span className="sp-fm-info-label">Modified</span>
              <span className="sp-fm-info-value">{infoEntry.mtime ? fmtDate(infoEntry.mtime) : '—'}</span>
            </div>
            <div className="sp-fm-info-row">
              <span className="sp-fm-info-label">Permissions</span>
              <span className="sp-fm-info-value">{infoEntry.mode || '—'}</span>
            </div>
          </div>
        </ClassicyWindow>
      )}
      {aboutWindow}
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

  const { aboutMenuItem, aboutWindow } = useClassicyAboutMenu(APP_ID, APP_NAME, ICON);

  // 预览窗口聚焦时的专属菜单：编辑/下载/视图切换自窗口内工具栏迁入菜单栏
  const appMenu = useMemo(
    () => [
      {
        id: 'fm-pv-app',
        title: APP_NAME,
        menuChildren: [
          aboutMenuItem,
          { id: 'spacer' },
          quitMenuItem(APP_ID, APP_NAME, ICON),
        ],
      },
      {
        id: 'fm-pv-file',
        title: 'File',
        menuChildren: [
          {
            id: 'fm-pv-m-edit',
            title: 'Open with Editor',
            // 仅文本/Markdown 可编辑：不可用时保留菜单项置灰而非隐藏
            disabled: !canEdit,
            onClickFunc: () => onEdit(entry),
          },
          { id: 'fm-pv-m-download', title: 'Download', onClickFunc: onDownload },
          { id: 'spacer' },
          { id: 'fm-pv-m-close', title: 'Close Window', onClickFunc: onClose },
        ],
      },
      {
        id: 'fm-pv-view',
        title: 'View',
        menuChildren: [
          {
            id: 'fm-pv-m-rendered',
            title: 'Rendered View',
            disabled: !isMd,
            checked: isMd && !source,
            onClickFunc: () => setSource(false),
          },
          {
            id: 'fm-pv-m-source',
            title: 'Source View',
            disabled: !isMd,
            checked: isMd && source,
            onClickFunc: () => setSource(true),
          },
        ],
      },
    ],
    [aboutMenuItem, canEdit, isMd, source, entry, onEdit, onDownload, onClose]
  );

  return (
    <>
      <ClassicyWindow
        id={winId}
        appId={APP_ID}
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
        appMenu={appMenu}
        onCloseFunc={onClose}
      >
        <div className="sp-fm-preview">
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
      {aboutWindow}
    </>
  );
}
