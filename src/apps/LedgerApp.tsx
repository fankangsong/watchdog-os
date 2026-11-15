import { useCallback, useEffect, useMemo, useRef, useState, type MouseEventHandler } from 'react';
import {
  ClassicyApp,
  ClassicyTabs,
  ClassicyWindow,
  useClassicyAboutMenu,
  useClassicyEditMenu,
  type ClassicyMenuItem,
} from 'classicy';
import {
  createLedgerBackup,
  fetchLedgerMeta,
  fetchLedgerStatus,
  Unauthorized,
  type LedgerMeta,
  type LedgerStatus,
} from '../api';
import ledgerIcon from '../assets/icons/ledger.svg?no-inline';
import { useAppOpen } from '../hooks/useAppOpen';
import { quitMenuItem } from '../quitMenuItem';
import { fmtClock } from '../format';
import { LedgerImportTab } from '../components/LedgerImportTab';
import { LedgerDetailTab } from '../components/LedgerDetailTab';
import { LedgerReportTab } from '../components/LedgerReportTab';
import { LedgerMaintenanceTab } from '../components/LedgerMaintenanceTab';

const APP_ID = 'srv-ledger.app';
const APP_NAME = 'Ledger';
/** 应用图标：自绘 SVG（金币：厚度 + 16 齿滚花币缘 + ¥ 压印；由 tools/pixel-icon.py 生成），见 src/assets/icons/ledger.svg */
const ICON = ledgerIcon;

type TabKey = 'import' | 'transactions' | 'reports' | 'maintenance';

/**
 * Tab 标题即 ClassicyTabs 生成的按钮 id 前缀（`${title}-tab`），供 View 菜单定位并切换。
 * 顺序即界面顺序：Import 放在第 3 位（先查流水 / 看报表，再回到导入）。
 */
const TAB_DEFS: { key: TabKey; title: string }[] = [
  { key: 'transactions', title: 'Transactions' },
  { key: 'reports', title: 'Reports' },
  { key: 'import', title: 'Import' },
  { key: 'maintenance', title: 'Maintenance' },
];

/**
 * 应用：财务账本（CSV 导入 / 流水明细 / 报表 / 备份恢复）。
 * 全部数据经 api.ts；用 useAppOpen 门控请求，任一子组件 Unauthorized → onLogout。
 * 成功后 bumpRefresh() 递增 refreshKey，触发其它 Tab 重载（元数据 / 流水 / 报表 / 备份列表）。
 */
