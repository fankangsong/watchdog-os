// Finder（文件管理器）：默认图标视图（大图标 + 下方名称，OS8 选中高亮），View 菜单可切换列表视图。
// 无工具栏/侧栏/状态栏（对齐 docs/design 参考图 Workspace）：新建/上传/下载/删除/重命名统一走
// 右键菜单与菜单栏，目录导航经双击进入 + Go 菜单（Back ⌘[ / Open Parent Folder ⌘↑）。
// 支持上传（进度/取消/覆盖确认）、新建文件夹、新建文本文件、重命名（可改扩展名）、删除、
// 复制/剪切/粘贴（服务端递归复制，同名自动追加 copy 后缀）、Get Info，
// 以及图片/文本/Markdown 预览窗口。文件选择类命令走 Edit 菜单（Cut/Copy/Paste/Select All/Delete…）
// 与快捷键（⌘C/⌘X/⌘V/⌘A/⌘⌫），与右键菜单三路等价。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import {
  ClassicyAlert,
  ClassicyApp,
  ClassicyBalloonHelp,
  ClassicyButton,
  ClassicyContextualMenuTarget,
  ClassicyForm,
  ClassicyFormButtonRow,
  ClassicyIcons,
  ClassicyInput,
  ClassicyProgressBar,
  ClassicyTable,
  ClassicyTriangle,
  ClassicyWindow,
  dispatch,
  useClassicyAboutMenu,
  useClassicyContextualMenu,
} from 'classicy';
import type { ClassicyMenuItem, ClassicyTableColumn } from 'classicy';
import {
  fsCopy,
  fsDelete,
  fsList,
  fsMkdir,
  fsRawUrl,
  fsRead,
  fsRename,
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
const APP_NAME = 'Disk';
const MAIN_WIN = 'fm-main';
const ICON = ClassicyIcons.system.folders.directory;
const DRIVE_ICON = ClassicyIcons.system.drives.disk;
const MAX_PREVIEWS = 3;
/** 新建文本文件的默认名（对话框内可改，含扩展名） */
const DEFAULT_NEW_FILE = 'untitled.txt';
/** 视图偏好持久化键（icons | list） */
const PREFS_KEY = 'srv-finder-prefs';

type ViewMode = 'icons' | 'list';

function loadViewMode(): ViewMode {
  try {
    const raw = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') as { viewMode?: string };
    return raw.viewMode === 'list' ? 'list' : 'icons';
  } catch {
    return 'icons';
  }
}

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
  folder: { label: 'Folder', icon: ClassicyIcons.system.folders.directory },
  image: { label: 'Picture', icon: ClassicyIcons.system.files.photo },
  text: { label: 'Text Document', icon: ClassicyIcons.system.files.fileText },
  markdown: { label: 'Markdown', icon: ClassicyIcons.system.files.note },
  script: { label: 'Script', icon: ClassicyIcons.system.files.script },
  audio: { label: 'Audio', icon: ClassicyIcons.system.files.sound },
  video: { label: 'Movie', icon: ClassicyIcons.system.files.slideshow },
  application: { label: 'Application', icon: ClassicyIcons.system.files.application },
  archive: { label: 'Archive', icon: ClassicyIcons.system.folders.compressed },
  font: { label: 'Font', icon: ClassicyIcons.system.folders.fonts },
  document: { label: 'Document', icon: ClassicyIcons.system.files.document },
  other: { label: 'Other', icon: ClassicyIcons.system.files.file },
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
  /** 指定默认按钮 id；有数据丢失风险的确认必须指向安全项（Cancel） */
  defaultButtonId?: string;
  buttons: Array<{ id: string; label: string; role?: 'default' | 'cancel' | 'normal'; onClick?: () => void }>;
}

type FmDialog =
  | { kind: 'mkdir'; value: string }
  | { kind: 'newfile'; value: string }
  | { kind: 'rename'; value: string; target: FsEntry };

