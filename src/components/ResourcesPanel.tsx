import { ClassicyControlGroup, ClassicyMeter } from 'classicy';
import type { Metrics, Processes } from '../api';
import { fmtBytes, levelColor, CPU_COLOR, MEM_COLOR } from '../format';
import { Gauge } from './Gauge';
import { HistoryChart } from './HistoryChart';
import { ProcessBars } from './ProcessBars';

const METER_BOUNDS = { low: 60, high: 80, optimum: 30 };

function loadText(loadavg: number[] | null): string {
  if (!loadavg || loadavg.length === 0) return 'n/a';
  return loadavg.slice(0, 3).map((v) => v.toFixed(2)).join(' / ');
}

function Stat({ k, v }: { k: string; v: string }) {
  return (
    <div className="sp-stat">
      <span className="sp-stat-key">{k}</span>
      <span className="sp-stat-val">{v}</span>
    </div>
  );
}

function GaugeBox({
  pct,
  text,
  color,
  label,
  large,
}: {
  pct: number;
  text: string;
  color: string;
  label: string;
  large?: boolean;
}) {
  return (
    <div className={large ? 'sp-gauge-box sp-gauge-box-lg' : 'sp-gauge-box'}>
      <Gauge pct={pct} text={text} color={color} />
      <div className="sp-gauge-label">{label}</div>
    </div>
  );
}

function ChartBlock({ history, tall }: { history: Metrics['history']; tall?: boolean }) {
  return (
    <div className={tall ? 'sp-chart-wrap sp-chart-tall' : 'sp-chart-wrap'}>
      <div className="sp-legend">
        <span><i style={{ background: CPU_COLOR }} />CPU History</span>
        <span><i style={{ background: MEM_COLOR }} />Memory History</span>
      </div>
      <HistoryChart points={history} />
    </div>
  );
}

// Overview：圆环仪表 + 历史曲线 + 关键统计 + Swap（图形优先的一屏概览）
export function OverviewPanel({ metrics }: { metrics: Metrics }) {
  const { cpu, mem, swap, history } = metrics;
  const cores = cpu.cores || [];

  return (
    <ClassicyControlGroup label="Resource Usage">
      <div className="sp-gauges">
        <GaugeBox pct={cpu.usage} text={`${cpu.usage.toFixed(1)}%`} color={CPU_COLOR} label="CPU" />
        <GaugeBox pct={mem.usagePct} text={`${mem.usagePct.toFixed(1)}%`} color={MEM_COLOR} label="Memory" />
        <ChartBlock history={history} />
      </div>

      <div className="sp-stats">
        <Stat k="Cores" v={cores.length > 0 ? String(cores.length) : '—'} />
        <Stat k="Load Avg (1/5/15)" v={loadText(cpu.loadavg)} />
        <Stat k="Memory Used" v={`${fmtBytes(mem.used)} / ${fmtBytes(mem.total)}`} />
        {swap && <Stat k="Swap Used" v={`${swap.usagePct.toFixed(1)}%`} />}
      </div>

      {swap && (
        <div className="sp-meters">
          <ClassicyMeter
            value={swap.usagePct}
            label={`Swap · ${fmtBytes(swap.used)} / ${fmtBytes(swap.total)}`}
            labelPosition="left"
            showValue
            {...METER_BOUNDS}
          />
        </div>
      )}
    </ClassicyControlGroup>
  );
}

// CPU：大号仪表 + 负载统计 + 加高历史曲线 + 每核心负载 + Top CPU 进程
export function CpuDetailPanel({ metrics, processes }: { metrics: Metrics; processes: Processes | null }) {
  const { cpu, history } = metrics;
  const cores = cpu.cores || [];

  return (
    <>
      <ClassicyControlGroup label="CPU">
        <div className="sp-detail-head">
          <GaugeBox large pct={cpu.usage} text={`${cpu.usage.toFixed(1)}%`} color={CPU_COLOR} label="CPU" />
          <div className="sp-stats">
            <Stat k="Usage" v={`${cpu.usage.toFixed(1)}%`} />
            <Stat k="Cores" v={cores.length > 0 ? String(cores.length) : '—'} />
            <Stat k="Load Avg (1/5/15)" v={loadText(cpu.loadavg)} />
          </div>
          <ChartBlock history={history} tall />
        </div>
      </ClassicyControlGroup>

      {cores.length > 0 && (
        <ClassicyControlGroup label="Core Load">
          <div className="sp-cores">
            {cores.map((v, i) => (
              <div className="sp-core" key={i} title={`Core ${i}: ${v}%`}>
                <span className="sp-core-name">C{i}</span>
                <div className="sp-core-bar">
                  <div
                    className="sp-core-fill"
                    style={{
                      width: `${Math.min(v, 100)}%`,
                      background: levelColor(v),
                      minWidth: v > 0 ? 6 : 0,
                    }}
                  />
                </div>
                <span className="sp-core-val">{v.toFixed(1)}%</span>
              </div>
            ))}
          </div>
        </ClassicyControlGroup>
      )}

      <ClassicyControlGroup label="Top Processes · CPU">
        <ProcessBars processes={processes} metric="cpu" />
      </ClassicyControlGroup>
    </>
  );
}

// Memory：大号仪表 + 用量统计 + 构成堆叠条 + 历史曲线 + Swap + Top 内存进程
export function MemoryDetailPanel({ metrics, processes }: { metrics: Metrics; processes: Processes | null }) {
  const { mem, swap, history } = metrics;
  const usedPct = Math.min(Math.max(mem.usagePct, 0), 100);
  const freePct = 100 - usedPct;

  return (
    <>
      <ClassicyControlGroup label="Memory">
        <div className="sp-detail-head">
          <GaugeBox
            large
            pct={mem.usagePct}
            text={`${mem.usagePct.toFixed(1)}%`}
            color={MEM_COLOR}
            label="Memory"
          />
          <div className="sp-stats">
            <Stat k="Used" v={fmtBytes(mem.used)} />
            <Stat k="Free" v={fmtBytes(mem.free)} />
            <Stat k="Total" v={fmtBytes(mem.total)} />
          </div>
          <ChartBlock history={history} tall />
        </div>

        <div className="sp-membar">
          <div className="sp-membar-track">
            <span style={{ width: `${usedPct}%`, background: MEM_COLOR }} />
            <span style={{ width: `${freePct}%`, background: 'var(--color-system-04)' }} />
          </div>
          <div className="sp-membar-legend">
            <span><i style={{ background: MEM_COLOR }} />Used {usedPct.toFixed(1)}%</span>
            <span><i style={{ background: 'var(--color-system-04)' }} />Free {freePct.toFixed(1)}%</span>
          </div>
        </div>
      </ClassicyControlGroup>

      <ClassicyControlGroup label="Swap">
        {swap ? (
          <ClassicyMeter
            value={swap.usagePct}
            label={`Swap · ${fmtBytes(swap.used)} / ${fmtBytes(swap.total)}`}
            labelPosition="left"
            showValue
            {...METER_BOUNDS}
          />
        ) : (
          <p className="sp-dim">No swap configured.</p>
        )}
      </ClassicyControlGroup>

      <ClassicyControlGroup label="Top Processes · Memory">
        <ProcessBars processes={processes} metric="mem" />
      </ClassicyControlGroup>
    </>
  );
}
