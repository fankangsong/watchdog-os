// 文本编辑器：CodeMirror 6 + 社区主题（Dracula / GitHub / VSCode）。
// 保存（Ctrl/Cmd+S）/ 撤销 / 重做 / 查找（Mod-F）/ Markdown 分栏预览；
// 主题/字号/字体偏好持久化 localStorage；Word Wrap 与 Show Preview 持久化到服务端
// （~/.watchdog-os/data.json 的 editor 键，跨浏览器/重部署生效）；支持从文件管理器联动打开（editorBridge）。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { redo, undo } from '@codemirror/commands';
import type { EditorView } from '@codemirror/view';
import {
  ClassicyAlert,
  ClassicyApp,
  ClassicyButton,
  ClassicyInput,
  ClassicyPopUpMenu,
  ClassicySplitView,
  ClassicyWindow,
  useClassicyAboutMenu,
} from 'classicy';
import type { ClassicyMenuItem } from 'classicy';
import { fsRead, fsWrite, logout, prefsGetEditor, prefsSetEditor, Unauthorized } from '../api';
import type { EditorServerPrefs } from '../api';
import { CodeEditor, EDITOR_FONTS, EDITOR_THEMES } from '../components/CodeEditor';
import type { EditorThemeId } from '../components/CodeEditor';
import { MarkdownPreview } from '../components/MarkdownPreview';
import { fmtBytes } from '../format';
import { EDITOR_APP_ID, EDITOR_APP_NAME, EDITOR_ICON, EDITOR_OPEN_EVENT, EDITOR_WIN_ID, takePendingEditorPath } from '../editorBridge';
import { quitMenuItem } from '../quitMenuItem';

const PREFS_KEY = 'srv-editor-prefs';
const RECENT_KEY = 'srv-editor-recent';
const FONT_SIZES = [10, 12, 13, 14, 16, 18, 20, 24];

/* 本地偏好：仅存当前浏览器（localStorage） */
interface EditorPrefs {
  theme: EditorThemeId;
  fontSize: number;
  fontFamily: string;
}

/* 视图偏好：服务端持久化（data.json 的 editor 键） */
interface EditorViewPrefs {
  wordWrap: boolean;
  showPreview: boolean;
}

const VIEW_PREFS_DEF: EditorViewPrefs = { wordWrap: false, showPreview: false };

function loadPrefs(): EditorPrefs {
  const def: EditorPrefs = { theme: 'dracula', fontSize: 14, fontFamily: EDITOR_FONTS[0].value };
  try {
    const j = JSON.parse(localStorage.getItem(PREFS_KEY) || '');
    return {
      theme: EDITOR_THEMES.some((t) => t.id === j.theme) ? j.theme : def.theme,
      fontSize: Math.min(24, Math.max(10, parseInt(j.fontSize, 10) || def.fontSize)),
      fontFamily: typeof j.fontFamily === 'string' ? j.fontFamily : def.fontFamily,
    };
  } catch {
    return def;
  }
}

/* 视图偏好初始值：同步读旧 localStorage 的 wordWrap/showPreview（升级迁移的载体——
   服务端无记录时保持该值，首次变更即自动落盘；从未设置过时为默认值，
   与服务端空记录聚合后一致，不会产生无谓的首次写入） */
