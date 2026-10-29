import { useEffect, useMemo, useState } from 'react';
import {
  ClassicyApp,
  ClassicyButton,
  ClassicyControlGroup,
  ClassicyInput,
  ClassicyPopUpMenu,
  ClassicyWindow,
  useClassicyAboutMenu,
} from 'classicy';
import {
  downloadAuditCsv,
  fetchAuditLog,
  Unauthorized,
  type AuditResultFilter,
  type AuditTypeFilter,
} from '../api';
import auditIcon from '../assets/icons/audit.svg?no-inline';
import { usePolling } from '../hooks/usePolling';
import { quitMenuItem } from '../quitMenuItem';
import { AuditAnomalies, AuditEventsTable, AuditOverview, AuditSourcesTable } from '../components/AuditPanels';
import { AuditTrendChart, type AuditTrendPoint } from '../components/AuditTrendChart';
import { fmtClock } from '../format';

const APP_ID = 'srv-audit.app';
const APP_NAME = 'Audit Log';
/** 应用图标：自绘 SVG（Mac OS 9 窗口 + 日志纸 + 结果标记 + 放大镜），见 src/assets/icons/audit.svg */
const ICON = auditIcon;

/** 审计数据变化不快（登录是低频事件），15s 一轮足够，避免无意义 IO */
const POLL_MS = 15000;

const RANGES = [
  { value: '1', label: 'Today' },
  { value: '7', label: '7 Days' },
  { value: '30', label: '30 Days' },
  { value: '0', label: 'All' },
];

const TYPES = [
  { value: 'all', label: 'All Events' },
  { value: 'login', label: 'Sign In' },
  { value: 'logout', label: 'Sign Out' },
  { value: 'unauthorized', label: 'Unauthorized' },
];

const RESULTS = [
  { value: 'all', label: 'All Results' },
  { value: 'success', label: 'Success' },
  { value: 'failure', label: 'Failure' },
];

/**
 * 应用：登录审计日志审查与分析。
 * 数据源 /api/audit/login-log（服务端按天读 JSONL 并聚合），CSV 导出走同参数的 .csv 变体。
 */
