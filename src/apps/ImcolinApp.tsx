import { useCallback, useMemo, useRef, useState } from 'react';
import { ClassicyApp, ClassicyButton, ClassicyButtonToolbar, ClassicyButtonToolbarGroup, ClassicyIcons, ClassicyWindow } from 'classicy';

const APP_ID = 'srv-imcolin.app';
const APP_NAME = 'imcolin.fan';
const HOME_URL = 'https://imcolin.fan';

/**
 * 跨域 iframe 无法直接读取其内部历史。这里借助资源时间线（Resource Timing）：
 * 每次 iframe 顶层文档导航都会产生一个 initiatorType 为 iframe/subdocument
 * 的条目，其 name 即目标 URL。load 事件触发时扫描该时间窗口即可拿到真实地址。
 */
function detectIframeUrl(sinceMs: number, untilMs: number): string | null {
  const entries = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.startTime < sinceMs || e.startTime > untilMs) continue;
    if (e.initiatorType === 'iframe' || e.initiatorType === 'subdocument') {
      return e.name;
    }
  }
  return null;
}

// 应用：内嵌 imcolin.fan 网页，带 后退/前进 按钮
export function ImcolinApp({ onLogout }: { onLogout?: () => void }) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [history, setHistory] = useState<string[]>([HOME_URL]);
  const [index, setIndex] = useState(0);
  // 与 setState 同步的 ref，避免 load 回调里拿到过期闭包
  const historyRef = useRef(history);
  historyRef.current = history;
  const indexRef = useRef(index);
  indexRef.current = index;
  // 上一次 load 事件发生时刻，作为资源条目时间窗口下限
  const lastLoadTimeRef = useRef(performance.now());

  const applyUrl = useCallback((url: string) => {
    const el = iframeRef.current;
    if (el) el.src = url;
  }, []);

  const goBack = useCallback(() => {
    if (indexRef.current <= 0) return;
    const i = indexRef.current - 1;
    indexRef.current = i;
    setIndex(i);
    applyUrl(historyRef.current[i]);
  }, [applyUrl]);

  const goForward = useCallback(() => {
    if (indexRef.current >= historyRef.current.length - 1) return;
    const i = indexRef.current + 1;
    indexRef.current = i;
    setIndex(i);
    applyUrl(historyRef.current[i]);
  }, [applyUrl]);

  // iframe 每次加载结束：若是站内点击产生的导航，则记入历史栈；否则（后退/前进回访）跳过
  const onFrameLoad = useCallback(() => {
    const now = performance.now();
    const url = detectIframeUrl(lastLoadTimeRef.current, now);
    lastLoadTimeRef.current = now;
    if (!url) return;
    if (historyRef.current[indexRef.current] === url) return; // 回访或首次加载，无新导航
    const next = [...historyRef.current.slice(0, indexRef.current + 1), url];
    historyRef.current = next;
    setHistory(next);
    indexRef.current = next.length - 1;
    setIndex(next.length - 1);
  }, []);

  const appMenu = useMemo(
    () => [
      {
        id: 'sys',
        title: 'System',
        menuChildren: [{ id: 'logout', title: 'Sign Out', onClickFunc: () => onLogout?.() }],
      },
    ],
    [onLogout]
  );

  const canBack = index > 0;
  const canForward = index < history.length - 1;

  return (
    <ClassicyApp id={APP_ID} name={APP_NAME} icon={ClassicyIcons.applications.internetExplorer.app} defaultWindow="imcolin-main">
      <ClassicyWindow
        id="imcolin-main"
        title={APP_NAME}
        icon={ClassicyIcons.applications.internetExplorer.app}
        appId={APP_ID}
        resizable
        zoomable
        collapsable
        closable
        initialSize={[1000, 660]}
        initialPosition={['center', 'center']}
        minimumSize={[680, 420]}
        appMenu={appMenu}
      >
        <div className="sp-web">
          <div className="sp-web-toolbar">
            <ClassicyButtonToolbar size="small">
              <ClassicyButtonToolbarGroup>
                <ClassicyButton buttonSize="small" disabled={!canBack} onClickFunc={goBack}>
                  ◀ Back
                </ClassicyButton>
                <ClassicyButton buttonSize="small" disabled={!canForward} onClickFunc={goForward}>
                  Forward ▶
                </ClassicyButton>
              </ClassicyButtonToolbarGroup>
            </ClassicyButtonToolbar>
          </div>
          <iframe ref={iframeRef} className="sp-web-frame" src={HOME_URL} title={APP_NAME} onLoad={onFrameLoad} />
        </div>
      </ClassicyWindow>
    </ClassicyApp>
  );
}