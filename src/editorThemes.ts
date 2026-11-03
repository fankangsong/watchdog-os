/**
 * 编辑器主题 / 字体清单（纯数据，不依赖 CodeMirror）。
 *
 * 单独成文件的原因：偏好合并逻辑（src/editorPrefs.ts）需要按这些白名单做枚举回退，
 * 若常量留在 CodeEditor.tsx 里会把整套 CodeMirror 依赖拖进纯逻辑单测。
 */
export type EditorThemeId = 'dracula' | 'githubDark' | 'githubLight' | 'vscodeDark';

export const EDITOR_THEMES: Array<{ id: EditorThemeId; label: string }> = [
  { id: 'dracula', label: 'Dracula' },
  { id: 'githubDark', label: 'GitHub Dark' },
  { id: 'githubLight', label: 'GitHub Light' },
  { id: 'vscodeDark', label: 'VSCode Dark' },
];

export const EDITOR_FONTS: Array<{ value: string; label: string }> = [
  { value: 'Consolas, "Courier New", monospace', label: 'Consolas' },
  { value: '"JetBrains Mono", Consolas, monospace', label: 'JetBrains Mono' },
  { value: '"Source Code Pro", Consolas, monospace', label: 'Source Code Pro' },
  { value: 'Menlo, Monaco, "Courier New", monospace', label: 'Menlo / Monaco' },
  { value: '"Courier New", monospace', label: 'Courier New' },
  { value: 'monospace', label: '系统等宽字体' },
];

export const DEFAULT_EDITOR_THEME: EditorThemeId = 'dracula';
export const DEFAULT_EDITOR_FONT = EDITOR_FONTS[0].value;
