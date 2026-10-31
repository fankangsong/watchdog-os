// Markdown 渲染预览：marked 解析 + DOMPurify 净化（防 XSS）+ 相对路径图片改写（经 /api/fs/raw 内联）
// 代码块右上角附加「复制」按钮：经 DOM API 挂载（不经 dangerouslySetInnerHTML，
// 无净化旁路风险），点击走事件委托；流式输出时 html 变化触发 effect 重新挂载
import { useEffect, useMemo, useRef } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { fsRawUrl } from '../api';
import { copyText } from '../clipboard';

marked.setOptions({ gfm: true, breaks: true });

/** 不可改写的 src 前缀：外部资源 / 内联数据 / 协议相对地址一律原样保留 */
const EXTERNAL_SRC = /^(https?:|data:|blob:|mailto:|\/\/)/i;

/**
 * 把 markdown 内的图片 src 解析为宿主机绝对路径（基于 md 文件所在目录），无法解析返回 null。
 * - 先剥掉 query/hash（?v=1#x 等非 FS 路径语义）
 * - `./` `../` 与裸相对名逐段解析；分隔符兼容 / 与 \（Windows 开发环境）
 * - 以 / 或盘符开头视为宿主机绝对路径直接使用；越权由后端 fsAllowed 兜底（403 空显）
 */
function resolveImgSrc(docPath: string, src: string): string | null {
  const raw = src.trim();
  if (!raw || EXTERNAL_SRC.test(raw)) return null;
  const pathPart = raw.split(/[?#]/, 1)[0];
  if (!pathPart) return null;
  if (pathPart.startsWith('/') || /^[A-Za-z]:[\\/]/.test(pathPart)) return pathPart;
  // 基座 = docPath 去掉末尾最后一个路径段（文件名）后的目录部分
  const normDoc = docPath.replace(/[\\/]+$/, '');
  const lastSep = Math.max(normDoc.lastIndexOf('/'), normDoc.lastIndexOf('\\'));
  const base = lastSep >= 0 ? normDoc.slice(0, lastSep) : '';
  const segs: string[] = [];
  for (const seg of pathPart.split(/[\\/]+/)) {
    if (!seg || seg === '.') continue;
    if (seg === '..') segs.pop(); // 多于目录深度时 clamp（与 path.resolve 行为一致）
    else segs.push(seg);
  }
  return base ? `${base}/${segs.join('/')}` : segs.join('/');
}

/**
 * DOM 后处理：把相对路径的 img.src 改写为 /api/fs/raw 内联 URL。
 * 统一走 DOM 解析，同时覆盖 ![]() 语法与 markdown 内嵌的裸 <img> HTML。
 */
function rewriteImages(html: string, docPath: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  for (const img of Array.from(doc.querySelectorAll('img'))) {
    const attr = img.getAttribute('src');
    if (!attr) continue;
    const resolved = resolveImgSrc(docPath, attr);
    if (resolved) img.setAttribute('src', fsRawUrl(resolved));
  }
  return doc.body.innerHTML;
}

export function MarkdownPreview({ source, docPath }: { source: string; docPath?: string }) {
  const html = useMemo(() => {
    const sanitized = DOMPurify.sanitize(marked.parse(source, { async: false }) as string);
    // docPath 缺省（如聊天气泡）无文件上下文，保持原行为
    return docPath ? rewriteImages(sanitized, docPath) : sanitized;
  }, [source, docPath]);
  const rootRef = useRef<HTMLDivElement>(null);

  // 每次渲染后给所有 pre 挂复制按钮（流式输出会反复重渲染，按标记去重）
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    root.querySelectorAll('pre').forEach((pre) => {
      if (pre.dataset.copyBtn === '1') return;
      pre.dataset.copyBtn = '1';
      // 按钮挂在 pre 外层的 relative wrapper 上：pre 自身是滚动容器，
      // 绝对定位在 pre 内会跟随内容滚动
      const wrap = document.createElement('div');
      wrap.className = 'sp-md-code-wrap';
      pre.replaceWith(wrap);
      wrap.appendChild(pre);
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'sp-md-copy';
      btn.textContent = 'Copy';
      btn.setAttribute('aria-label', 'Copy code');
      wrap.appendChild(btn);
    });
  }, [html]);

  const handleClick = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    const btn = target.closest('button.sp-md-copy') as HTMLButtonElement | null;
    if (!btn) return;
    const pre = btn.parentElement?.querySelector('pre');
    const code = pre?.querySelector('code')?.textContent ?? pre?.textContent ?? '';
    void copyText(code).then((ok) => {
      btn.textContent = ok ? 'Copied' : 'Copy failed';
      setTimeout(() => {
        btn.textContent = 'Copy';
      }, 1500);
    });
  };

  return (
    <div
      ref={rootRef}
      className="sp-md-preview"
      onClick={handleClick}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
