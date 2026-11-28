import { useMemo } from 'react';
import type { Processes, ProcItem } from '../api';
import { fmtBytes, levelColor, MEM_COLOR } from '../format';

type Metric = 'cpu' | 'mem';

/** 进程名：命令行取路径末段（Windows / POSIX 分隔符都认），空命令回退原文 */
function baseName(cmd: string): string {
  const parts = cmd.split(/[\\/]/);
  return parts[parts.length - 1] || cmd;
}

function metricValue(p: ProcItem, metric: Metric): number {
  return metric === 'cpu' ? p.cpuPct : p.mem;
}

/**
 * Top 进程横向条形图：CPU / 内存两种度量共用。
 * 条长按「当前榜单最大值」归一（小值也可见），右侧始终显示真实值；
 * CPU 阈值配色复用 levelColor，内存用固定 MEM_COLOR。
 */
export function ProcessBars({
  processes,
  metric,
  limit = 6,
}: {
  processes: Processes | null;
  metric: Metric;
  limit?: number;
}) {
  const rows = useMemo(() => {
    if (!processes || !processes.available) return [];
    return [...processes.list]
      .sort((a, b) => metricValue(b, metric) - metricValue(a, metric))
      .slice(0, limit);
  }, [processes, metric, limit]);

  if (!processes) return <p className="sp-dim">Loading…</p>;
  if (!processes.available) {
    return <p className="sp-dim">{processes.error || 'Process data unavailable'}</p>;
  }
  if (rows.length === 0) return <p className="sp-dim">No processes.</p>;

  const max = Math.max(...rows.map((p) => metricValue(p, metric)), 1);

  return (
    <div className="sp-procbars">
      {rows.map((p) => {
        const v = metricValue(p, metric);
        return (
          <div className="sp-procbar" key={p.pid} title={p.cmd}>
            <span className="sp-procbar-name">{baseName(p.cmd)}</span>
            <span className="sp-procbar-track">
              <span
                className="sp-procbar-fill"
                style={{
                  width: `${Math.min(v / max, 1) * 100}%`,
                  background: metric === 'cpu' ? levelColor(p.cpuPct) : MEM_COLOR,
                }}
              />
            </span>
            <span className="sp-procbar-val">
              {metric === 'cpu' ? `${p.cpuPct.toFixed(1)}%` : fmtBytes(p.mem)}
            </span>
          </div>
        );
      })}
    </div>
  );
}
