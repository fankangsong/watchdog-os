import { useCallback, useEffect, useMemo, useState } from 'react';
import { ClassicyApp, ClassicyButton, ClassicyControlGroup, ClassicyIcons, ClassicyPopUpMenu, ClassicyWindow, useClassicyAboutMenu } from 'classicy';
import { fetchMetrics, fetchProcesses, logout, Unauthorized } from '../api';
import { usePolling } from '../hooks/usePolling';
import { SystemInfoPanel } from '../components/SystemInfoPanel';
import { ResourcesPanel } from '../components/ResourcesPanel';
import { ProcessPanel } from '../components/ProcessPanel';
import { quitMenuItem } from '../quitMenuItem';

const APP_ID = 'srv-monitor.app';
const APP_NAME = 'WatchDog OS';

const INTERVALS = [1, 2, 5, 10, 30];

// 窗口1：系统信息 + 资源使用率 + 系统进程
export function MonitorApp({ onLogout }: { onLogout: () => void }) {
  const [intervalSec, setIntervalSec] = useState(5);
  const [paused, setPaused] = useState(false);

  const { aboutMenuItem, aboutWindow } = useClassicyAboutMenu(APP_ID, APP_NAME, ClassicyIcons.applications.systemProfiler.app);

  const metricsPoll = usePolling(fetchMetrics, intervalSec * 1000, !paused);
  const procsPoll = usePolling(fetchProcesses, intervalSec * 1000, !paused);

  const handleLogout = useCallback(async () => {
    try {
      await logout();
    } catch {
      // 登出接口失败也照常回到登录页（如 token 已过期）
    }
    onLogout();
  }, [onLogout]);

  // 会话失效（401）→ 回到登录
  useEffect(() => {
    if (metricsPoll.error instanceof Unauthorized || procsPoll.error instanceof Unauthorized) {
      handleLogout();
    }
  }, [metricsPoll.error, procsPoll.error, handleLogout]);

  const appMenu = useMemo(
    () => [
      {
        id: 'monitor-menu',
        title: APP_NAME,
        menuChildren: [
          aboutMenuItem,
          { id: 'spacer' },
          quitMenuItem(APP_ID, APP_NAME, ClassicyIcons.applications.systemProfiler.app),
        ],
      },
    ],
    [aboutMenuItem]
  );

  const m = metricsPoll.data;

  // 文档标题同步主机名：metrics 就绪后为「WatchDog OS · <主机名>」，否则保持产品名。
  // 主机名只来自已鉴权的 /api/metrics，未登录阶段（LoginApp）不暴露。
  // MonitorApp 常驻挂载于桌面，轮询不受窗口开闭影响，标题因此登录即更新。
  useEffect(() => {
    document.title = m ? `${APP_NAME} · ${m.host.hostname}` : APP_NAME;
  }, [m]);

  return (
    <ClassicyApp id={APP_ID} name={APP_NAME} icon={ClassicyIcons.applications.systemProfiler.app} defaultWindow="monitor-main">
      <ClassicyWindow
        id="monitor-main"
        title={m ? `${APP_NAME} · ${m.host.hostname}` : APP_NAME}
        icon={ClassicyIcons.applications.systemProfiler.app}
        appId={APP_ID}
        scrollable
        resizable
        zoomable
        collapsable
        closable
        initialSize={[820, 620]}
        initialPosition={['center', 'center']}
        minimumSize={[640, 460]}
        appMenu={appMenu}
      >
        <div className="sp-block">
          <ClassicyControlGroup label="Refresh">
            <div className="sp-controls">
              <div className="sp-ctrl">
                <ClassicyPopUpMenu
                  id="sp-refresh-interval"
                  label="Refresh Interval"
                  labelPosition="left"
                  size="small"
                  options={INTERVALS.map((s) => ({ value: String(s), label: `${s}s` }))}
                  selected={String(intervalSec)}
                  onChangeFunc={(e) => setIntervalSec(parseInt(e.target.value, 10))}
                />
              </div>
              <div className="sp-ctrl">
                <ClassicyButton buttonSize="small" margin="sm" onClickFunc={() => setPaused((p) => !p)}>
                  {paused ? '▶ Resume' : '⏸ Pause'}
                </ClassicyButton>
              </div>
              <div className="sp-ctrl">
                <ClassicyButton buttonSize="small" margin="sm" onClickFunc={() => { metricsPoll.reload(); procsPoll.reload(); }}>
                  Refresh Now
                </ClassicyButton>
              </div>
              <span className="sp-pulse" style={{ flex: '0 0 auto' }} hidden={!paused}>Paused</span>
            </div>
          </ClassicyControlGroup>
        </div>

        <div className="sp-block">
          {m ? (
            <>
              <SystemInfoPanel host={m.host} temps={m.temps} />
              <div className="sp-block">
                <ResourcesPanel metrics={m} />
              </div>
            </>
          ) : (
            <p className="sp-dim">Loading…</p>
          )}
        </div>

        <div className="sp-block">
          <ProcessPanel processes={procsPoll.data} />
        </div>
      </ClassicyWindow>
      {aboutWindow}
    </ClassicyApp>
  );
}

