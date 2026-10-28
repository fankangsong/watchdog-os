// DOCX 预览：fetch /api/fs/raw 取二进制 → docx-preview（动态 import 懒加载）渲染为排版还原 HTML。
// docx 不经 raw 内联（仍 attachment），fetch 读 body 不受响应头影响；样式注入限定在组件容器内，卸载即随 DOM 移除。
import { useEffect, useRef, useState } from 'react';
import { fsRawUrl } from '../api';

type Phase = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'done' };

export function DocxPreview({ path }: { path: string }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });

  useEffect(() => {
    let alive = true;
    setPhase({ kind: 'loading' });
    void (async () => {
      try {
        const resp = await fetch(fsRawUrl(path));
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const buf = await resp.arrayBuffer();
        // 动态 import：docx-preview 仅在首次打开 docx 预览时下载（Vite 自动代码分割）
        const { renderAsync } = await import('docx-preview');
        const container = containerRef.current;
        if (!alive || !container) return;
        container.innerHTML = '';
        // styleContainer 传容器自身：注入的 <style> 随组件卸载一并移除，不残留全局样式
        await renderAsync(buf, container, container, {
          inWrapper: true,
          renderHeaders: true,
          renderFooters: true,
        });
        if (alive) setPhase({ kind: 'done' });
      } catch (e) {
        if (alive) setPhase({ kind: 'error', message: `Failed to render document: ${(e as Error).message}` });
      }
    })();
    return () => {
      alive = false;
      if (containerRef.current) containerRef.current.innerHTML = '';
    };
  }, [path]);

  return (
    <div className="sp-fm-docx">
      {phase.kind === 'loading' && <div className="sp-fm-docx-note">Loading…</div>}
      {phase.kind === 'error' && <div className="sp-fm-docx-note sp-fm-docx-error">{phase.message}</div>}
      <div ref={containerRef} className="sp-fm-docx-body" />
    </div>
  );
}