export function FinderApp({ onLogout }: { onLogout: () => void }) {
  const [current, setCurrent] = useState('');
  const [entries, setEntries] = useState<FsEntry[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [showHidden, setShowHidden] = useState(false);
  const [loading, setLoading] = useState(false);
  const [backStack, setBackStack] = useState<string[]>([]);
  const [previews, setPreviews] = useState<FsEntry[]>([]);
  const [uploads, setUploads] = useState<UploadTask[]>([]);
  const [alert, setAlert] = useState<FmAlert | null>(null);
  // Get Info 属性窗口：显示选中条目（或当前目录）的名称/路径/大小等
  const [infoEntry, setInfoEntry] = useState<FsEntry | null>(null);
  // 视图模式：默认图标视图（对齐参考图 Workspace），View 菜单切换并持久化
  const [viewMode, setViewModeState] = useState<ViewMode>(loadViewMode);

  const { aboutMenuItem, aboutWindow } = useClassicyAboutMenu(APP_ID, APP_NAME, ICON);
  // 剪贴板：Copy/Cut 时的条目快照；mode 决定 Paste 是复制还是移动（剪切）
  const [clipboard, setClipboard] = useState<{ entries: FsEntry[]; mode: 'copy' | 'cut' } | null>(null);
  // 命令式右键菜单：图标视图在事件时构建菜单（含未选中项的即时改选），保证菜单与点击目标一致
  const { showContextMenu } = useClassicyContextualMenu();
  const [dialog, setDialog] = useState<FmDialog | null>(null);
  const [dialogValue, setDialogValue] = useState('');
  const [treeVersion, setTreeVersion] = useState(0);

  const childrenCache = useRef(new Map<string, FsEntry[]>());
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const abortRef = useRef(new Map<string, () => void>());
  const cascadeRef = useRef(0);
  // 图标视图 shift 连选的锚点下标
  const iconAnchor = useRef(-1);

  const setViewMode = useCallback((m: ViewMode) => {
    setViewModeState(m);
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify({ viewMode: m }));
    } catch {
      // 持久化失败不影响本次切换
    }
  }, []);

  const handleLogout = useCallback(async () => {
    try {
      await logout();
    } catch {
      // 登出接口失败也照常回到登录页（如 token 已过期）
    }
    onLogout();
  }, [onLogout]);

  const stopAlert = useCallback((label: string, message: string) => {
    setAlert({ alertType: 'stop', label, message, buttons: [{ id: 'ok', label: 'OK', role: 'default' }] });
  }, []);

  const fetchDir = useCallback(
    async (p: string) => {
      setLoading(true);
      try {
        const r = await fsList(p);
        setEntries(r.entries);
        setSelected([]);
        setCurrent(r.path);
        iconAnchor.current = -1;
        if (r.path) {
          childrenCache.current.set(r.path, r.entries);
          setTreeVersion((v) => v + 1);
        }
      } catch (e) {
        if (e instanceof Unauthorized) return handleLogout();
        // 目录加载均为用户主动动作，失败弹 alert 说明原因；已有列表保留（stale-while-revalidate）
        stopAlert('Cannot Read Folder', (e as Error).message);
      } finally {
        setLoading(false);
      }
    },
    [handleLogout, stopAlert]
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

  // 挂载即加载根列表（无侧栏后根视图即初始视图：磁盘图标列表）
  useEffect(() => {
    void fetchDir('');
  }, [fetchDir]);

  // 目录树懒加载缓存（列表视图的目录行内联展开用）
  const ensureChildren = useCallback(
    async (dir: string) => {
      if (childrenCache.current.has(dir)) return;
      try {
        const r = await fsList(dir);
        childrenCache.current.set(dir, r.entries);
        setTreeVersion((v) => v + 1);
      } catch (e) {
        if (e instanceof Unauthorized) return handleLogout();
        stopAlert('Cannot Read Folder', (e as Error).message);
      }
    },
    [handleLogout, stopAlert]
  );

  const openEntry = useCallback(
    (entry: FsEntry) => {
      if (entry.type === 'dir') return navigate(entry.path);
      if (entry.previewable === 'none') {
        setAlert({
          alertType: 'caution',
          label: 'Cannot Preview',
          message: `“${entry.name}” is not a previewable type. Download it to open.`,
          buttons: [{ id: 'ok', label: 'OK', role: 'default' }],
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
        await fetchDir(current);
      } catch (e) {
        if (e instanceof Unauthorized) return handleLogout();
        stopAlert('Delete Failed', (e as Error).message);
      }
    },
    [current, fetchDir, handleLogout, stopAlert]
  );

  const requestDelete = useCallback(
    (list: FsEntry[]) => {
      if (!list.length) return;
      setAlert({
        alertType: 'caution',
        label: list.length === 1 ? `Delete “${list[0].name}”?` : `Delete these ${list.length} items?`,
        message: `${list.map((e) => e.name).join(', ')} will be permanently deleted (folders are deleted recursively). This cannot be undone.`,
        // 有数据丢失风险：默认按钮为安全项 Cancel（Return 不触发删除），删除为普通按钮
        defaultButtonId: 'cancel',
        buttons: [
          { id: 'cancel', label: 'Cancel', role: 'cancel' },
          { id: 'ok', label: 'Delete', role: 'normal', onClick: () => void doDelete(list) },
        ],
      });
    },
    [doDelete]
  );

  /** 放入剪贴板（Copy 复制 / Cut 剪切）；右键菜单绑定到菜单自身作用对象 list */
  const setClipboardFor = useCallback((list: FsEntry[], mode: 'copy' | 'cut') => {
    if (!list.length) return;
    setClipboard({ entries: list, mode });
  }, []);

  /**
   * 粘贴：Copy 模式为服务端递归复制；Cut 模式先复制后删源（复制失败不删源，避免数据丢失），
   * 完成后清空剪贴板。同名冲突由服务端自动追加 " copy" 后缀，不做破坏性覆盖。
   */
  const doPaste = useCallback(async () => {
    if (!clipboard) return;
    const { entries: list, mode } = clipboard;
    if (!list.length) {
      setClipboard(null);
      return;
    }
    if (!current) {
      setAlert({
        alertType: 'caution',
        label: 'Cannot Paste',
        message: 'Open a folder before pasting.',
        buttons: [{ id: 'ok', label: 'OK', role: 'default' }],
      });
      return;
    }
    const created: string[] = [];
    try {
      for (const e of list) {
        // 剪切到条目所在目录自身：空操作（与 macOS Finder 一致）
        if (mode === 'cut' && parentPath(e.path) === current) continue;
        const r = await fsCopy(e.path, current);
        created.push(r.path);
        if (mode === 'cut') await fsDelete(e.path);
      }
      if (mode === 'cut') setClipboard(null); // 剪切粘贴后清空；复制保留以便多次粘贴
      childrenCache.current.delete(current);
      await fetchDir(current);
      // fetchDir 会清空选中，粘贴完成后选中新建条目
      if (created.length) setSelected(created);
    } catch (e) {
      if (e instanceof Unauthorized) return handleLogout();
      childrenCache.current.delete(current);
      await fetchDir(current).catch(() => {});
      stopAlert('Paste Failed', (e as Error).message);
    }
  }, [clipboard, current, fetchDir, handleLogout, stopAlert]);

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
        if (msg === 'File already exists') {
          setAlert({
            alertType: 'caution',
            label: 'File Exists',
            message: `“${file.name}” already exists. Overwrite it?`,
            // 覆盖会丢失原文件：默认按钮为 Cancel
            defaultButtonId: 'cancel',
            buttons: [
              { id: 'cancel', label: 'Cancel', role: 'cancel' },
              {
                id: 'ok',
                label: 'Overwrite',
                role: 'normal',
                onClick: () => void uploadOne(dir, file, key, true),
              },
            ],
          });
          return;
        }
        if (msg !== 'Upload canceled') stopAlert('Upload Failed', `${file.name}: ${msg}`);
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
          label: 'Cannot Upload',
          message: 'Open a folder before uploading.',
          buttons: [{ id: 'ok', label: 'OK', role: 'default' }],
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
          stopAlert('New File Failed', 'A file name cannot contain path separators.');
          return;
        }
        await fsWrite(joinPath(current, name), '', true);
      } else if (dialog.kind === 'rename') {
        if (!name) return;
        const target = dialog.target;
        await fsRename(target.path, name);
        childrenCache.current.delete(parentPath(target.path));
      }
      childrenCache.current.delete(current);
      setDialog(null);
      await fetchDir(current);
    } catch (e) {
      if (e instanceof Unauthorized) return handleLogout();
      stopAlert(
        dialog.kind === 'mkdir' ? 'New Folder Failed' : dialog.kind === 'newfile' ? 'New File Failed' : 'Rename Failed',
        (e as Error).message
      );
    }
  }, [dialog, dialogValue, current, fetchDir, handleLogout, stopAlert]);

  // 选中条目索引：主列表 + 懒加载缓存（列表视图内联展开的子行也纳入选中与操作范围）
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
  /** 全选当前可见条目（受 Show Hidden Files 过滤影响） */
  const selectAllVisible = useCallback(() => {
    setSelected(visibleEntries.map((e) => e.path));
  }, [visibleEntries]);
  // 表格行数组：treeVersion 变化时强制新引用，让 ClassicyTable 重新求值 getSubRows
  //（子目录懒加载完成后立即在已展开的父行下渲染子行）
  const tableRows = useMemo(() => [...visibleEntries], [visibleEntries, treeVersion]);
  // 剪切待移动的条目集合：粘贴或重新剪切前置灰显示（macOS Finder 语义）
  const cutPaths = useMemo(
    () => (clipboard?.mode === 'cut' ? new Set(clipboard.entries.map((e) => e.path)) : null),
    [clipboard]
  );

  /** 根列表视图（未进入任何目录）用磁盘图标，其余按扩展名细分 */
  const displayIcon = useCallback((e: FsEntry) => (!current && e.type === 'dir' ? DRIVE_ICON : iconFor(e)), [current]);

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

  // Go 菜单快捷键真实绑定：classicy 的 keyboardShortcut 仅作展示、不自动生效，
  // 这里按菜单声明补齐行为（⌘[ 后退 / ⌘↑ 上一级）。焦点在输入框/编辑器时放行，不劫持打字。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
      if (e.key === '[') {
        e.preventDefault();
        goBack();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        goUp();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [goBack, goUp]);

  // 文件编辑类快捷键真实绑定：classicy 的 keyboardShortcut 仅作展示、不自动生效，
  // 这里按菜单声明补齐行为（⌘C 复制 / ⌘X 剪切 / ⌘V 粘贴 / ⌘A 全选 / ⌘⌫ 或 Delete 删除）。
  // 普通 Backspace 不绑定（Windows 用户预期它是“向上”，macOS Finder 亦不用它删除）。
  // 焦点在输入框/编辑器（对话框、CodeMirror）时放行，不劫持打字。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
      const mod = e.metaKey || e.ctrlKey;
      const k = e.key.toLowerCase();
      if (mod && k === 'c') {
        e.preventDefault();
        setClipboardFor(selectedEntries, 'copy');
      } else if (mod && k === 'x') {
        e.preventDefault();
        setClipboardFor(selectedEntries, 'cut');
      } else if (mod && k === 'v') {
        e.preventDefault();
        void doPaste();
      } else if (mod && k === 'a') {
        e.preventDefault();
        selectAllVisible();
      } else if ((mod && e.key === 'Backspace') || (!mod && e.key === 'Delete')) {
        e.preventDefault();
        requestDelete(selectedEntries);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedEntries, setClipboardFor, doPaste, selectAllVisible, requestDelete]);

  // 新建文本文件对话框（预填默认名，可在输入时修改扩展名）
  const openNewFileDialog = useCallback(() => {
    setDialogValue(DEFAULT_NEW_FILE);
    setDialog({ kind: 'newfile', value: DEFAULT_NEW_FILE });
  }, []);

  const openNewFolderDialog = useCallback(() => {
    setDialogValue('');
    setDialog({ kind: 'mkdir', value: '' });
  }, []);

  const openRenameDialog = useCallback((t: FsEntry) => {
    setDialogValue(t.name);
    setDialog({ kind: 'rename', value: t.name, target: t });
  }, []);

  // ---- 右键菜单构建（图标视图事件时调用；表格视图经 ContextualMenuTarget 复用） ----

  /** 选中条目菜单：list 即菜单作用对象（单选为该条目，多选为整组选中） */
  const buildItemMenu = useCallback(
    (list: FsEntry[]): ClassicyMenuItem[] => {
      const first = list[0];
      const items: ClassicyMenuItem[] = [];
      if (list.length === 1) {
        items.push({ id: 'fm-cm-open', title: 'Open', onClickFunc: () => openEntry(first) });
        if (first.type === 'file' && first.previewable !== 'none') {
          items.push({ id: 'fm-cm-edit', title: 'Open with Editor', onClickFunc: () => openInEditor(first.path) });
        }
      }
      if (list.some((f) => f.type === 'file')) {
        items.push({ id: 'fm-cm-download', title: 'Download', onClickFunc: () => downloadEntries(list) });
      }
      items.push(
        { id: 'spacer' },
        // 剪切/复制绑定到菜单作用对象 list（而非渲染时的选中态），保证与点击目标一致
        { id: 'fm-cm-cut', title: 'Cut', onClickFunc: () => setClipboardFor(list, 'cut') },
        { id: 'fm-cm-copy', title: 'Copy', onClickFunc: () => setClipboardFor(list, 'copy') }
      );
      if (list.length === 1) {
        items.push(
          { id: 'fm-cm-info', title: 'Get Info…', onClickFunc: () => setInfoEntry(first) },
          { id: 'fm-cm-rename', title: 'Rename…', onClickFunc: () => openRenameDialog(first) }
        );
      }
      items.push(
        { id: 'spacer' },
        {
          id: 'fm-cm-delete',
          title: `Delete${list.length > 1 ? ` ${list.length} Items` : ''}…`,
          onClickFunc: () => requestDelete(list),
        }
      );
      return items;
    },
    [openEntry, downloadEntries, requestDelete, openRenameDialog, setClipboardFor]
  );

  /** 空白处菜单：作用于当前目录 */
  const buildDirMenu = useCallback((): ClassicyMenuItem[] => {
    const items: ClassicyMenuItem[] = [
      { id: 'fm-cm-newdir', title: 'New Folder…', disabled: !current, onClickFunc: openNewFolderDialog },
      { id: 'fm-cm-newfile', title: 'New Text File…', disabled: !current, onClickFunc: openNewFileDialog },
      {
        id: 'fm-cm-upload',
        title: 'Upload File…',
        disabled: !current,
        onClickFunc: () => fileInputRef.current?.click(),
      },
      { id: 'spacer' },
      { id: 'fm-cm-paste', title: 'Paste', disabled: !clipboard || !current, onClickFunc: () => void doPaste() },
      { id: 'spacer' },
      { id: 'fm-cm-refresh', title: 'Refresh', onClickFunc: () => void fetchDir(current) },
    ];
    if (current) {
      items.push({ id: 'fm-cm-parent', title: 'Open Parent Folder', onClickFunc: goUp });
    }
    return items;
  }, [current, clipboard, openNewFolderDialog, openNewFileDialog, fetchDir, goUp, doPaste]);

  // 表格视图右键菜单（ContextualMenuTarget 按渲染时选中态解析；必须 useMemo）
  const menuItems: ClassicyMenuItem[] = useMemo(
    () => (selectedEntries.length > 0 ? buildItemMenu(selectedEntries) : buildDirMenu()),
    [selectedEntries, buildItemMenu, buildDirMenu]
  );

  // ---- 图标视图交互 ----

  /** 单击选择：普通单击改选、⌘/Ctrl 切换、⇧ 范围连选；空白处单击清空选中 */
  const handleIconClick = useCallback(
    (entry: FsEntry, idx: number, e: ReactMouseEvent<HTMLDivElement>) => {
      e.stopPropagation();
      if (e.shiftKey && iconAnchor.current >= 0) {
        const [a, b] = iconAnchor.current < idx ? [iconAnchor.current, idx] : [idx, iconAnchor.current];
        setSelected(visibleEntries.slice(a, b + 1).map((x) => x.path));
      } else if (e.metaKey || e.ctrlKey) {
        setSelected((s) => (s.includes(entry.path) ? s.filter((p) => p !== entry.path) : [...s, entry.path]));
        iconAnchor.current = idx;
      } else {
        setSelected([entry.path]);
        iconAnchor.current = idx;
      }
    },
    [visibleEntries]
  );

  /** 图标视图右键：命中条目则即时改选并构建条目菜单，空白处构建目录菜单（preventDefault 使 ContextualMenuTarget 静默） */
  const handleIconsContextMenu = useCallback(
    (e: ReactMouseEvent<HTMLDivElement>) => {
      const path = (e.target as HTMLElement).closest<HTMLElement>('[data-fm-item]')?.dataset.fmItem;
      if (path) {
        const hit = entryIndex.get(path);
        if (!hit) return;
        if (!selected.includes(path)) setSelected([path]);
        e.preventDefault();
        showContextMenu(buildItemMenu(selected.includes(path) ? selectedEntries : [hit]), [e.clientX, e.clientY]);
      } else {
        if (selected.length) setSelected([]);
        e.preventDefault();
        showContextMenu(buildDirMenu(), [e.clientX, e.clientY]);
      }
    },
    [entryIndex, selected, selectedEntries, showContextMenu, buildItemMenu, buildDirMenu]
  );

  const columns: Array<ClassicyTableColumn<FsEntry>> = useMemo(
    () => [
      {
        id: 'name',
        title: 'Name',
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
              <img src={displayIcon(r)} alt="" />
              {r.name}
            </span>
          </div>
        ),
      },
      {
        id: 'size',
        title: 'Size',
        accessor: (r) => (r.type === 'dir' ? -1 : r.size),
        align: 'right',
        width: 90,
        render: (r) => (r.type === 'dir' ? '—' : fmtBytes(r.size)),
      },
      {
        id: 'mtime',
        title: 'Modified',
        accessor: (r) => r.mtime,
        width: 150,
        render: (r) => (r.mtime ? fmtDate(r.mtime) : '—'),
      },
      {
        id: 'kind',
        title: 'Kind',
        accessor: (r) => kindFor(r),
        width: 120,
        render: (r) => <span title={`Permissions: ${r.mode}`}>{KIND_META[kindFor(r)].label}</span>,
      },
    ],
    [displayIcon]
  );

  /**
   * Edit 组（自建并内联实现）：操作对象是文件选择而非文本框，
   * 故不用 useClassicyEditMenu（AGENTS.md 菜单规范）。与右键菜单、快捷键三路等价。
   */
  const editMenuItems: ClassicyMenuItem[] = useMemo(
    () => [
      {
        id: 'fm-m-cut',
        title: 'Cut',
        keyboardShortcut: '⌘X',
        disabled: selectedEntries.length === 0,
        onClickFunc: () => setClipboardFor(selectedEntries, 'cut'),
      },
      {
        id: 'fm-m-copy',
        title: 'Copy',
        keyboardShortcut: '⌘C',
        disabled: selectedEntries.length === 0,
        onClickFunc: () => setClipboardFor(selectedEntries, 'copy'),
      },
      {
        id: 'fm-m-paste',
        title: 'Paste',
        keyboardShortcut: '⌘V',
        disabled: !clipboard || !current,
        onClickFunc: () => void doPaste(),
      },
      { id: 'spacer' },
      {
        id: 'fm-m-selectall',
        title: 'Select All',
        keyboardShortcut: '⌘A',
        disabled: visibleEntries.length === 0,
        onClickFunc: selectAllVisible,
      },
      { id: 'spacer' },
      {
        id: 'fm-m-delete',
        title: 'Delete…',
        keyboardShortcut: '⌘⌫',
        disabled: selectedEntries.length === 0,
        onClickFunc: () => requestDelete(selectedEntries),
      },
    ],
    [selectedEntries, clipboard, current, visibleEntries.length, setClipboardFor, doPaste, selectAllVisible, requestDelete]
  );

  const appMenu = useMemo(
    () => [
      {
        id: 'fm-app',
        title: APP_NAME,
        menuChildren: [aboutMenuItem, { id: 'spacer' }, quitMenuItem(APP_ID, APP_NAME, ICON)],
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
            onClickFunc: openNewFolderDialog,
          },
          { id: 'fm-m-newfile', title: 'New Text File…', disabled: !current, onClickFunc: openNewFileDialog },
          {
            id: 'fm-m-upload',
            title: 'Upload File…',
            disabled: !current,
            onClickFunc: () => fileInputRef.current?.click(),
          },
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
      {
        id: 'fm-edit',
        title: 'Edit',
        menuChildren: editMenuItems,
      },
      {
        id: 'fm-view',
        title: 'View',
        menuChildren: [
          {
            id: 'fm-m-icons',
            title: 'View as Icons',
            checked: viewMode === 'icons',
            onClickFunc: () => setViewMode('icons'),
          },
          {
            id: 'fm-m-list',
            title: 'View as List',
            checked: viewMode === 'list',
            onClickFunc: () => setViewMode('list'),
          },
          { id: 'spacer' },
          {
            id: 'fm-m-hidden',
            title: 'Show Hidden Files',
            checked: showHidden,
            onClickFunc: () => setShowHidden((v) => !v),
          },
          // checked:false 必须显式声明：classicy 仅对 checked!==undefined 的项渲染勾选列，
          // 同菜单混用会导致标题左起点不齐（无勾选列的项左移 21px）
          { id: 'fm-m-refresh', title: 'Refresh', checked: false, onClickFunc: () => void fetchDir(current) },
        ],
      },
      {
        id: 'fm-go',
        title: 'Go',
        menuChildren: [
          {
            id: 'fm-m-back',
            title: 'Back',
            keyboardShortcut: '⌘[',
            disabled: backStack.length === 0,
            onClickFunc: goBack,
          },
          {
            id: 'fm-m-parent',
            title: 'Open Parent Folder',
            keyboardShortcut: '⌘↑',
            disabled: !current,
            onClickFunc: goUp,
          },
        ],
      },
    ],
    [
      aboutMenuItem,
      editMenuItems,
      viewMode,
      showHidden,
      current,
      selectedEntries,
      backStack.length,
      setViewMode,
      fetchDir,
      openNewFolderDialog,
      openNewFileDialog,
      goBack,
      goUp,
    ]
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
        initialSize={['72%', '72%']}
        initialPosition={['center', 'center']}
        minimumSize={[680, 480]}
        appMenu={appMenu}
      >
        <ClassicyContextualMenuTarget menuItems={menuItems} className="sp-fm-ctx">
          <div className="sp-fm-main">
            {/* 窗口内工具栏带（规范 §3.2，与 WatchDog OS 共用 .sp-toolbar）：
                浅色容器带，与标题栏（窗口框线）、内容区（底部分隔线）均分开；
                按钮不属于内容流，不随内容滚动 */}
            <div className="sp-toolbar">
              <ClassicyButton disabled={backStack.length === 0} onClickFunc={goBack}>
                Back
              </ClassicyButton>
              <ClassicyButton disabled={!current} onClickFunc={goUp}>
                Up
              </ClassicyButton>
            </div>
            {loading && entries.length === 0 ? (
              <div className="sp-fm-empty sp-fm-empty-dir">Loading…</div>
            ) : visibleEntries.length === 0 ? (
              <div className="sp-fm-empty sp-fm-empty-dir">This folder is empty.</div>
            ) : viewMode === 'icons' ? (
              // 图标视图：大图标 + 下方名称（参考图 Workspace）；单击选择、双击打开
              <div
                className="sp-fm-icons"
                onClick={(e) => {
                  if ((e.target as HTMLElement).closest('[data-fm-item]')) return;
                  setSelected([]);
                  iconAnchor.current = -1;
                }}
                onContextMenu={handleIconsContextMenu}
              >
                {visibleEntries.map((entry, idx) => (
                  <div
                    key={entry.path}
                    data-fm-item={entry.path}
                    className={[
                      'sp-fm-icon',
                      selected.includes(entry.path) ? 'sp-fm-icon-selected' : '',
                      cutPaths?.has(entry.path) ? 'sp-fm-icon-cut' : '',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                    title={entry.type === 'dir' ? entry.name : `${entry.name} — ${fmtBytes(entry.size)}`}
                    onClick={(e) => handleIconClick(entry, idx, e)}
                    onDoubleClick={() => openEntry(entry)}
                  >
                    <img src={displayIcon(entry)} alt="" draggable={false} />
                    <span className="sp-fm-icon-label">{entry.name}</span>
                  </div>
                ))}
              </div>
            ) : (
              // 列表视图：名称/大小/修改时间/种类，目录行内联展开（双击/回车进目录）
              <div className="sp-fm-table">
                <ClassicyTable
                  columns={columns}
                  rows={tableRows}
                  getRowId={(r) => r.path}
                  selectionMode="multi"
                  selected={selected}
                  onSelectionChange={setSelected}
                  onActivateRow={(_id, row) => openEntry(row)}
                  defaultSort={{ columnId: 'name' }}
                  rowClassName={(r, sel) =>
                    sel ? 'sp-fm-row-selected' : cutPaths?.has(r.path) ? 'sp-fm-row-cut' : undefined
                  }
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
              </div>
            )}
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
                    <ClassicyBalloonHelp content="Cancel upload">
                      <ClassicyButton
                        buttonSize="small"
                        padding="sm"
                        margin="sm"
                        onClickFunc={() => abortRef.current.get(u.key)?.()}
                      >
                        ×
                      </ClassicyButton>
                    </ClassicyBalloonHelp>
                  </div>
                ))}
              </div>
            )}
          </div>
        </ClassicyContextualMenuTarget>

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
          title={dialog.kind === 'mkdir' ? 'New Folder' : dialog.kind === 'newfile' ? 'New Text File' : 'Rename'}
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
            // Escape 在对话框任意位置（含输入框内）取消并关闭
            onKeyDown={(e) => {
              if (e.key === 'Escape') setDialog(null);
            }}
          >
            <ClassicyInput
              id="fm-dialog-name"
              key={dialog.kind + dialog.value}
              prefillValue={dialog.value}
              labelTitle={dialog.kind === 'rename' ? 'New Name' : dialog.kind === 'newfile' ? 'File Name' : 'Name'}
              labelPosition="left"
              onChangeFunc={(e) => setDialogValue(e.target.value)}
            />
            <ClassicyFormButtonRow>
              <ClassicyButton onClickFunc={() => setDialog(null)}>Cancel</ClassicyButton>
              <ClassicyButton isDefault buttonType="submit">
                {dialog.kind === 'rename' ? 'Rename' : 'Create'}
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
          initialSize={[420, 0]}
          initialPosition={['center', 'center']}
          minimumSize={[380, 200]}
          onCloseFunc={() => setInfoEntry(null)}
        >
          <div className="sp-fm-info">
            {/* 头部：居中图标 + 名称（对齐参考图 About This Computer 结构） */}
            <div className="sp-fm-info-head">
              <img src={iconFor(infoEntry)} alt="" className="sp-fm-info-icon" />
              <span className="sp-fm-info-name">{infoEntry.name}</span>
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
            <div className="sp-fm-info-row">
              <span className="sp-fm-info-label">Path</span>
              <span className="sp-fm-info-value sp-fm-info-path" title={infoEntry.path}>
                {infoEntry.path}
              </span>
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
          setState({ loading: false, error: `Too large to preview (${fmtBytes(r.size)}). Text preview is limited to 2MB.`, content: '' });
        } else if (r.binary) {
          setState({ loading: false, error: 'Binary file — download it to open.', content: '' });
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

  // 预览窗口聚焦时的专属菜单：编辑/下载/视图切换在菜单栏
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
        title={`Preview · ${entry.name}`}
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
              <span className="sp-dim">Loading…</span>
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
