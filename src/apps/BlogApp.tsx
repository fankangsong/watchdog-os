import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ClassicyApp,
  ClassicyButton,
  ClassicyButtonToolbar,
  ClassicyButtonToolbarGroup,
  ClassicyControlGroup,
  ClassicyWindow,
  useClassicyAboutMenu,
} from 'classicy';
import { fetchBlogStatus, startBlogBuild, stopBlogBuild, Unauthorized } from '../api';
import { usePolling } from '../hooks/usePolling';
import { quitMenuItem } from '../quitMenuItem';
// ⚠️ 必须用 ?no-inline（仅 ?url 不够，它不绕过 assetsInlineLimit）让 Vite 输出独立文件 URL，
// 否则 classicy 桌面图标遮罩会静默失效（见 docs/icon-pipeline.md §6.2）。
import blogIcon from '../assets/icons/blog.svg?no-inline';

const APP_ID = 'srv-blog.app';
const APP_NAME = 'Blog';
/** 应用图标：自绘 SVG（Mac OS 9 窗口 + 铅笔），见 src/assets/icons/blog.svg */
const ICON = blogIcon;

function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleString();
}

/** 应用：博客静态站点构建（static-gallary-generator build.sh）触发与日志查看 */
export function BlogApp({ onLogout }: { onLogout?: () => void }) {
  // 轮询间隔：运行中 2s、空闲 10s（interval 变化会重启 usePolling 定时器）
  const [intervalMs, setIntervalMs] = useState(10000);
  const poll = usePolling(fetchBlogStatus, intervalMs);

  const { aboutMenuItem, aboutWindow } = useClassicyAboutMenu(APP_ID, APP_NAME, ICON);
  const running = poll.data?.running === true;
  const enabled = poll.data?.enabled === true;

  const [busy, setBusy] = useState(false); // start/stop 请求进行中
  const [actionError, setActionError] = useState('');
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setIntervalMs(running ? 2000 : 10000);
  }, [running]);

  useEffect(() => {
    if (poll.error instanceof Unauthorized) onLogout?.();
  }, [poll.error, onLogout]);

  // 有新日志时滚动到底部（日志查看以尾部为准）
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [poll.data?.log]);

  const appMenu = useMemo(
    () => [
      {
        id: 'blog-menu',
        title: APP_NAME,
        menuChildren: [
          aboutMenuItem,
          { id: 'spacer' },
          quitMenuItem(APP_ID, APP_NAME, ICON),
        ],
      },
    ],
    [aboutMenuItem]
  );

  const onStart = async () => {
    setBusy(true);
    setActionError('');
    try {
      await startBlogBuild();
      poll.reload();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const onStop = async () => {
    setBusy(true);
    setActionError('');
    try {
      await stopBlogBuild();
      poll.reload();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const last = poll.data?.last ?? null;

  return (
    <ClassicyApp id={APP_ID} name={APP_NAME} icon={ICON} defaultWindow="blog-main">
      <ClassicyWindow
        id="blog-main"
        title={APP_NAME}
        icon={ICON}
        appId={APP_ID}
        scrollable
        resizable
        zoomable
        collapsable
        closable
        initialSize={[860, 560]}
        initialPosition={['center', 'center']}
        minimumSize={[620, 380]}
        appMenu={appMenu}
      >
        <ClassicyControlGroup label="Task">
          <div style={{ padding: '8px 12px', fontSize: 12, display: 'grid', gap: 6 }}>
            {!enabled && (
              <div style={{ color: '#a00' }}>
                Blog 未启用：需在服务端 .env 配置 BLOG_ENABLED=true 与 BLOG_SCRIPT
              </div>
            )}
            <div>
              状态：
              {running ? (
                <b style={{ color: '#0a0' }}>● Running{poll.data?.job ? `（${poll.data.job.id}）` : ''}</b>
              ) : (
                <span>○ Idle</span>
              )}
            </div>
            <div style={{ color: '#666', wordBreak: 'break-all' }}>脚本：{poll.data?.script || '—'}</div>
            {last && (
              <div>
                上次结果：
                {last.failed ? (
                  <b style={{ color: '#a00' }}>Failed (exit {last.exitCode})</b>
                ) : (
                  <b style={{ color: '#0a0' }}>Success (exit {last.exitCode})</b>
                )}
                {' · '}
                耗时 {fmtDuration(last.durationMs)} · {fmtTime(last.finishedAt)}
              </div>
            )}
            {actionError && <div style={{ color: '#a00' }}>操作失败：{actionError}</div>}
          </div>
        </ClassicyControlGroup>
        <ClassicyControlGroup label="Actions">
          <div style={{ padding: '8px 12px' }}>
            <ClassicyButtonToolbar size="small">
              <ClassicyButtonToolbarGroup>
                <ClassicyButton buttonSize="small" disabled={!enabled || running || busy} onClickFunc={onStart}>
                  ▶ Build
                </ClassicyButton>
                <ClassicyButton buttonSize="small" disabled={!running || busy} onClickFunc={onStop}>
                  ■ Stop
                </ClassicyButton>
              </ClassicyButtonToolbarGroup>
            </ClassicyButtonToolbar>
          </div>
        </ClassicyControlGroup>
        <ClassicyControlGroup label="Log (tail)">
          <div
            ref={logRef}
            style={{
              margin: '8px 12px 12px',
              height: 240,
              overflow: 'auto',
              background: '#000',
              color: '#ddd',
              fontFamily: 'Consolas, Menlo, monospace',
              fontSize: 11,
              lineHeight: 1.5,
              padding: 8,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-all',
            }}
          >
            {poll.data?.log || (poll.error ? '（无法读取日志）' : '（暂无日志）')}
          </div>
        </ClassicyControlGroup>
      </ClassicyWindow>
      {aboutWindow}
    </ClassicyApp>
  );
}
