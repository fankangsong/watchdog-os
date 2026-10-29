import { useEffect, useMemo, useState } from 'react';
import { ClassicyIcons, dispatch, useAppManager } from 'classicy';
import { monitorPoll } from '../polls';
import { useSharedPoll } from '../sharedPoll';
import { homeIcons, isHomeVisible, primaryWindowId } from './shellModel';

/** 首页底部状态条的时钟：独立组件 + 自身定时器，避免秒级刷新带动整个图标网格重渲染 */
function HomeClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  return <span className="sp-m-clock">{now.toTimeString().slice(0, 8)}</span>;
}

/**
 * 手机首页：图标网格替代「自由摆放的桌面图标」。
 *
 * 为什么不用 classicy 自带的桌面图标：
 * `.classicyDesktopIcon` 是 `#classicyDesktop` 的直接子元素、靠内联 top/left 绝对定位，
 * 与窗口共用同一个父节点，无法用 CSS 网格化；且它绑定的是鼠标事件（单击选中 / 双击打开 /
 * 拖拽框选），在触屏上双击判定与拖拽框选都不成立。这里读同一份 store 数据重排，
 * 打开动作沿用图标自带的 event/eventData，因此新增 app 不需要改这份代码。
 */
export function MobileHome() {
  const icons = useAppManager((s) => s.System.Manager.Desktop.icons);
  const apps = useAppManager((s) => s.System.Manager.Applications.apps);
  const monitor = useSharedPoll(monitorPoll);
  const hostname = monitor.data?.metrics?.host?.hostname ?? '';

  const entries = useMemo(() => homeIcons(icons), [icons]);

  // 有任意未关闭窗口即让位给「单 app 全屏」，回到首页由关闭窗口 / 悬浮键触发
  if (!isHomeVisible(apps)) return null;

  const open = (entry: (typeof entries)[number]) => {
    if (entry.action.type === 'event') {
      dispatch({ type: entry.action.event, ...entry.action.eventData });
      return;
    }
    const appId = entry.action.app.id;
    dispatch({ type: 'ClassicyAppOpen', app: entry.action.app });
    // 打开 app 会把它的所有窗口一起展开并逐个聚焦（详情见 shellModel.primaryWindowId），
    // 手机上窗口全屏叠放，必须把主窗口重新置顶，否则会被常驻的次窗（如 Favorites）盖住
    const primary = primaryWindowId(apps[appId]);
    if (primary) {
      dispatch({ type: 'ClassicyWindowFocus', app: { id: appId }, window: { id: primary } });
    }
  };

  return (
    <div className="sp-m-home" role="navigation" aria-label="Applications">
      <div className="sp-m-home-head">
        <img className="sp-m-home-logo" src={ClassicyIcons.applications.systemProfiler.app} alt="" />
        <div className="sp-m-home-brand">
          <h1 className="sp-m-home-title">WatchDog OS</h1>
          <p className="sp-m-home-sub">{hostname || 'Server Console'}</p>
        </div>
      </div>

      <div className="sp-m-grid">
        {entries.map((entry) => (
          <button
            key={entry.key}
            type="button"
            className="sp-m-icon"
            onClick={() => open(entry)}
            title={entry.label}
          >
            <img className="sp-m-icon-img" src={entry.icon} alt="" />
            <span className="sp-m-icon-label">{entry.label}</span>
          </button>
        ))}
        {entries.length === 0 && <p className="sp-m-empty">No applications available.</p>}
      </div>

      <div className="sp-m-status">
        <span
          className={monitor.error ? 'sp-m-led sp-m-led-off' : 'sp-m-led sp-m-led-on'}
          aria-hidden="true"
        />
        <span className="sp-m-status-text">{hostname || 'WatchDog OS'}</span>
        <HomeClock />
      </div>
    </div>
  );
}
