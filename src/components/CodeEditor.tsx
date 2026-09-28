// CodeMirror 6 封装：按扩展名动态加载语言高亮、社区主题切换、字号字体、撤销重做。
// 文件管理器（只读预览）与文本编辑器（完整编辑）共用。
import { useEffect, useRef } from 'react';
import { Compartment, EditorState } from '@codemirror/state';
import type { Extension } from '@codemirror/state';
import {
  EditorView,
  drawSelection,
  dropCursor,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
  crosshairCursor,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import {
  bracketMatching,
  defaultHighlightStyle,
  foldGutter,
  foldKeymap,
  indentOnInput,
  indentUnit,
  syntaxHighlighting,
} from '@codemirror/language';
import type { LanguageSupport } from '@codemirror/language';
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search';
import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
} from '@codemirror/autocomplete';

// 开源社区主题（@uiw/codemirror-theme-*）
import { dracula } from '@uiw/codemirror-theme-dracula';
import { githubDark, githubLight } from '@uiw/codemirror-theme-github';
import { vscodeDark } from '@uiw/codemirror-theme-vscode';

export type EditorThemeId = 'dracula' | 'githubDark' | 'githubLight' | 'vscodeDark';

export const EDITOR_THEMES: Array<{ id: EditorThemeId; label: string }> = [
  { id: 'dracula', label: 'Dracula' },
  { id: 'githubDark', label: 'GitHub Dark' },
  { id: 'githubLight', label: 'GitHub Light' },
  { id: 'vscodeDark', label: 'VSCode Dark' },
];

const DARK_THEMES: ReadonlySet<EditorThemeId> = new Set(['dracula', 'githubDark', 'vscodeDark']);

// @uiw 主题包导出形态不一（Extension 或工厂函数），统一适配
const THEME_RAW: Record<EditorThemeId, unknown> = { dracula, githubDark, githubLight, vscodeDark };

function asExtension(v: unknown): Extension {
  return (typeof v === 'function' ? (v as () => Extension)() : v) as Extension;
}

export const EDITOR_FONTS: Array<{ value: string; label: string }> = [
  { value: 'Consolas, "Courier New", monospace', label: 'Consolas' },
  { value: '"JetBrains Mono", Consolas, monospace', label: 'JetBrains Mono' },
  { value: '"Source Code Pro", Consolas, monospace', label: 'Source Code Pro' },
  { value: 'Menlo, Monaco, "Courier New", monospace', label: 'Menlo / Monaco' },
  { value: '"Courier New", monospace', label: 'Courier New' },
  { value: 'monospace', label: '系统等宽字体' },
];

const DEFAULT_FONT = EDITOR_FONTS[0].value;

/* 扩展名 → 语言包 key；语言包按需动态 import，避免全部打进主包 */
const EXT_LANG: Record<string, string> = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'jsx',
  ts: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'tsx',
  json: 'json', jsonc: 'json', map: 'json',
  md: 'markdown', markdown: 'markdown',
  py: 'python', pyw: 'python',
  html: 'html', htm: 'html',
  css: 'css', scss: 'css', less: 'css',
  xml: 'xml', xsl: 'xml', plist: 'xml',
  sql: 'sql',
  yml: 'yaml', yaml: 'yaml',
};

const LANG_LOADERS: Record<string, () => Promise<LanguageSupport>> = {
  javascript: () => import('@codemirror/lang-javascript').then((m) => m.javascript()),
  jsx: () => import('@codemirror/lang-javascript').then((m) => m.javascript({ jsx: true })),
  typescript: () => import('@codemirror/lang-javascript').then((m) => m.javascript({ typescript: true })),
  tsx: () => import('@codemirror/lang-javascript').then((m) => m.javascript({ typescript: true, jsx: true })),
  json: () => import('@codemirror/lang-json').then((m) => m.json()),
  // markdown 支持围栏代码块内嵌语言高亮（language-data 按需加载）
  markdown: () =>
    Promise.all([import('@codemirror/lang-markdown'), import('@codemirror/language-data')]).then(
      ([m, l]) => m.markdown({ codeLanguages: l.languages })
    ),
  python: () => import('@codemirror/lang-python').then((m) => m.python()),
  html: () => import('@codemirror/lang-html').then((m) => m.html()),
  css: () => import('@codemirror/lang-css').then((m) => m.css()),
  xml: () => import('@codemirror/lang-xml').then((m) => m.xml()),
  sql: () => import('@codemirror/lang-sql').then((m) => m.sql()),
  yaml: () => import('@codemirror/lang-yaml').then((m) => m.yaml()),
};

/** 依据文件路径推断语言包 key（无扩展名/未知类型返回 null，按纯文本处理） */
export function langKeyForPath(p: string): string | null {
  const dot = p.lastIndexOf('.');
  const slash = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  if (dot === -1 || dot <= slash) return null;
  return EXT_LANG[p.slice(dot + 1).toLowerCase()] ?? null;
}

