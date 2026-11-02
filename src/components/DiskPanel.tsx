import { ClassicyMeter } from 'classicy';
import type { DiskItem } from '../api';
import { fmtBytes, levelColor } from '../format';

// 与 ResourcesPanel 同一组阈值：ClassicyMeter 在 low/high 间自动变色
const METER_BOUNDS = { low: 60, high: 80, optimum: 30 };

/**
 * 磁盘容量面板：每个挂载点一行（使用率 Meter + 已用/剩余/总量明细）。
 * - 数据来自 monitorPoll（/api/metrics 的 state.disks，后端每 10s statfs 采样）
 * - 单个挂载点 statfs 失败（error 非空 / total 为 0）时降级为错误行，不拖垮整个面板
 */
export function DiskPanel({ disks }: { disks: DiskItem[] | null }) {
  if (!disks) return <p className="sp-dim">Loading…</p>;

  const ok = disks.filter((d) => !d.error && d.total > 0);
  const bad = disks.filter((d) => d.error || d.total <= 0);
  const maxPct = ok.reduce((m, d) => Math.max(m, d.usagePct), 0);

  return (
    <div className="sp-disk-body">
      <p className="sp-disk-summary">
        {ok.length} mount{ok.length === 1 ? '' : 's'}
        {ok.length > 0 && (
          <>
            {' · peak '}
            <b style={{ color: levelColor(maxPct) }}>{maxPct.toFixed(1)}%</b>
          </>
        )}
        {bad.length > 0 && <>{` · ${bad.length} unreadable`}</>}
      </p>
      <div className="sp-disk-list">
        {ok.map((d) => (
          <div className="sp-disk-row" key={d.mount}>
            <div className="sp-disk-row-head">
              <span className="sp-disk-mount" title={d.mount}>{d.mount}</span>
              <span className="sp-disk-pct" style={{ color: levelColor(d.usagePct) }}>
                {d.usagePct.toFixed(1)}%
              </span>
            </div>
            <ClassicyMeter value={d.usagePct} showValue {...METER_BOUNDS} />
            <div className="sp-disk-detail">
              Used {fmtBytes(d.used)} · Free {fmtBytes(d.free)} · Total {fmtBytes(d.total)}
            </div>
          </div>
        ))}
        {bad.map((d) => (
          <div className="sp-disk-row sp-disk-row-error" key={d.mount}>
            <div className="sp-disk-row-head">
              <span className="sp-disk-mount" title={d.mount}>{d.mount}</span>
              <span className="sp-disk-err-text">{d.error || 'Unreadable'}</span>
            </div>
          </div>
        ))}
        {ok.length === 0 && bad.length === 0 && (
          <p className="sp-dim">No disks configured (set DISK_MOUNTS in .env)</p>
        )}
      </div>
    </div>
  );
}
