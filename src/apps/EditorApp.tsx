// 文本编辑器：CodeMirror 6 + 社区主题（Dracula / GitHub / VSCode）。
// 保存（Ctrl/Cmd+S）/ 撤销 / 重做 / 查找（Mod-F）/ Markdown 分栏预览；
// 全部偏好（主题/字号/字体/换行/预览）持久化到服务端 ~/.watchdog-os/data.json 的 editor 键，
// localStorage 仅作首屏兜底与升级迁移；编辑中的未保存内容自动缓存为草稿（/api/drafts），
// 意外退出后可从 File > Restore Draft… 或启动时的恢复对话框取回；支持从文件管理器联动打开（editorBridge）。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { redo, undo } from '@codemirror/commands';
import type { EditorView } from '@codemirror/view';
import {
  ClassicyAlert,
  ClassicyApp,
  ClassicyButton,
  ClassicyFileSystemEntryFileType,
  ClassicyInput,
  ClassicyPopUpMenu,
  ClassicySplitView,
  ClassicyWindow,
  useAppManager,
  useClassicyAboutMenu,
} from 'classicy';
import type { ClassicyMenuItem } from 'classicy';
import { classicyToHost } from '../hostFsAdapter';
import {
  draftsDeleteAll,
  draftsDeleteByPath,
  draftsGet,
  draftsList,
  draftsPut,
  fsRead,
  fsWrite,
  prefsGetEditor,
  prefsSetEditor,
  Unauthorized,
} from '../api';
import type { DraftEntry, EditorServerPrefs } from '../api';
import { CodeEditor } from '../components/CodeEditor';
import type { EditorThemeId } from '../editorThemes';
import { EDITOR_FONTS, EDITOR_THEMES } from '../editorThemes';
import {
  DEFAULT_PREFS,
  mergeServerPrefs,
  parseStoredPrefs,
  prefsNeedPush,
} from '../editorPrefs';
import type { EditorPrefs, PrefKey } from '../editorPrefs';
import { createDraftAutosave } from '../editorDraft';
import type { DraftAutosave } from '../editorDraft';
import { MarkdownPreview } from '../components/MarkdownPreview';
import { fmtBytes } from '../format';
import { useViewport } from '../responsive';
import { EDITOR_APP_ID, EDITOR_APP_NAME, EDITOR_ICON, EDITOR_OPEN_EVENT, EDITOR_WIN_ID, takePendingEditorPath } from '../editorBridge';
import { quitMenuItem } from '../quitMenuItem';

const PREFS_KEY = 'srv-editor-prefs';
const RECENT_KEY = 'srv-editor-recent';
const FONT_SIZES = [10, 12, 13, 14, 16, 18, 20, 24];
/* 与后端 DRAFT 上限 / FS_MAX_TEXT 对齐：超过 2MB 的文件本来也打不开，粘贴超限时跳过缓存 */
const DRAFT_MAX_CHARS = 2 * 1024 * 1024;