export function AuditApp({ onLogout }: { onLogout?: () => void }) {
  const [days, setDays] = useState('7');
  const [type, setType] = useState<AuditTypeFilter>('all');
  const [result, setResult] = useState<AuditResultFilter>('all');
  /** 已生效的 IP 关键字（输入框内容不直接参与请求，回车 / 点 Filter 才应用） */
  const [ip, setIp] = useState('');
  const [ipDraft, setIpDraft] = useState('');
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState('');

  const query = useMemo(() => ({ days: Number(days), type, ok: result, ip, limit: 300 }), [days, type, result, ip]);
  const poll = usePolling(() => fetchAuditLog(query), POLL_MS);

  const { aboutMenuItem, aboutWindow } = useClassicyAboutMenu(APP_ID, APP_NAME, ICON);

  useEffect(() => {
    if (poll.error instanceof Unauthorized) onLogout?.();
  }, [poll.error, onLogout]);

  const data = poll.data;

  const refresh = () => poll.reload();

  const applyIp = () => {
    setIp(ipDraft.trim());
    // 生效值变化后立即重拉（fetcher 在下一次渲染后读取新闭包）
    poll.reload();
  };

  const onExport = async () => {
    setExporting(true);
    setExportError('');
    try {
      await downloadAuditCsv(query);
    } catch (e) {
      if (e instanceof Unauthorized) return onLogout?.();
      setExportError(e instanceof Error ? e.message : String(e));
    } finally {
      setExporting(false);
    }
  };

  const appMenu = useMemo(
    () => [
      {
        id: 'audit-menu',
        title: APP_NAME,
        menuChildren: [aboutMenuItem, { id: 'spacer' }, quitMenuItem(APP_ID, APP_NAME, ICON)],
      },
    ],
    [aboutMenuItem]
  );

  // 趋势图数据：按天（MM-DD 标签）与按小时（HH 标签）
  const dayPoints = useMemo<AuditTrendPoint[]>(
    () => (data?.stats.byDay ?? []).map((d) => ({ label: d.day.slice(5), success: d.success, failures: d.failures })),
    [data]
  );
  const hourPoints = useMemo<AuditTrendPoint[]>(
    () =>
      (data?.stats.byHour ?? []).map((h) => ({
        label: String(h.hour).padStart(2, '0'),
        success: h.success,
        failures: h.failures,
      })),
    [data]
  );

  // 状态栏左区：错误优先（保留上次数据），其次当前筛选下的条目数
  let statusText: string;
  let statusIsError = false;
  if (poll.error) {
    statusText = `Refresh failed: ${poll.error.message}${data ? ' (showing last data)' : ''}`;
    statusIsError = true;
  } else if (exportError) {
    statusText = `Export failed: ${exportError}`;
    statusIsError = true;
  } else if (!data) {
    statusText = 'Loading…';
  } else if (!data.enabled) {
    statusText = 'Login audit disabled on server (LOGIN_LOG_ENABLED=false)';
    statusIsError = true;
  } else if (data.error) {
    statusText = `Log write error: ${data.error}`;
    statusIsError = true;
  } else {
    statusText = `${data.entries.length} events shown${data.meta.truncated ? ' · older entries truncated' : ''}`;
  }

  return (
    <ClassicyApp id={APP_ID} name={APP_NAME} icon={ICON} defaultWindow="audit-main">
      <ClassicyWindow
        id="audit-main"
        title={APP_NAME}
        icon={ICON}
        appId={APP_ID}
        scrollable={false}
        resizable
        zoomable
        collapsable
        closable
        initialSize={[900, 620]}
        initialPosition={['center', 'center']}
        minimumSize={[700, 460]}
        appMenu={appMenu}
      >
        {/* 窗口操作按钮带（规范 §3.2）：筛选与导出不随内容滚动 */}
        <div className="sp-toolbar sp-audit-toolbar">
          <ClassicyPopUpMenu
            id="sp-audit-range"
            className="sp-audit-sel-range"
            label="Range"
            labelPosition="left"
            labelSize="small"
            size="small"
            options={RANGES}
            selected={days}
            onChangeFunc={(e) => {
              setDays(e.target.value);
              refresh();
            }}
          />
          <ClassicyPopUpMenu
            id="sp-audit-type"
            className="sp-audit-sel-type"
            label="Event"
            labelPosition="left"
            labelSize="small"
            size="small"
            options={TYPES}
            selected={type}
            onChangeFunc={(e) => {
              setType(e.target.value as AuditTypeFilter);
              refresh();
            }}
          />
          <ClassicyPopUpMenu
            id="sp-audit-result"
            className="sp-audit-sel-result"
            label="Result"
            labelPosition="left"
            labelSize="small"
            size="small"
            options={RESULTS}
            selected={result}
            onChangeFunc={(e) => {
              setResult(e.target.value as AuditResultFilter);
              refresh();
            }}
          />
          <ClassicyButton onClickFunc={refresh}>Refresh</ClassicyButton>
          <ClassicyButton disabled={exporting || !data?.enabled} onClickFunc={onExport}>
            {exporting ? 'Exporting…' : 'Export CSV'}
          </ClassicyButton>
          <span className="sp-toolbar-status sp-audit-retention">
            {data ? `Retain ${data.meta.retentionDays}d` : ''}
          </span>
        </div>

        <div className="sp-audit-body">
          {!data && !poll.error && <p className="sp-dim">Loading…</p>}

          {data && !data.enabled && (
            <p className="sp-dim">
              Login audit is turned off on the server. Set LOGIN_LOG_ENABLED=true in .env to start recording.
            </p>
          )}

          {data && data.enabled && (
            <>
              <ClassicyControlGroup label="Overview" variant="primary">
                <AuditOverview stats={data.stats} />
              </ClassicyControlGroup>

              <ClassicyControlGroup label="Sign-ins by Day" variant="primary">
                <div className="sp-audit-legend">
                  <span>
                    <i style={{ background: '#1f9d55' }} />
                    Success
                  </span>
                  <span>
                    <i style={{ background: '#dc2626' }} />
                    Failure
                  </span>
                </div>
                <AuditTrendChart points={dayPoints} />
              </ClassicyControlGroup>

              <ClassicyControlGroup label="Activity by Hour" variant="primary">
                <AuditTrendChart points={hourPoints} />
              </ClassicyControlGroup>

              <ClassicyControlGroup label="Top Sources" variant="primary">
                <AuditSourcesTable sources={data.stats.topSources} />
              </ClassicyControlGroup>

              <ClassicyControlGroup label="Anomalies" variant="primary">
                <AuditAnomalies
                  bruteForce={data.stats.anomalies.bruteForce}
                  newSources={data.stats.anomalies.newSources}
                  windowMinutes={data.meta.bruteWindowMinutes || 10}
                />
              </ClassicyControlGroup>

              <ClassicyControlGroup label={`Events (${data.entries.length})`} variant="primary">
                <div className="sp-audit-filter">
                  <ClassicyInput
                    id="sp-audit-ip"
                    labelTitle="Source IP"
                    labelSize="small"
                    labelPosition="left"
                    placeholder="Filter by IP…"
                    prefillValue={ipDraft}
                    onChangeFunc={(e) => setIpDraft(e.target.value)}
                    onEnterFunc={applyIp}
                  />
                  <ClassicyButton buttonSize="small" onClickFunc={applyIp}>
                    Filter
                  </ClassicyButton>
                  {(ip || ipDraft) && (
                    <ClassicyButton
                      buttonSize="small"
                      onClickFunc={() => {
                        setIp('');
                        setIpDraft('');
                        poll.reload();
                      }}
                    >
                      Clear
                    </ClassicyButton>
                  )}
                </div>
                <AuditEventsTable events={data.entries} />
              </ClassicyControlGroup>
            </>
          )}
        </div>

        {/* 状态栏（规范 §7.1 双区）：左上下文 / 右全局 */}
        <div className="sp-audit-status">
          <span className={statusIsError ? 'sp-audit-status-err' : undefined}>{statusText}</span>
          <span>{data ? `Updated ${fmtClock(data.meta.generatedAt)}` : ''}</span>
        </div>
      </ClassicyWindow>
      {aboutWindow}
    </ClassicyApp>
  );
}
