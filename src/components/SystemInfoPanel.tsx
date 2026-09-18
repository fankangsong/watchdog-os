import { ClassicyControlGroup } from 'classicy';
import type { HostInfo, TempItem } from '../api';
import { fmtUptime, tempColor } from '../format';

// 系统信息面板：ClassicyControlGroup 分组 + label/value 行
export function SystemInfoPanel({ host, temps }: { host: HostInfo; temps: TempItem[] }) {
  const rows: Array<[string, string]> = [
    ['Hostname', host.hostname],
    ['OS', `${host.platform} ${host.release} · ${host.arch}`],
    ['CPU', `${host.cpuModel} × ${host.cpuCount}`],
    ['Uptime', fmtUptime(host.uptime)],
    ['LAN IP', (host.lanIp || []).join(', ') || '-'],
    ['Public IP', host.wanIp || '-'],
  ];

  const hasTemp = Array.isArray(temps) && temps.length > 0;
  const tempText = hasTemp ? temps.slice(0, 8).map((t) => `${t.label} ${t.temp}°C`).join(' · ') : '-';
  const maxTemp = hasTemp ? Math.max(...temps.map((t) => t.temp)) : 0;
  const tempTip = hasTemp
    ? temps.map((t) => `${t.label} ${t.temp}°C`).join('\n')
    : 'No thermal sensors detected (common on VMs/Windows)';

  return (
    <ClassicyControlGroup label="System Information">
      {rows.map(([k, v]) => (
        <div className="sp-info-row" key={k}>
          <span className="sp-info-key">{k}</span>
          <span className="sp-info-val">{v}</span>
        </div>
      ))}
      <div className="sp-info-row">
        <span className="sp-info-key">Thermal</span>
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
