// 文本编辑器：CodeMirror 6 + 社区主题（Dracula / GitHub / VSCode）。
// 保存（Ctrl/Cmd+S）/ 撤销 / 重做 / 查找（Mod-F）/ Markdown 分栏预览；
// 主题、字号、字体偏好持久化 localStorage；支持从文件管理器联动打开（editorBridge）。
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
} from 'classicy';
import type { ClassicyMenuItem } from 'classicy';
import { fsRead, fsWrite, logout, Unauthorized } from '../api';
import { CodeEditor, EDITOR_FONTS, EDITOR_THEMES } from '../components/CodeEditor';
import type { EditorThemeId } from '../components/CodeEditor';
import { MarkdownPreview } from '../components/MarkdownPreview';
import { fmtBytes } from '../format';
import { EDITOR_APP_ID, EDITOR_APP_NAME, EDITOR_ICON, EDITOR_OPEN_EVENT, EDITOR_WIN_ID, takePendingEditorPath } from '../editorBridge';

const PREFS_KEY = 'srv-editor-prefs';
const RECENT_KEY = 'srv-editor-recent';
const FONT_SIZES = [10, 12, 13, 14, 16, 18, 20, 24];

interface EditorPrefs {
  theme: EditorThemeId;
  fontSize: number;
  fontFamily: string;
  wordWrap: boolean;
}

function loadPrefs(): EditorPrefs {
  const def: EditorPrefs = { theme: 'dracula', fontSize: 14, fontFamily: EDITOR_FONTS[0].value, wordWrap: false };
  try {
    const j = JSON.parse(localStorage.getItem(PREFS_KEY) || '');
    return {
      theme: EDITOR_THEMES.some((t) => t.id === j.theme) ? j.theme : def.theme,
      fontSize: Math.min(24, Math.max(10, parseInt(j.fontSize, 10) || def.fontSize)),
      fontFamily: typeof j.fontFamily === 'string' ? j.fontFamily : def.fontFamily,
      wordWrap: typeof j.wordWrap === 'boolean' ? j.wordWrap : def.wordWrap,
    };
  } catch {
    return def;
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
  const [path, setPath] = useState('');
  const [content, setContent] = useState('');
  const [dirty, setDirty] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [stats, setStats] = useState({ line: 1, col: 1, size: 0 });
  const [showPreview, setShowPreview] = useState(false);
  const [openDialog, setOpenDialog] = useState(false);
  const [openInput, setOpenInput] = useState('');
  const [recent, setRecent] = useState<string[]>(loadRecent);
  const [confirmClose, setConfirmClose] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const viewRef = useRef<EditorView | null>(null);
  const closeResolveRef = useRef<((ok: boolean) => void) | null>(null);

  const handleLogout = useCallback(async () => {
    try {
      await logout();
    } catch {
      // 登出接口失败也照常回到登录页（如 token 已过期）
    }
    onLogout();
  }, [onLogout]);

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
        setShowPreview(isMdPath(r.path));
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

  // 偏好持久化
  useEffect(() => {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    } catch {
      // localStorage 不可用时忽略
    }
  }, [prefs]);

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
        id: 'ed-file',
        title: '文件',
        menuChildren: [
          {
            id: 'ed-m-open',
            title: '打开…',
            keyboardShortcut: 'Cmd+O',
            onClickFunc: () => {
              setOpenInput(path);
              setOpenDialog(true);
            },
          },
          { id: 'ed-m-save', title: '保存', keyboardShortcut: 'Cmd+S', onClickFunc: () => void save() },
        ],
      },
      {
        id: 'ed-edit',
        title: '编辑',
        menuChildren: [
          { id: 'ed-m-undo', title: '撤销', keyboardShortcut: 'Cmd+Z', onClickFunc: () => viewRef.current && undo(viewRef.current) },
          { id: 'ed-m-redo', title: '重做', keyboardShortcut: 'Cmd+Shift+Z', onClickFunc: () => viewRef.current && redo(viewRef.current) },
        ],
      },
      {
        id: 'ed-settings',
        title: '设置',
        menuChildren: [
          { id: 'ed-m-wrap', title: '自动换行', checked: prefs.wordWrap, onClickFunc: () => setPrefs((p) => ({ ...p, wordWrap: !p.wordWrap })) },
          { id: 'ed-m-preview', title: '显示预览', checked: showPreview, onClickFunc: () => setShowPreview((v) => !v) },
          { id: 'spacer' },
          { id: 'ed-m-prefs', title: '编辑器设置…', onClickFunc: () => setSettingsOpen(true) },
        ],
      },
    ],
    [path, save, prefs.wordWrap, showPreview]
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
      wordWrap={prefs.wordWrap}
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
          ) : showPreview ? (
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
    </ClassicyApp>
  );
}