function loadViewPrefs(): EditorViewPrefs {
  try {
    const j = JSON.parse(localStorage.getItem(PREFS_KEY) || '');
    return {
      wordWrap: typeof j.wordWrap === 'boolean' ? j.wordWrap : VIEW_PREFS_DEF.wordWrap,
      showPreview: typeof j.showPreview === 'boolean' ? j.showPreview : VIEW_PREFS_DEF.showPreview,
    };
  } catch {
    return { ...VIEW_PREFS_DEF };
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

export function EditorApp({ onLogout }: { onLogout: () => void }) {
  const [prefs, setPrefs] = useState<EditorPrefs>(loadPrefs);
  const [viewPrefs, setViewPrefs] = useState<EditorViewPrefs>(loadViewPrefs);
  const [path, setPath] = useState('');
  const [content, setContent] = useState('');
  const [dirty, setDirty] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [stats, setStats] = useState({ line: 1, col: 1, size: 0 });
  const [openDialog, setOpenDialog] = useState(false);
  const [openInput, setOpenInput] = useState('');
  const [recent, setRecent] = useState<string[]>(loadRecent);
  const [confirmClose, setConfirmClose] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const viewRef = useRef<EditorView | null>(null);
  const closeResolveRef = useRef<((ok: boolean) => void) | null>(null);
  /* 视图偏好同步状态：hydrated=服务端 GET 尝试已结束；pushed=最近一次已知的服务端快照（推送去重）；
     mutated=本地已发生过变更（如 .md 自动开预览先于 hydration 完成时本地胜出） */
  const viewHydratedRef = useRef(false);
  const viewPushedRef = useRef<EditorServerPrefs>({});
  const viewMutatedRef = useRef(false);

  const { aboutMenuItem, aboutWindow } = useClassicyAboutMenu(EDITOR_APP_ID, EDITOR_APP_NAME, EDITOR_ICON);

  const handleLogout = useCallback(async () => {
    try {
      await logout();
    } catch {
      // 登出接口失败也照常回到登录页（如 token 已过期）
    }
    onLogout();
  }, [onLogout]);

  /* 视图偏好变更入口：标记本地已变更（hydration 不再覆盖）+ 合并更新 */
  const updateViewPrefs = useCallback((patch: Partial<EditorViewPrefs>) => {
    viewMutatedRef.current = true;
    setViewPrefs((p) => ({ ...p, ...patch }));
  }, []);

  const loadFile = useCallback(
    async (p: string) => {
      const target = p.trim();
      if (!target) return;
      setLoading(true);
      setError('');
      try {
        const r = await fsRead(target);
        if (r.tooLarge) {
          setError(`文件过大（${fmtBytes(r.size)}），仅支持编辑 2MB 以内文本`);
          return;
        }
        if (r.binary) {
          setError('二进制文件，无法以文本方式编辑');
          return;
        }
        setPath(r.path);
        setContent(r.content ?? '');
        setDirty(false);
        setSavedAt(null);
        // Markdown 文件自动开启预览；非 Markdown 保持用户当前选择（记住状态）
        if (isMdPath(r.path)) updateViewPrefs({ showPreview: true });
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
    [handleLogout]
  );

  const save = useCallback(async (): Promise<boolean> => {
    if (!path) return false;
    try {
      await fsWrite(path, content);
      setDirty(false);
      setSavedAt(Date.now());
      setError('');
      return true;
    } catch (e) {
      if (e instanceof Unauthorized) {
        handleLogout();
        return false;
      }
      setError(`保存失败：${(e as Error).message}`);
      return false;
    }
  }, [path, content, handleLogout]);

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

  // 偏好持久化（本地三项：主题/字号/字体）
  useEffect(() => {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    } catch {
      // localStorage 不可用时忽略
    }
  }, [prefs]);

  // 视图偏好 hydration：挂载即拉取服务端值。本地已变更（.md 自动开预览先完成）时不覆盖，
  // 由推送 effect 以本地值为准上传——两种完成顺序下用户的即时意图都不丢
  useEffect(() => {
    let cancelled = false;
    prefsGetEditor()
      .then((r) => {
        if (cancelled) return;
        const s = r.editor || {};
        if (!viewMutatedRef.current) {
          // 逐字段：服务端有的键以服务端为权威；没有的键保留本地初始值（迁移载体）
          setViewPrefs((p) => ({
            wordWrap: typeof s.wordWrap === 'boolean' ? s.wordWrap : p.wordWrap,
            showPreview: typeof s.showPreview === 'boolean' ? s.showPreview : p.showPreview,
          }));
        }
        viewPushedRef.current = s;
      })
      .catch((e) => {
        // 拉取失败：保持当前值，pushed 留空使下次变更触发重推（PUT 合并语义不会写丢另一字段）
        if (e instanceof Unauthorized) handleLogout();
      })
      .finally(() => {
        if (!cancelled) viewHydratedRef.current = true;
      });
    return () => {
      cancelled = true;
    };
  }, [handleLogout]);

  // 视图偏好推送：变更后写回服务端；与服务端快照相同（缺省键按 false 聚合）则跳过，
  // 避免每次打开编辑器都重写文件，也不会为从未碰过开关的用户创建数据
  useEffect(() => {
    if (!viewHydratedRef.current) return;
    const pushed = viewPushedRef.current;
    if ((pushed.wordWrap ?? false) === viewPrefs.wordWrap && (pushed.showPreview ?? false) === viewPrefs.showPreview) return;
    prefsSetEditor(viewPrefs)
      .then((r) => {
        viewPushedRef.current = r.editor || {};
      })
      .catch((e) => {
        // 失败保留旧快照：下次变更会重试；不回滚 UI（偏好丢失优于界面错乱）
        if (e instanceof Unauthorized) handleLogout();
      });
  }, [viewPrefs, handleLogout]);

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
          { id: 'ed-m-wrap', title: 'Word Wrap', checked: viewPrefs.wordWrap, onClickFunc: () => updateViewPrefs({ wordWrap: !viewPrefs.wordWrap }) },
          { id: 'ed-m-preview', title: 'Show Preview', checked: viewPrefs.showPreview, onClickFunc: () => updateViewPrefs({ showPreview: !viewPrefs.showPreview }) },
        ],
      },
    ],
    [aboutMenuItem, path, save, updateViewPrefs, viewPrefs.wordWrap, viewPrefs.showPreview]
  );

  const editorNode = (
    <CodeEditor
      path={path}
      value={content}
      onChange={(v) => {
        setContent(v);
        setDirty(true);
      }}
      theme={prefs.theme}
      fontSize={prefs.fontSize}
      fontFamily={prefs.fontFamily}
      wordWrap={viewPrefs.wordWrap}
      onReady={(v) => (viewRef.current = v)}
      onStats={setStats}
      className="sp-editor-code"
    />
  );

  return (
    <ClassicyApp id={EDITOR_APP_ID} name={EDITOR_APP_NAME} icon={EDITOR_ICON} defaultWindow={EDITOR_WIN_ID}>
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
          ) : viewPrefs.showPreview ? (
            <ClassicySplitView direction="horizontal" defaultSizes={[55, 45]} minPaneSize={200} className="sp-editor-body">
              {editorNode}
              <div className="sp-editor-preview">
                {isMd ? <MarkdownPreview source={content} /> : <pre className="sp-editor-plain">{content}</pre>}
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
                  ? `${stats.line}:${stats.col} · ${fmtBytes(stats.size)}${savedAt ? ` · 已保存 ${fmtTime(savedAt)}` : ''}`
                  : ''}
            </span>
          </div>
        </div>

        {confirmClose && (
          <ClassicyAlert
            appId={EDITOR_APP_ID}
            alertType="caution"
            label="未保存的更改"
            message="文档包含未保存的修改，关闭前是否保存？"
            buttons={[
              { id: 'ed-save-close', label: '保存并关闭', role: 'default', onClick: () => void (async () => { const ok = await save(); settleClose(ok); })() },
              { id: 'ed-discard', label: '不保存', role: 'normal', onClick: () => settleClose(true) },
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
                    onChangeFunc={(e) => setPrefs((p) => ({ ...p, theme: e.target.value as EditorThemeId }))}
                  />
                </div>
                <div className="sp-dialog-field">
                  <label htmlFor="ed-set-fsize">字号</label>
                  <ClassicyPopUpMenu
                    id="ed-set-fsize"
                    options={FONT_SIZES.map((n) => ({ value: String(n), label: `${n}px` }))}
                    selected={String(prefs.fontSize)}
                    onChangeFunc={(e) => setPrefs((p) => ({ ...p, fontSize: parseInt(e.target.value, 10) }))}
                  />
                </div>
                <div className="sp-dialog-field">
                  <label htmlFor="ed-set-font">字体</label>
                  <ClassicyPopUpMenu
                    id="ed-set-font"
                    options={EDITOR_FONTS.map((f) => ({ value: f.value, label: f.label }))}
                    selected={prefs.fontFamily}
                    onChangeFunc={(e) => setPrefs((p) => ({ ...p, fontFamily: e.target.value }))}
                  />
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