function themeExtension(id: EditorThemeId): Extension {
  return [asExtension(THEME_RAW[id]), EditorView.darkTheme.of(DARK_THEMES.has(id))];
}

function fontExtension(fontSize: number, fontFamily?: string): Extension {
  return EditorView.theme({
    '&': { fontSize: `${fontSize}px`, height: '100%' },
    '.cm-scroller': { fontFamily: fontFamily || DEFAULT_FONT, lineHeight: '1.55' },
    '.cm-gutters': { fontFamily: fontFamily || DEFAULT_FONT },
  });
}

function readOnlyExtension(ro: boolean): Extension {
  return [EditorState.readOnly.of(ro), EditorView.editable.of(!ro)];
}

export interface CodeEditorProps {
  /** 文件路径：决定语言高亮 */
  path?: string;
  value: string;
  onChange?: (value: string) => void;
  theme?: EditorThemeId;
  fontSize?: number;
  fontFamily?: string;
  readOnly?: boolean;
  /** 自动换行：长行折行适应宽度，不出现横向滚动条 */
  wordWrap?: boolean;
  className?: string;
  /** 暴露 EditorView（父组件实现撤销/重做按钮） */
  onReady?: (view: EditorView) => void;
  /** 光标/文档统计（状态栏） */
  onStats?: (stats: { line: number; col: number; size: number }) => void;
}

export function CodeEditor({
  path,
  value,
  onChange,
  theme = 'dracula',
  fontSize = 14,
  fontFamily,
  readOnly = false,
  wordWrap = false,
  className,
  onReady,
  onStats,
}: CodeEditorProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const themeCpt = useRef(new Compartment());
  const fontCpt = useRef(new Compartment());
  const roCpt = useRef(new Compartment());
  const langCpt = useRef(new Compartment());
  const wrapCpt = useRef(new Compartment());
  const cbs = useRef({ onChange, onStats, onReady });
  cbs.current = { onChange, onStats, onReady };

  // 挂载：创建 EditorView（仅一次）
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const view = new EditorView({
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
          highlightSpecialChars(),
          history(),
          foldGutter(),
          drawSelection(),
          dropCursor(),
          EditorState.allowMultipleSelections.of(true),
          indentOnInput(),
          indentUnit.of('  '),
          syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
          bracketMatching(),
          closeBrackets(),
          autocompletion(),
          rectangularSelection(),
          crosshairCursor(),
          highlightActiveLine(),
          highlightSelectionMatches(),
          search({ top: true }),
          keymap.of([
            ...closeBracketsKeymap,
            ...defaultKeymap,
            ...searchKeymap,
            ...historyKeymap,
            ...foldKeymap,
            ...completionKeymap,
            indentWithTab,
          ]),
          themeCpt.current.of(themeExtension(theme)),
          fontCpt.current.of(fontExtension(fontSize, fontFamily)),
          roCpt.current.of(readOnlyExtension(readOnly)),
          wrapCpt.current.of(wordWrap ? EditorView.lineWrapping : []),
          langCpt.current.of([]),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) cbs.current.onChange?.(u.state.doc.toString());
            if (u.docChanged || u.selectionSet) {
              const sel = u.state.selection.main;
              const line = u.state.doc.lineAt(sel.head);
              cbs.current.onStats?.({
                line: line.number,
                col: sel.head - line.from + 1,
                size: u.state.doc.length,
              });
            }
          }),
        ],
      }),
      parent: host,
    });
    viewRef.current = view;
    cbs.current.onReady?.(view);
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 外部 value 同步（输入触发的回写值与文档一致时跳过，避免光标跳动）
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const cur = view.state.doc.toString();
    if (cur !== value) {
      view.dispatch({ changes: { from: 0, to: cur.length, insert: value } });
    }
  }, [value]);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: themeCpt.current.reconfigure(themeExtension(theme)) });
  }, [theme]);

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: fontCpt.current.reconfigure(fontExtension(fontSize, fontFamily)),
    });
  }, [fontSize, fontFamily]);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: roCpt.current.reconfigure(readOnlyExtension(readOnly)) });
  }, [readOnly]);

  // 自动换行开关动态切换
  useEffect(() => {
    viewRef.current?.dispatch({
      effects: wrapCpt.current.reconfigure(wordWrap ? EditorView.lineWrapping : []),
    });
  }, [wordWrap]);

  // 语言包按 path 动态加载（并发竞态防护：仅应用最后一次请求结果）
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const key = path ? langKeyForPath(path) : null;
    const loader = key ? LANG_LOADERS[key] : undefined;
    if (!loader) {
      view.dispatch({ effects: langCpt.current.reconfigure([]) });
      return;
    }
    let cancelled = false;
    loader()
      .then((support) => {
        if (!cancelled) view.dispatch({ effects: langCpt.current.reconfigure(support) });
      })
      .catch(() => {
        // 语言包加载失败：退回纯文本，不阻塞编辑
      });
    return () => {
      cancelled = true;
    };
  }, [path]);

  return <div ref={hostRef} className={className ? `sp-code-editor ${className}` : 'sp-code-editor'} />;
}
