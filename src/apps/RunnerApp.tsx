import { useEffect, useRef, useState } from 'react';
import {
  ClassicyApp,
  ClassicyButton,
  ClassicyButtonToolbar,
  ClassicyButtonToolbarGroup,
  ClassicyControlGroup,
  ClassicyIcons,
  ClassicyWindow,
} from 'classicy';
import { fetchRunnerStatus, startRunnerBuild, stopRunnerBuild, Unauthorized } from '../api';
import { usePolling } from '../hooks/usePolling';

const APP_ID = 'srv-runner.app';
const APP_NAME = 'Runner';

function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleString();
}

/** 应用：远程脚本任务（running_page build.sh）触发与日志查看 */
export function RunnerApp({ onLogout }: { onLogout?: () => void }) {
  // 轮询间隔：运行中 2s、空闲 10s（interval 变化会重启 usePolling 定时器）
  const [intervalMs, setIntervalMs] = useState(10000);
  const poll = usePolling(fetchRunnerStatus, intervalMs);
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

  const appMenu = [
    {
      id: 'sys',
      title: 'System',
      menuChildren: [{ id: 'logout', title: 'Sign Out', onClickFunc: () => onLogout?.() }],
    },
  ];

  const onStart = async () => {
    setBusy(true);
    setActionError('');
    try {
      await startRunnerBuild();
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
      await stopRunnerBuild();
      poll.reload();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const last = poll.data?.last ?? null;

  return (
    <ClassicyApp id={APP_ID} name={APP_NAME} icon={ClassicyIcons.system.network.terminal} defaultWindow="runner-main">
      <ClassicyWindow
        id="runner-main"
        title={APP_NAME}
        icon={ClassicyIcons.system.network.terminal}
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
                Runner 未启用：需在服务端 config.json 配置 runner.enabled 与 runner.scriptPath
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
    </ClassicyApp>
  );
}
