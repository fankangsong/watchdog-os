import { useMemo } from 'react';
import { ClassicyTable, type ClassicyTableColumn } from 'classicy';
import type { AuditBruteForce, AuditEvent, AuditNewSource, AuditSource, AuditStats } from '../api';
import { AUDIT_FAIL_COLOR, AUDIT_OK_COLOR, AUDIT_UNAUTH_COLOR, fmtDateTime } from '../format';

/** 事件类型 → 界面文案（英文 Title Case，与全窗口一致） */
const EVENT_LABEL: Record<AuditEvent['type'], string> = {
  login: 'Sign In',
  logout: 'Sign Out',
  unauthorized: 'Unauthorized',
};

/** 失败率染色：>30% 红、>10% 琥珀，其余绿（只有明确异常才用告警色） */
function failureRateColor(rate: number): string {
  if (rate > 30) return AUDIT_FAIL_COLOR;
  if (rate > 10) return '#d97706';
  return AUDIT_OK_COLOR;
}

/** 概览指标卡：大号数值 + 小号灰色标签（窄窗口自动换行） */
export function AuditOverview({ stats }: { stats: AuditStats }) {
  const cards = [
    { label: 'Sign-ins', value: String(stats.success), color: AUDIT_OK_COLOR },
    { label: 'Failures', value: String(stats.failures), color: AUDIT_FAIL_COLOR },
    { label: 'Failure Rate', value: `${stats.failureRate}%`, color: failureRateColor(stats.failureRate) },
    { label: 'Unauthorized', value: String(stats.unauthorized), color: AUDIT_UNAUTH_COLOR },
    { label: 'Sources', value: String(stats.sources), color: '#202020' },
  ];
  return (
    <div className="sp-audit-cards">
      {cards.map((c) => (
        <div className="sp-audit-card" key={c.label}>
          <span className="sp-audit-card-value" style={{ color: c.color }}>
            {c.value}
          </span>
          <span className="sp-audit-card-label">{c.label}</span>
        </div>
      ))}
    </div>
  );
}

/** 来源排行：次数 / 失败数 / 首次与最近出现（按次数降序，服务端已排序） */
export function AuditSourcesTable({ sources }: { sources: AuditSource[] }) {
  const columns = useMemo<ClassicyTableColumn<AuditSource>[]>(
    () => [
      {
        id: 'ip',
        title: 'Source',
        accessor: (s) => s.ip,
        width: 170,
        render: (s) => <span className="sp-audit-mono">{s.ip}</span>,
      },
      { id: 'total', title: 'Total', accessor: (s) => s.total, width: 70, align: 'right' },
      {
        id: 'failures',
        title: 'Failures',
        accessor: (s) => s.failures,
        width: 80,
        align: 'right',
        render: (s) => (
          <span style={{ color: s.failures > 0 ? AUDIT_FAIL_COLOR : undefined, fontWeight: s.failures > 0 ? 700 : 400 }}>
            {s.failures}
          </span>
        ),
      },
      {
        id: 'first',
        title: 'First Seen',
        accessor: (s) => s.firstSeen,
        width: 150,
        render: (s) => <span className="sp-audit-mono">{fmtDateTime(s.firstSeen)}</span>,
      },
      {
        id: 'last',
        title: 'Last Seen',
        accessor: (s) => s.lastSeen,
        width: 150,
        render: (s) => <span className="sp-audit-mono">{fmtDateTime(s.lastSeen)}</span>,
      },
    ],
    []
  );
  if (sources.length === 0) return <p className="sp-dim sp-audit-pad">No sources in range</p>;
  return (
    <div className="sp-audit-table">
      <ClassicyTable columns={columns} rows={sources} getRowId={(s) => s.ip} />
    </div>
  );
}

