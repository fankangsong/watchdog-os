import { ClassicyControlGroup, ClassicyMeter } from 'classicy';
import type { Metrics } from '../api';
import { fmtBytes, levelColor, CPU_COLOR, MEM_COLOR } from '../format';
import { Gauge } from './Gauge';
import { HistoryChart } from './HistoryChart';

const METER_BOUNDS = { low: 60, high: 80, optimum: 30 };

// 资源使用率面板：圆形仪表 + 历史曲线（自绘可视化）+ ClassicyMeter 负载条
export function ResourcesPanel({ metrics }: { metrics: Metrics }) {
  const { cpu, mem, swap, disks, history } = metrics;
  const cores = cpu.cores || [];

  return (
    <ClassicyControlGroup label="资源使用率">
      <div className="sp-gauges">
        <div className="sp-gauge-box">
          <Gauge pct={cpu.usage} text={`${cpu.usage.toFixed(1)}%`} color={CPU_COLOR} />
          <div className="sp-gauge-label">CPU</div>
        </div>
        <div className="sp-gauge-box">
          <Gauge pct={mem.usagePct} text={`${mem.usagePct.toFixed(1)}%`} color={MEM_COLOR} />
          <div className="sp-gauge-label">内存</div>
        </div>
        <div className="sp-chart-wrap">
          <div className="sp-legend">
            <span><i style={{ background: CPU_COLOR }} />CPU 历史</span>
            <span><i style={{ background: MEM_COLOR }} />内存 历史</span>
          </div>
          <HistoryChart points={history} />
        </div>
      </div>

      {cores.length > 0 && (
        <div className="sp-cores">
          {cores.map((v, i) => (
            <div className="sp-core" key={i} title={`核心 ${i}：${v}%`}>
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
      )}

      <div className="sp-meters">
        {swap && (
          <ClassicyMeter
            value={swap.usagePct}
            label={`Swap · ${fmtBytes(swap.used)} / ${fmtBytes(swap.total)}`}
            labelPosition="left"
            showValue
            {...METER_BOUNDS}
          />
        )}
        {disks && disks.length > 0 && disks.map((d) => (
          <ClassicyMeter
            key={d.mount}
            value={d.usagePct}
            label={`${d.mount} · ${fmtBytes(d.used)} / ${fmtBytes(d.size)}`}
            labelPosition="left"
            showValue
            {...METER_BOUNDS}
          />
        ))}
      </div>
    </ClassicyControlGroup>
  );
}
