import { ClassicyControlGroup } from 'classicy';
import type { HostInfo, TempItem } from '../api';
import { fmtUptime, tempColor } from '../format';

// 系统信息面板：ClassicyControlGroup 分组 + label/value 行
export function SystemInfoPanel({ host, temps }: { host: HostInfo; temps: TempItem[] }) {
  const rows: Array<[string, string]> = [
    ['主机名', host.hostname],
    ['操作系统', `${host.platform} ${host.release} · ${host.arch}`],
    ['CPU', `${host.cpuModel} × ${host.cpuCount}`],
    ['运行时间', fmtUptime(host.uptime)],
    ['局域网 IP', (host.lanIp || []).join(', ') || '-'],
    ['公网 IP', host.wanIp || '-'],
  ];

  const hasTemp = Array.isArray(temps) && temps.length > 0;
  const tempText = hasTemp ? temps.slice(0, 8).map((t) => `${t.label} ${t.temp}°C`).join(' · ') : '-';
  const maxTemp = hasTemp ? Math.max(...temps.map((t) => t.temp)) : 0;
  const tempTip = hasTemp
    ? temps.map((t) => `${t.label} ${t.temp}°C`).join('\n')
    : '未检测到硬件温度传感器（常见于虚拟机/Windows）';

  return (
    <ClassicyControlGroup label="系统信息">
      {rows.map(([k, v]) => (
        <div className="sp-info-row" key={k}>
          <span className="sp-info-key">{k}</span>
          <span className="sp-info-val">{v}</span>
        </div>
      ))}
      <div className="sp-info-row">
        <span className="sp-info-key">硬件温度</span>
        <span
          className="sp-info-val"
          title={tempTip}
          style={hasTemp ? { color: tempColor(maxTemp) } : undefined}
        >
          {tempText}
        </span>
      </div>
    </ClassicyControlGroup>
  );
}