export function LedgerApp({ onLogout }: { onLogout?: () => void }) {
  const open = useAppOpen(APP_ID);
  // ClassicyTabs 非受控且默认选中第一项，初始值须与 TAB_DEFS[0] 一致，否则 View 菜单勾选错位
  const [activeTab, setActiveTab] = useState<TabKey>('transactions');
  const [refreshKey, setRefreshKey] = useState(0);
  const [meta, setMeta] = useState<LedgerMeta | null>(null);
  const [status, setStatus] = useState<LedgerStatus | null>(null);
  const [loadError, setLoadError] = useState<Error | null>(null);
  const [lastUpdated, setLastUpdated] = useState(0);
  const [notice, setNotice] = useState<{ text: string; isError: boolean } | null>(null);
  const [backupBusy, setBackupBusy] = useState(false);
  const tabsHostRef = useRef<HTMLDivElement>(null);

  const { aboutMenuItem, aboutWindow } = useClassicyAboutMenu(APP_ID, APP_NAME, ICON);
  // 有标准文本输入，注册系统 Edit 菜单（Undo / Cut / Copy / Paste / Select All）
  const editMenu = useClassicyEditMenu('ledger');

  const bumpRefresh = useCallback(() => setRefreshKey((k) => k + 1), []);

  /** 导入 / 改类别 / 恢复成功：状态栏提示 + 让其它 Tab 重载 */
  const handleChanged = useCallback(
    (msg: string) => {
      setNotice({ text: msg, isError: false });
      bumpRefresh();
    },
    [bumpRefresh]
  );

  /** 子组件错误统一入口：Unauthorized → 登出；其余 → 状态栏红字（不弹 alert） */
  const handleError = useCallback(
    (e: unknown) => {
      if (e instanceof Unauthorized) {
        onLogout?.();
        return;
      }
      setNotice({ text: e instanceof Error ? e.message : String(e), isError: true });
    },
    [onLogout]
  );

  // 元数据 + 连接状态：仅在本应用启动期间加载；refreshKey 变化（导入/恢复后）重新拉取
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    Promise.all([fetchLedgerMeta(), fetchLedgerStatus()])
      .then(([m, s]) => {
        if (cancelled) return;
        setMeta(m);
        setStatus(s);
        setLoadError(null);
        setLastUpdated(Date.now());
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        if (e instanceof Unauthorized) {
          onLogout?.();
          return;
        }
        setLoadError(e instanceof Error ? e : new Error(String(e)));
      });
    return () => {
      cancelled = true;
    };
  }, [open, refreshKey, onLogout]);

  /** File > Backup Database…：直接创建一份手动备份并刷新各 Tab */
  const doBackupNow = useCallback(async () => {
    setBackupBusy(true);
    try {
      await createLedgerBackup();
      handleChanged('已创建数据库备份');
    } catch (e) {
      handleError(e);
    } finally {
      setBackupBusy(false);
    }
  }, [handleChanged, handleError]);

  /**
   * ClassicyTabs 为非受控组件（内部 useState 记录选中项），无法用 props 切换。
   * View 菜单通过 tab 按钮的稳定 id（`${title}-tab`）派发一次真实鼠标按下/抬起，
   * 触发组件内部切换，从而与菜单 checked 保持一致。
   */
  const selectTab = useCallback((key: TabKey) => {
    setActiveTab(key);
    const title = TAB_DEFS.find((d) => d.key === key)?.title;
    if (!title) return;
    const btn = tabsHostRef.current?.querySelector<HTMLButtonElement>(`[id="${title}-tab"]`);
    if (btn) {
      btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      btn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    }
  }, []);

  // 用户直接点 Tab 条时同步 View 菜单的 checked 标记
  const syncActiveTab: MouseEventHandler<HTMLDivElement> = (e) => {
    const target = e.target as HTMLElement | null;
    const btn = target?.closest?.('[role="tab"]') as HTMLElement | null;
    const id = btn?.id ?? '';
    if (!id.endsWith('-tab')) return;
    const def = TAB_DEFS.find((d) => `${d.title}-tab` === id);
    if (def) setActiveTab(def.key);
  };

  const tabs = useMemo(
    () => [
      {
        title: 'Transactions',
        children: meta ? (
          <LedgerDetailTab meta={meta} refreshKey={refreshKey} onChanged={handleChanged} onError={handleError} />
        ) : (
          <p className="sp-dim sp-ledger-pad">正在加载账本元数据…</p>
        ),
      },
      {
        title: 'Reports',
        children: meta ? (
          <LedgerReportTab meta={meta} refreshKey={refreshKey} onError={handleError} />
        ) : (
          <p className="sp-dim sp-ledger-pad">正在加载账本元数据…</p>
        ),
      },
      {
        title: 'Import',
        children: <LedgerImportTab onImported={handleChanged} onError={handleError} />,
      },
      {
        title: 'Maintenance',
        children: (
          <LedgerMaintenanceTab refreshKey={refreshKey} onChanged={handleChanged} onError={handleError} />
        ),
      },
    ],
    [meta, refreshKey, handleChanged, handleError]
  );

  const appMenu = useMemo<ClassicyMenuItem[]>(
    () => [
      {
        id: 'ledger-menu',
        title: APP_NAME,
        menuChildren: [aboutMenuItem, { id: 'spacer' }, quitMenuItem(APP_ID, APP_NAME, ICON)],
      },
      {
        id: 'ledger-file',
        title: 'File',
        menuChildren: [
          {
            id: 'ledger-m-backup',
            title: 'Backup Database…',
            disabled: backupBusy,
            onClickFunc: () => {
              void doBackupNow();
            },
          },
        ],
      },
      editMenu,
      {
        id: 'ledger-view',
        title: 'View',
        menuChildren: [
          { id: 'ledger-m-refresh', title: 'Refresh', checked: false, onClickFunc: bumpRefresh },
          { id: 'spacer' },
          ...TAB_DEFS.map((d) => ({
            id: `ledger-m-tab-${d.key}`,
            title: d.title,
            checked: activeTab === d.key,
            onClickFunc: () => selectTab(d.key),
          })),
        ],
      },
    ],
    [aboutMenuItem, editMenu, backupBusy, doBackupNow, bumpRefresh, activeTab, selectTab]
  );

  // 状态栏左区：错误优先（保留旧数据），其次成功提示，最后常规上下文
  const statusText = notice
    ? notice.text
    : loadError
      ? `连接失败：${loadError.message}${meta ? '（显示上次数据）' : ''}`
      : '就绪';
  const statusIsError = (notice?.isError ?? false) || !!loadError;
  const connText = status ? `已连接 · 引擎 ${status.engine || 'SQLite'}` : '未连接';
  const rightText = `${connText}${lastUpdated ? ` · 更新 ${fmtClock(lastUpdated)}` : ''}`;

  return (
    <ClassicyApp id={APP_ID} name={APP_NAME} icon={ICON} defaultWindow="ledger-main">
      <ClassicyWindow
        id="ledger-main"
        title={APP_NAME}
        icon={ICON}
        appId={APP_ID}
        scrollable={false}
        resizable
        zoomable
        collapsable
        closable
        initialSize={[980, 640]}
        initialPosition={['center', 'center']}
        minimumSize={[760, 480]}
        appMenu={appMenu}
      >
        <div className="sp-ledger-body">
          <div className="sp-ledger-tabs-host" ref={tabsHostRef} onMouseUpCapture={syncActiveTab}>
            {/* 不用 size="small"：16px 高的按钮会把标签文字下沿裁掉半截（见 styles.css 说明） */}
            <ClassicyTabs tabs={tabs} />
          </div>
        </div>

        {/* 状态栏（双区）：左上下文 / 右连接与更新时间 */}
        <div className="sp-ledger-status">
          <span className={statusIsError ? 'sp-ledger-status-err' : undefined}>{statusText}</span>
          <span>{rightText}</span>
        </div>
      </ClassicyWindow>
      {aboutWindow}
    </ClassicyApp>
  );
}
