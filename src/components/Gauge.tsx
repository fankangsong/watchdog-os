// 圆形仪表盘：圆弧 + 百分比文字
export function Gauge({ pct, text, color }: { pct: number; text: string; color: string }) {
  const r = 45;
  const circ = 2 * Math.PI * r;
  const off = circ * (1 - Math.min(Math.max(pct, 0), 100) / 100);
  return (
    <svg viewBox="0 0 110 110" className="sp-gauge">
      <circle className="sp-gauge-bg" cx="55" cy="55" r={r} />
      <circle
        className="sp-gauge-arc"
        cx="55"
        cy="55"
        r={r}
        stroke={color}
        strokeDasharray={circ}
        strokeDashoffset={off}
      />
      <text className="sp-gauge-text" x="55" y="59" textAnchor="middle" fill={color}>
        {text}
      </text>
    </svg>
  );
}