/** 异常检测：疑似暴力破解（红标）+ 陌生来源（黄标） */
export function AuditAnomalies({
  bruteForce,
  newSources,
  windowMinutes,
}: {
  bruteForce: AuditBruteForce[];
  newSources: AuditNewSource[];
  windowMinutes: number;
}) {
  if (bruteForce.length === 0 && newSources.length === 0) {
    return <p className="sp-dim sp-audit-pad">No anomalies detected</p>;
  }
  return (
    <div className="sp-audit-anomalies">
      {bruteForce.map((b) => (
        <div className="sp-audit-anomaly" key={`b-${b.ip}`}>
          <span className="sp-audit-badge danger">Brute Force</span>
          <span className="sp-audit-mono">{b.ip}</span>
          <span>
            {b.count} failed sign-ins within {windowMinutes}m · {fmtDateTime(b.firstSeen)} → {fmtDateTime(b.lastSeen)}
          </span>
        </div>
      ))}
      {newSources.map((n) => (
        <div className="sp-audit-anomaly" key={`n-${n.ip}`}>
          <span className="sp-audit-badge note">New Source</span>
          <span className="sp-audit-mono">{n.ip}</span>
          <span>first seen {fmtDateTime(n.firstSeen)}</span>
        </div>
      ))}
    </div>
  );
}

/** 客户端 UA 压缩展示：过长时截断，完整内容放 title */
function shortUa(ua: string): string {
  if (!ua) return '—';
  return ua.length > 34 ? `${ua.slice(0, 34)}…` : ua;
}

/** 事件明细表：时间 / 事件 / 结果 / 来源 / 路径 / 客户端 / 耗时 */
export function AuditEventsTable({ events }: { events: AuditEvent[] }) {
  const columns = useMemo<ClassicyTableColumn<AuditEvent>[]>(
    () => [
      {
        id: 'time',
        title: 'Time',
        accessor: (e) => e.t,
        width: 150,
        render: (e) => <span className="sp-audit-mono">{fmtDateTime(e.t)}</span>,
      },
      {
        id: 'event',
        title: 'Event',
        accessor: (e) => EVENT_LABEL[e.type] || e.type,
        width: 110,
      },
      {
        id: 'result',
        title: 'Result',
        accessor: (e) => (e.ok ? 'Success' : 'Failure'),
        width: 80,
        render: (e) => (
          <span style={{ color: e.ok ? AUDIT_OK_COLOR : AUDIT_FAIL_COLOR, fontWeight: 700 }}>
            {e.ok ? 'Success' : 'Failure'}
          </span>
        ),
      },
      {
        id: 'source',
        title: 'Source',
        accessor: (e) => e.ip,
        width: 130,
        render: (e) => (
          <span className="sp-audit-mono" title={e.remoteIp && e.remoteIp !== e.ip ? `direct: ${e.remoteIp}` : undefined}>
            {e.ip || '—'}
            {e.count > 1 ? <b className="sp-audit-count"> ×{e.count}</b> : null}
          </span>
        ),
      },
      {
        id: 'path',
        title: 'Path',
        accessor: (e) => e.path,
        width: 150,
        render: (e) => (
          <span className="sp-audit-ellipsis sp-audit-mono" title={e.path}>
            {e.path || '—'}
          </span>
        ),
      },
      {
        id: 'client',
        title: 'Client',
        accessor: (e) => e.ua,
        render: (e) => (
          <span className="sp-audit-ellipsis" title={e.ua}>
            {shortUa(e.ua)}
          </span>
        ),
      },
      {
        id: 'took',
        title: 'Took',
        accessor: (e) => e.durationMs ?? -1,
        width: 72,
        align: 'right',
        render: (e) => (
          <span className="sp-audit-mono">{e.durationMs == null ? '—' : `${e.durationMs} ms`}</span>
        ),
      },
    ],
    []
  );

  if (events.length === 0) return <p className="sp-dim sp-audit-pad">No events match the current filters</p>;
  return (
    <div className="sp-audit-table">
      <ClassicyTable
        columns={columns}
        rows={events}
        getRowId={(e) => `${e.t}-${e.type}-${e.ip}-${e.path}-${e.count}`}
      />
    </div>
  );
}