/* 首屏兜底：localStorage 里上次的偏好（服务端值到达前先渲染，避免闪烁） */
function loadPrefs(): EditorPrefs {
  try {
    return parseStoredPrefs(localStorage.getItem(PREFS_KEY));
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

function loadRecent(): string[] {
  try {
    const j = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
    return Array.isArray(j) ? j.filter((x) => typeof x === 'string').slice(0, 8) : [];
  } catch {
    return [];
  }
}

const isMdPath = (p: string) => /\.(md|markdown|mdx)$/i.test(p);

function baseName(p: string): string {
  const norm = p.replace(/[\\/]+$/, '');
  const i = Math.max(norm.lastIndexOf('\\'), norm.lastIndexOf('/'));
  return i >= 0 ? norm.slice(i + 1) : norm;
}

function fmtTime(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 草稿可能跨天，列表里带日期 */
function fmtDateTime(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${fmtTime(ms)}`;
}

/** 恢复来源的提示信息 */
interface RestoredInfo {
  /** 草稿写入时间 */
  at: number;
  /** 草稿基于的版本与磁盘当前版本不一致（保存会覆盖别人的改动） */
  diskChanged: boolean;
  /** 源文件读不到（已删除 / 无权限），保存会直接写入原路径 */
  unreadable: boolean;
}

export function EditorApp({ onLogout }: { onLogout: () => void }) {
  // 分栏方向随视口：手机上左右双栏各自不足 200px（minPaneSize），改上下堆叠；
  // ClassicySplitView 用内联 flex-basis 百分比排布，纯 CSS 无法可靠改轴，只能由 JS 传参
  const { layout } = useViewport();
  const splitDirection = layout === 'mobile' ? 'vertical' : 'horizontal';
  const [prefs, setPrefs] = useState<EditorPrefs>(loadPrefs);
  const [path, setPath] = useState('');
  const [content, setContent] = useState('');
  /* 与磁盘一致的版本：dirty 由 content !== baseline 派生。
     不再用布尔脏标记——CodeMirror 的外部 value 同步会触发一次 onChange，
     布尔标记会被"打开文件"这个动作本身误置为 true（并生成一份无意义的草稿）。 */
  const [baseline, setBaseline] = useState('');
  const [baseMtime, setBaseMtime] = useState<number | null>(null);
  /* 整篇替换（打开 / 恢复 / 丢弃）时 +1，作为 CodeEditor 的 key 重建 EditorState：
     否则撤销栈会跨文档存活（在 B 里 undo 会把 A 的编辑片段插进来） */
  const [docSeq, setDocSeq] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [stats, setStats] = useState({ line: 1, col: 1, size: 0 });
  const [openDialog, setOpenDialog] = useState(false);
  const [openInput, setOpenInput] = useState('');
  const [recent, setRecent] = useState<string[]>(loadRecent);
  const [confirmClose, setConfirmClose] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [draftError, setDraftError] = useState(false);
  const [restored, setRestored] = useState<RestoredInfo | null>(null);
  const [recoverOpen, setRecoverOpen] = useState(false);
  const [draftList, setDraftList] = useState<DraftEntry[]>([]);
  const [draftSel, setDraftSel] = useState<string | null>(null);
  const [draftBusy, setDraftBusy] = useState(false);
  const [confirmDiscardAll, setConfirmDiscardAll] = useState(false);
  /* 偏好同步状态：hydrated 必须参与推送 effect 的依赖——只放在 ref 里的话，
     "GET 还没回来就先改了偏好"这一帧会直接 return，之后 ref 变了也不会重跑，改动永远不落盘 */
  const [prefsHydrated, setPrefsHydrated] = useState(false);
  const [prefsFile, setPrefsFile] = useState('');
  const [prefsSync, setPrefsSync] = useState<'idle' | 'saving' | 'error'>('idle');

  const viewRef = useRef<EditorView | null>(null);
  const closeResolveRef = useRef<((ok: boolean) => void) | null>(null);
  /* 偏好同步状态：pushed=最近一次已知的服务端快照（推送去重）；
     mutated=用户亲自改过的字段集合（hydration 只跳过这些字段，不再整轮放弃） */
  const prefsPushedRef = useRef<EditorServerPrefs>({});
  const prefsMutatedRef = useRef<Set<PrefKey>>(new Set());
  /* 自动草稿：实例在挂载时创建；draftPathRef 记录"当前确实写过草稿"的路径，
     避免打开一个已存在草稿的文件时把它误删 */
  const autosaveRef = useRef<DraftAutosave | null>(null);
  const draftPathRef = useRef<string | null>(null);
  const promptedRef = useRef(false);

  const dirty = path !== '' && content !== baseline;

  const { aboutMenuItem, aboutWindow } = useClassicyAboutMenu(EDITOR_APP_ID, EDITOR_APP_NAME, EDITOR_ICON);

  // 401 只做本地收尾（清会话存储 + 回登录页），**不再**发 /api/logout（见 src/session.ts）
  const handleLogout = useCallback(() => onLogout(), [onLogout]);

  /* 偏好变更入口：按字段标记"本地已改"，hydration 时这些字段以本地为准 */
  const updatePrefs = useCallback((patch: Partial<EditorPrefs>) => {
    for (const k of Object.keys(patch)) prefsMutatedRef.current.add(k as PrefKey);
    setPrefs((p) => ({ ...p, ...patch }));
  }, []);

  /* ---------- 自动草稿 ---------- */

  useEffect(() => {
    const a = createDraftAutosave({
      write: (p) => draftsPut(p.path, p.content, p.baseMtime),
      remove: (p) => draftsDeleteByPath(p),
      onError: (e) => {
        // null = 从失败恢复；401 已由 api 层触发全局登出，不额外提示
        if (e === null) setDraftError(false);
        else if (!(e instanceof Unauthorized)) setDraftError(true);
      },
    });
    autosaveRef.current = a;
    return () => {
      // 关窗不会卸载本组件（classicy 只隐藏窗口），这里只在页面卸载 / 登出重载时执行
      void a.flush();
      a.dispose();
      autosaveRef.current = null;
    };
  }, []);

  // 页面隐藏 / 刷新时尽力落盘：2s 防抖窗口内的最后几个字不至于丢
  useEffect(() => {
    const flush = () => {
      void autosaveRef.current?.flush();
    };
    const onVis = () => {
      if (document.visibilityState === 'hidden') flush();
    };
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('pagehide', flush);
    return () => {
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('pagehide', flush);
    };
  }, []);

  // 内容变化 → 调度草稿；回到基线（保存成功 / undo 回保存点）→ 删掉该文件的草稿
  useEffect(() => {
    const a = autosaveRef.current;
    if (!a || !path) return;
    if (content === baseline) {
      if (draftPathRef.current === path) {
        a.discard(path);
        draftPathRef.current = null;
      }
      return;
    }
    if (content.length > DRAFT_MAX_CHARS) {
      setDraftError(true);
      return;
    }
    draftPathRef.current = path;
    a.schedule({ path, content, baseMtime });
  }, [path, content, baseline, baseMtime]);

  /* ---------- 打开 / 保存 ---------- */

  /** 统一的"载入一份文档"入口：整篇替换 + 重建编辑器（撤销栈不跨文档）。
   *  baseline 默认等于正文（正常打开）；恢复草稿时传磁盘内容，正文与基线不同即自然变成"未保存"。 */
  const openDoc = useCallback(
    (nextPath: string, nextContent: string, mtime: number | null, nextBaseline: string = nextContent) => {
      setPath(nextPath);
      setContent(nextContent);
      setBaseline(nextBaseline);
      setBaseMtime(mtime);
      setSavedAt(null);
      setRestored(null);
      setDocSeq((n) => n + 1);
    },
    []
  );

  const loadFile = useCallback(
    async (p: string) => {
      const target = p.trim();
      if (!target) return;
      setLoading(true);
      setError('');
      try {
        // 先把当前文档还没落盘的草稿写完，再切换（否则旧文档最后几秒的改动会丢）
        await autosaveRef.current?.flush();
        const r = await fsRead(target);
        if (r.tooLarge) {
          setError(`文件过大（${fmtBytes(r.size)}），仅支持编辑 2MB 以内文本`);
          return;
        }
        if (r.binary) {
          setError('二进制文件，无法以文本方式编辑');
          return;
        }
        openDoc(r.path, r.content ?? '', r.mtime);
        // Markdown 文件自动开启预览；非 Markdown 保持用户当前选择（记住状态）
        if (isMdPath(r.path)) updatePrefs({ showPreview: true });
        setOpenDialog(false);
        setRecent((prev) => {
          const next = [r.path, ...prev.filter((x) => x !== r.path)].slice(0, 8);
          try {
            localStorage.setItem(RECENT_KEY, JSON.stringify(next));
          } catch {
            // localStorage 不可用时忽略
          }
          return next;
        });
      } catch (e) {
        if (e instanceof Unauthorized) return handleLogout();
        setError(`打开失败：${(e as Error).message}`);
      } finally {
        setLoading(false);
      }
    },
    [handleLogout, openDoc, updatePrefs]
  );

  const save = useCallback(async (): Promise<boolean> => {
    if (!path) return false;
    // await 前快照：保存期间继续输入时，不能把新输入也当成已保存
    const snapshot = content;
    const wasDirty = snapshot !== baseline;
    try {
      const r = await fsWrite(path, snapshot);
      setBaseline(snapshot);
      setBaseMtime(r.mtime);
      setSavedAt(Date.now());
      setError('');
      setRestored(null);
      // 只在"确实写入了未保存改动"时清草稿：对无改动的文件按 Ctrl+S 不该顺手删掉历史草稿
      if (wasDirty) {
        autosaveRef.current?.discard(path);
        draftPathRef.current = null;
      }
      return true;
    } catch (e) {
      if (e instanceof Unauthorized) {
        handleLogout();
        return false;
      }
      setError(`保存失败：${(e as Error).message}`);
      return false;
    }
  }, [path, content, baseline, handleLogout]);

  // Ctrl/Cmd+S 保存
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void save();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [save]);

  // 文件管理器联动：挂载即消费待打开路径；已挂载时监听 DOM 事件
  useEffect(() => {
    const p = takePendingEditorPath();
    if (p) void loadFile(p);
    const onOpen = (e: Event) => {
      const detail = (e as CustomEvent<{ path?: string }>).detail;
      if (detail?.path) void loadFile(detail.path);
    };
    window.addEventListener(EDITOR_OPEN_EVENT, onOpen);
    return () => window.removeEventListener(EDITOR_OPEN_EVENT, onOpen);
  }, [loadFile]);

  // 内置 Finder（Macintosh HD）双击联动：本应用注册了 text_file/markdown 处理器后，
  // classicy 的通用兜底会把路径（classicy 冒号路径）写入本应用 data.openFiles 并打开窗口；
  // 这里监视新增项，还原宿主机路径后加载。首次快照只记为已处理（可能是上个会话残留），
  // 只响应本会话内的新增双击，避免启动即自动打开旧文件。
  const openFiles = useAppManager(
    (s) => s.System.Manager.Applications.apps[EDITOR_APP_ID]?.data?.openFiles
  ) as string[] | undefined;
  const seenOpenFilesRef = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!Array.isArray(openFiles)) return;
    if (seenOpenFilesRef.current === null) {
      seenOpenFilesRef.current = new Set(openFiles);
      return;
    }
    for (const p of openFiles) {
      if (seenOpenFilesRef.current.has(p)) continue;
      seenOpenFilesRef.current.add(p);
      void loadFile(classicyToHost(p) ?? p);
    }
  }, [openFiles, loadFile]);

  /* ---------- 恢复草稿 ---------- */

  const fetchDrafts = useCallback(async (): Promise<DraftEntry[]> => {
    const r = await draftsList();
    setDraftList(r.drafts);
    setDraftSel(r.drafts[0]?.id ?? null);
    return r.drafts;
  }, []);

  const openRecovery = useCallback(() => {
    setRecoverOpen(true);
    setDraftBusy(true);
    fetchDrafts()
      .catch((e) => {
        if (e instanceof Unauthorized) handleLogout();
        else setError(`读取草稿失败：${(e as Error).message}`);
      })
      .finally(() => setDraftBusy(false));
  }, [fetchDrafts, handleLogout]);

  // 窗口首次打开时提醒一次（本页面会话内不再重复弹）；刷新后草稿仍在会再提醒
  const editorOpen = useAppManager((s) => s.System.Manager.Applications.apps[EDITOR_APP_ID]?.open) as
    | boolean
    | undefined;
  /* path 的即时镜像：下面要延迟判断"是不是刚被 Finder 直接打开了一个文件"，
     用 state 会拿到闭包里的旧值 */
  const pathRef = useRef('');
  useEffect(() => {
    pathRef.current = path;
  }, [path]);
  useEffect(() => {
    if (!editorOpen || promptedRef.current) return;
    let cancelled = false;
    // 稍等一拍再判断：双击文本文件打开编辑器时，loadFile 与本 effect 同时起跑，
    // 若已有文件在载入就不要再用草稿盖上去（用户可随时走 File > Restore Draft…）
    const timer = setTimeout(() => {
      if (cancelled || promptedRef.current) return;
      promptedRef.current = true;
      if (pathRef.current) return;
      draftsList()
        .then((r) => {
          if (cancelled || r.drafts.length === 0) return;
          setDraftList(r.drafts);
          setDraftSel(r.drafts[0].id);
          setRecoverOpen(true);
        })
        .catch((e) => {
          if (e instanceof Unauthorized) handleLogout();
        });
    }, 600);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [editorOpen, handleLogout]);

  const restoreDraft = useCallback(
    async (entry: DraftEntry) => {
      setDraftBusy(true);
      try {
        const full = await draftsGet(entry.id);
        await autosaveRef.current?.flush();
        let diskContent = '';
        let diskMtime: number | null = null;
        let unreadable = false;
        let diskChanged = false;
        try {
          const r = await fsRead(entry.path);
          if (r.tooLarge || r.binary) throw new Error('源文件不可编辑');
          diskContent = r.content ?? '';
          diskMtime = r.mtime;
          diskChanged = full.baseMtime != null && r.mtime !== full.baseMtime;
        } catch (e) {
          if (e instanceof Unauthorized) {
            handleLogout();
            return;
          }
          unreadable = true;
        }
        // 草稿与磁盘完全一致：没有任何可恢复的内容，顺手清掉这条草稿
        if (!unreadable && full.content === diskContent) {
          draftPathRef.current = null;
          void draftsDeleteByPath(entry.path).catch(() => {});
          openDoc(entry.path, diskContent, diskMtime);
          setRecoverOpen(false);
          return;
        }
        openDoc(entry.path, full.content, diskMtime, diskContent);
        setRestored({ at: full.updatedAt, diskChanged, unreadable });
        setRecoverOpen(false);
        // 恢复出来的内容就是"未保存改动"：后续自动缓存继续覆盖这份草稿
        draftPathRef.current = entry.path;
        if (isMdPath(entry.path)) updatePrefs({ showPreview: true });
      } catch (e) {
        if (e instanceof Unauthorized) handleLogout();
        else setError(`恢复失败：${(e as Error).message}`);
      } finally {
        setDraftBusy(false);
      }
    },
    [handleLogout, openDoc, updatePrefs]
  );

  /** 丢弃当前文档的草稿并回退到磁盘版本 */
  const discardRestored = useCallback(() => {
    if (!path) return;
    autosaveRef.current?.discard(path);
    draftPathRef.current = null;
    setContent(baseline);
    setDocSeq((n) => n + 1);
    setRestored(null);
  }, [path, baseline]);

  /* ---------- 偏好持久化 ---------- */

  // localStorage 只作首屏兜底与升级迁移载体（服务端不可用时至少保留本机外观）
  useEffect(() => {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    } catch {
      // localStorage 不可用时忽略
    }
  }, [prefs]);

  // hydration：挂载即拉取服务端值。逐字段处理——用户已亲自改过的字段以本地为准，
  // 其余字段一律采用服务端值（含首屏兜底里没有的 theme/fontSize/fontFamily）。
  // 失败重试一次；仍失败也要放开 hydrated，让后续变更走推送（否则本地改动永远不落盘）。
  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const r = await prefsGetEditor();
          if (cancelled) return;
          const s = r.editor || {};
          if (typeof r.file === 'string' && r.file) setPrefsFile(r.file);
          prefsPushedRef.current = s;
          setPrefs((p) => mergeServerPrefs(p, s, prefsMutatedRef.current));
          setPrefsHydrated(true);
          return;
        } catch (e) {
          if (cancelled) return;
          if (e instanceof Unauthorized) {
            handleLogout();
            return;
          }
          if (attempt === 0) {
            await new Promise((r) => setTimeout(r, 1500));
            if (cancelled) return;
          }
        }
      }
      if (!cancelled) setPrefsHydrated(true);
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [handleLogout]);

  // 推送：与服务端快照相同则跳过；服务端缺该键时只有"非默认值"才推（从未动过设置 = 零写盘）。
  // 失败重试一次，仍失败则置 error（设置面板可见），下次变更自动再试。
  useEffect(() => {
    if (!prefsHydrated) return;
    if (!prefsNeedPush(prefs, prefsPushedRef.current)) return;
    let cancelled = false;
    const push = async () => {
      setPrefsSync('saving');
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const r = await prefsSetEditor(prefs);
          if (cancelled) return;
          prefsPushedRef.current = r.editor || {};
          setPrefsSync('idle');
          return;
        } catch (e) {
          if (cancelled) return;
          if (e instanceof Unauthorized) return;
          if (attempt === 0) {
            await new Promise((r) => setTimeout(r, 1200));
            if (cancelled) return;
          }
        }
      }
      if (!cancelled) setPrefsSync('error');
    };
    void push();
    return () => {
      cancelled = true;
    };
  }, [prefs, prefsHydrated, handleLogout]);

  /* ---------- 关闭 / 菜单 ---------- */

  // 关闭拦截：未保存时弹确认（Promise veto）
  const beforeClose = useCallback(() => {
    if (!dirty) return true;
    return new Promise<boolean>((resolve) => {
      closeResolveRef.current = resolve;
      setConfirmClose(true);
    });
  }, [dirty]);

  const settleClose = useCallback((ok: boolean) => {
    const r = closeResolveRef.current;
    closeResolveRef.current = null;
    setConfirmClose(false);
    r?.(ok);
  }, []);

  const doOpen = useCallback(() => {
    setOpenDialog(false);
    void loadFile(openInput);
  }, [loadFile, openInput]);

  const isMd = isMdPath(path);

  const appMenu: ClassicyMenuItem[] = useMemo(
    () => [
      {
        id: 'ed-app',
        title: EDITOR_APP_NAME,
        menuChildren: [
          aboutMenuItem,
          { id: 'spacer' },
          { id: 'ed-m-prefs', title: 'Editor Settings…', onClickFunc: () => setSettingsOpen(true) },
          { id: 'spacer' },
          quitMenuItem(EDITOR_APP_ID, EDITOR_APP_NAME, EDITOR_ICON),
        ],
      },
      {
        id: 'ed-file',
        title: 'File',
        menuChildren: [
          {
            id: 'ed-m-open',
            title: 'Open…',
            keyboardShortcut: '⌘O',
            onClickFunc: () => {
              setOpenInput(path);
              setOpenDialog(true);
            },
          },
          { id: 'ed-m-save', title: 'Save', keyboardShortcut: '⌘S', onClickFunc: () => void save() },
          { id: 'spacer' },
          { id: 'ed-m-restore', title: 'Restore Draft…', onClickFunc: openRecovery },
        ],
      },
      {
        // CodeMirror 自管撤销/重做栈，非标准文本框，按规范例外条款自建并内联实现
        id: 'ed-edit',
        title: 'Edit',
        menuChildren: [
          { id: 'ed-m-undo', title: 'Undo', keyboardShortcut: '⌘Z', onClickFunc: () => viewRef.current && undo(viewRef.current) },
          { id: 'ed-m-redo', title: 'Redo', keyboardShortcut: '⇧⌘Z', onClickFunc: () => viewRef.current && redo(viewRef.current) },
        ],
      },
      {
        id: 'ed-view',
        title: 'View',
        menuChildren: [
          { id: 'ed-m-wrap', title: 'Word Wrap', checked: prefs.wordWrap, onClickFunc: () => updatePrefs({ wordWrap: !prefs.wordWrap }) },
          { id: 'ed-m-preview', title: 'Show Preview', checked: prefs.showPreview, onClickFunc: () => updatePrefs({ showPreview: !prefs.showPreview }) },
        ],
      },
    ],
    [aboutMenuItem, path, save, updatePrefs, prefs.wordWrap, prefs.showPreview, openRecovery]
  );

  const editorNode = (
    <CodeEditor
      key={docSeq}
      path={path}
      value={content}
      onChange={(v) => setContent(v)}
      theme={prefs.theme}
      fontSize={prefs.fontSize}
      fontFamily={prefs.fontFamily}
      wordWrap={prefs.wordWrap}
      onReady={(v) => (viewRef.current = v)}
      onStats={setStats}
      className="sp-editor-code"
    />
  );

  const selectedDraft = draftList.find((d) => d.id === draftSel) ?? null;

  return (
    <ClassicyApp
      id={EDITOR_APP_ID}
      name={EDITOR_APP_NAME}
      icon={EDITOR_ICON}
      defaultWindow={EDITOR_WIN_ID}
      // 注册为文本类文件的处理器：内置 Finder（Macintosh HD）双击文本/markdown 时路由到本应用
      handlesFileTypes={[ClassicyFileSystemEntryFileType.TextFile, ClassicyFileSystemEntryFileType.Markdown]}
    >
      <ClassicyWindow
        id={EDITOR_WIN_ID}
        title={`${dirty ? '● ' : ''}${path ? baseName(path) + ' — ' : ''}${EDITOR_APP_NAME}`}
        icon={EDITOR_ICON}
        appId={EDITOR_APP_ID}
        scrollable={false}
        resizable
        zoomable
        collapsable
        closable
        initialSize={[880, 620]}
        initialPosition={['center', 'center']}
        minimumSize={[620, 420]}
        appMenu={appMenu}
        onBeforeClose={beforeClose}
      >
        <div className="sp-editor">
          {restored && path && (
            <div className={`sp-editor-banner${restored.diskChanged || restored.unreadable ? ' sp-editor-banner-warn' : ''}`}>
              <span className="sp-editor-banner-text" title={path}>
                {`已从缓存恢复（${fmtDateTime(restored.at)}）`}
                {restored.unreadable
                  ? ' · 源文件不可读或已删除，保存将直接写入该路径'
                  : restored.diskChanged
                    ? ' · 源文件在缓存后已被修改，保存将覆盖磁盘上的新版本'
                    : ' · 磁盘文件未改动'}
              </span>
              <span className="sp-editor-banner-actions">
                <ClassicyButton onClickFunc={() => void save()}>保存到文件</ClassicyButton>
                <ClassicyButton onClickFunc={discardRestored}>丢弃草稿</ClassicyButton>
              </span>
            </div>
          )}

          {!path && !loading ? (
            <div className="sp-editor-empty">
              <span>{error ? <span className="sp-pulse">{error}</span> : '未打开文件'}</span>
              <ClassicyButton
                isDefault
                onClickFunc={() => {
                  setOpenInput('');
                  setOpenDialog(true);
                }}
              >
                打开文件…
              </ClassicyButton>
            </div>
          ) : prefs.showPreview ? (
            <ClassicySplitView direction={splitDirection} defaultSizes={[55, 45]} minPaneSize={200} className="sp-editor-body">
              {editorNode}
              <div className="sp-editor-preview">
                {isMd ? (
                  <MarkdownPreview source={content} docPath={path || undefined} />
                ) : (
                  <pre className="sp-editor-plain">{content}</pre>
                )}
              </div>
            </ClassicySplitView>
          ) : (
            <div className="sp-editor-body">{editorNode}</div>
          )}

          <div className="sp-editor-status">
            <span title={path}>
              {dirty ? '● ' : ''}
              {path || '未打开文件'}
            </span>
            <span>
              {loading
                ? '加载中…'
                : path
                  ? `${stats.line}:${stats.col} · ${fmtBytes(stats.size)}${savedAt ? ` · 已保存 ${fmtTime(savedAt)}` : ''}${
                      draftError ? ' · 草稿未缓存' : ''
                    }${error ? ` · ${error}` : ''}`
                  : ''}
            </span>
          </div>
        </div>

        {confirmClose && (
          <ClassicyAlert
            appId={EDITOR_APP_ID}
            alertType="caution"
            label="未保存的更改"
            message="文档包含未保存的修改，关闭前是否保存？选择「不保存」会保留一份草稿，可从 File > Restore Draft… 取回。"
            buttons={[
              { id: 'ed-save-close', label: '保存并关闭', role: 'default', onClick: () => void (async () => { const ok = await save(); settleClose(ok); })() },
              {
                id: 'ed-discard',
                label: '不保存',
                role: 'normal',
                // 关窗不卸载组件，但先把草稿落盘再放行，避免"最后 2 秒"的输入丢失
                onClick: () => void (async () => { await autosaveRef.current?.flush(); settleClose(true); })(),
              },
              { id: 'ed-cancel', label: '取消', role: 'cancel', onClick: () => settleClose(false) },
            ]}
            onClose={() => settleClose(false)}
          />
        )}

        {openDialog && (
          <div
            className="sp-dialog-mask"
            onMouseDown={(e) => {
              if (e.target === e.currentTarget) setOpenDialog(false);
            }}
          >
            <div className="sp-dialog">
              <div className="sp-dialog-title">打开文件</div>
              <div className="sp-dialog-body">
                <ClassicyInput
                  id="ed-open-path"
                  placeholder="/etc/nginx/nginx.conf"
                  prefillValue={openInput}
                  onChangeFunc={(e) => setOpenInput(e.target.value)}
                  onEnterFunc={doOpen}
                />
                {recent.length > 0 && (
                  <div className="sp-dialog-recent">
                    <div className="sp-fm-side-title">最近打开</div>
                    {recent.map((r) => (
                      <button key={r} type="button" className="sp-fm-fav-btn" title={r} onClick={() => void loadFile(r)}>
                        <img src={EDITOR_ICON} alt="" />
                        <span>{r}</span>
                      </button>
                    ))}
                  </div>
                )}
                <div className="sp-dialog-actions">
                  <ClassicyButton onClickFunc={() => setOpenDialog(false)}>取消</ClassicyButton>
                  <ClassicyButton isDefault onClickFunc={doOpen}>
                    打开
                  </ClassicyButton>
                </div>
              </div>
            </div>
          </div>
        )}

        {recoverOpen && (
          <div
            className="sp-dialog-mask"
            onMouseDown={(e) => {
              if (e.target === e.currentTarget) setRecoverOpen(false);
            }}
          >
            <div className="sp-dialog sp-dialog-wide">
              <div className="sp-dialog-title">恢复草稿</div>
              <div className="sp-dialog-body">
                {draftBusy && draftList.length === 0 ? (
                  <div className="sp-draft-empty">正在读取草稿…</div>
                ) : draftList.length === 0 ? (
                  <div className="sp-draft-empty">没有未保存的草稿。</div>
                ) : (
                  <>
                    <div className="sp-draft-hint">以下内容尚未写入文件，选择一份恢复到编辑器：</div>
                    <div className="sp-draft-list">
                      {draftList.map((d) => (
                        <button
                          key={d.id}
                          type="button"
                          className={`sp-draft-row${draftSel === d.id ? ' on' : ''}`}
                          onClick={() => setDraftSel(d.id)}
                          onDoubleClick={() => void restoreDraft(d)}
                        >
                          <span className="sp-draft-name">{d.name}</span>
                          <span className="sp-draft-meta">
                            {fmtDateTime(d.updatedAt)} · {fmtBytes(d.size)}
                          </span>
                          <span className="sp-draft-path" title={d.path}>
                            {d.path}
                          </span>
                          {!d.disk.exists ? (
                            <span className="sp-draft-warn">源文件已删除</span>
                          ) : d.baseMtime != null && d.disk.mtime !== d.baseMtime ? (
                            <span className="sp-draft-warn">源文件已变更</span>
                          ) : null}
                        </button>
                      ))}
                    </div>
                  </>
                )}
                <div className="sp-dialog-actions">
                  <ClassicyButton onClickFunc={() => setRecoverOpen(false)}>取消</ClassicyButton>
                  {draftList.length > 0 && (
                    <ClassicyButton onClickFunc={() => setConfirmDiscardAll(true)}>全部丢弃…</ClassicyButton>
                  )}
                  <ClassicyButton isDefault onClickFunc={() => selectedDraft && void restoreDraft(selectedDraft)}>
                    恢复
                  </ClassicyButton>
                </div>
              </div>
            </div>
          </div>
        )}

        {confirmDiscardAll && (
          <ClassicyAlert
            appId={EDITOR_APP_ID}
            alertType="caution"
            label="丢弃全部草稿"
            message="所有未保存的草稿将被永久删除，无法恢复。"
            buttons={[
              {
                id: 'ed-da-ok',
                label: '丢弃全部',
                role: 'normal',
                onClick: () =>
                  void (async () => {
                    try {
                      await draftsDeleteAll();
                      setDraftList([]);
                      setDraftSel(null);
                      setConfirmDiscardAll(false);
                      setRecoverOpen(false);
                      draftPathRef.current = null;
                      setRestored(null);
                    } catch (e) {
                      if (e instanceof Unauthorized) handleLogout();
                      else setError(`丢弃失败：${(e as Error).message}`);
                    }
                  })(),
              },
              { id: 'ed-da-cancel', label: '取消', role: 'cancel', onClick: () => setConfirmDiscardAll(false) },
            ]}
            onClose={() => setConfirmDiscardAll(false)}
          />
        )}

        {settingsOpen && (
          <div
            className="sp-dialog-mask"
            onMouseDown={(e) => {
              if (e.target === e.currentTarget) setSettingsOpen(false);
            }}
          >
            <div className="sp-dialog">
              <div className="sp-dialog-title">编辑器设置</div>
              <div className="sp-dialog-body">
                <div className="sp-dialog-field">
                  <label htmlFor="ed-set-theme">主题</label>
                  <ClassicyPopUpMenu
                    id="ed-set-theme"
                    options={EDITOR_THEMES.map((t) => ({ value: t.id, label: t.label }))}
                    selected={prefs.theme}
                    onChangeFunc={(e) => updatePrefs({ theme: e.target.value as EditorThemeId })}
                  />
                </div>
                <div className="sp-dialog-field">
                  <label htmlFor="ed-set-fsize">字号</label>
                  <ClassicyPopUpMenu
                    id="ed-set-fsize"
                    options={FONT_SIZES.map((n) => ({ value: String(n), label: `${n}px` }))}
                    selected={String(prefs.fontSize)}
                    onChangeFunc={(e) => updatePrefs({ fontSize: parseInt(e.target.value, 10) })}
                  />
                </div>
                <div className="sp-dialog-field">
                  <label htmlFor="ed-set-font">字体</label>
                  <ClassicyPopUpMenu
                    id="ed-set-font"
                    options={EDITOR_FONTS.map((f) => ({ value: f.value, label: f.label }))}
                    selected={prefs.fontFamily}
                    onChangeFunc={(e) => updatePrefs({ fontFamily: e.target.value })}
                  />
                </div>
                <div className="sp-dialog-note">
                  {prefsSync === 'error'
                    ? '偏好保存失败，下次修改会自动重试'
                    : prefsSync === 'saving'
                      ? '正在保存偏好…'
                      : prefsFile
                        ? `偏好已保存到 ${prefsFile}`
                        : '偏好保存到用户目录 ~/.watchdog-os/data.json'}
                </div>
                <div className="sp-dialog-actions">
                  <ClassicyButton isDefault onClickFunc={() => setSettingsOpen(false)}>
                    完成
                  </ClassicyButton>
                </div>
              </div>
            </div>
          </div>
        )}
      </ClassicyWindow>
      {aboutWindow}
    </ClassicyApp>
  );
}
