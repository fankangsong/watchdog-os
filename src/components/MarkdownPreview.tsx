// Markdown 渲染预览：marked 解析 + DOMPurify 净化（防 XSS）
import { useMemo } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';

marked.setOptions({ gfm: true, breaks: true });

export function MarkdownPreview({ source }: { source: string }) {
  const html = useMemo(
    () => DOMPurify.sanitize(marked.parse(source, { async: false }) as string),
    [source]
  );
  return <div className="sp-md-preview" dangerouslySetInnerHTML={{ __html: html }} />;
}
