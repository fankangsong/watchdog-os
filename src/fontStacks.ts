/**
 * 等宽字体的中文回落（字面量）。
 *
 * 为什么不用 styles.css 的 --cjk-font：xterm 用 canvas measureText 量字宽时
 * 会把 fontFamily 直接写进 ctx.font，而 canvas 不解析 CSS var()，所以终端必须拿到
 * 真实的字体名字符串。编辑器（CodeMirror）同样在 JS 侧拼接 fontFamily，共用此常量
 * 可保证两处回落栈一致。
 *
 * 顺序与 :root 的 --cjk-font 对齐：简体优先、跨平台逐个兜底，末尾 generic。
 * 实测（headless Chrome，14px）：CJK 字宽 14px < 两个等宽单元格 16.8px，
 * 不会越列；加入 CJK 字体不改变拉丁单元格宽度，只保证各平台都能取到中文字形。
 */
export const CJK_MONO_FALLBACK =
  '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", "Source Han Sans SC", monospace';

/** 把选中的等宽栈拼上中文回落；已是兜底栈（含 PingFang）则不重复追加。 */
export function withCjkFallback(fontFamily: string): string {
  if (fontFamily.includes('PingFang SC')) return fontFamily;
  return `${fontFamily}, ${CJK_MONO_FALLBACK}`;
}
