import { useEffect, useRef } from 'react';
import { AUDIT_FAIL_COLOR, AUDIT_OK_COLOR } from '../format';

export interface AuditTrendPoint {
  /** 横轴标签（日期 MM-DD 或小时 HH） */
  label: string;
  success: number;
  failures: number;
}

/**
 * 登录趋势柱状图：每个槽位并列「成功（绿）/ 失败（红）」双柱 + 基线 + 稀疏刻度。
 * 纯 canvas 自绘（与 HistoryChart 同一做法，不引图表库）；dpr 自适应，
 * 宽度变化经 ResizeObserver 重绘（窗口缩放时图不变形）。
 */
export function AuditTrendChart({ points }: { points: AuditTrendPoint[] }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const cv = canvasRef.current;
    const wrap = wrapRef.current;
    if (!cv || !wrap) return;

    const draw = () => {
      const dpr = window.devicePixelRatio || 1;
      const w = Math.max(cv.clientWidth || wrap.clientWidth || 240, 120);
      const h = Math.max(cv.clientHeight || 132, 60);
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(h * dpr);
      const ctx = cv.getContext('2d');
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      const padL = 26; // 左侧刻度数字
      const padR = 6;
      const padT = 8;
      const padB = 16; // 底部日期标签
      const plotW = Math.max(w - padL - padR, 10);
      const plotH = Math.max(h - padT - padB, 10);
      const max = Math.max(1, ...points.map((p) => Math.max(p.success, p.failures)));

      // 参考线：0 / 中值 / 最大值（同 HistoryChart 的克制风格，不画满格网）。
      // 小小值域（0/1/2 次）时中值取整会与上下限重复，用去重后的刻度集避免「1 1 0」这种刻度。
      const ticks = max <= 2 ? [0, max] : [0, Math.round(max / 2), max];
      ctx.font = '10px Helvetica, Arial, sans-serif';
      ctx.lineWidth = 1;
      for (const tick of [...new Set(ticks)]) {
        const y = Math.round(padT + plotH - (tick / max) * plotH) + 0.5;
        ctx.strokeStyle = 'rgba(0, 0, 0, 0.18)';
        ctx.beginPath();
        ctx.moveTo(padL, y);
        ctx.lineTo(w - padR, y);
        ctx.stroke();
        ctx.fillStyle = '#666';
        ctx.fillText(String(tick), 2, y + 3);
      }

      if (points.length === 0) {
        ctx.fillStyle = '#808080';
        ctx.fillText('No data', padL + 6, padT + plotH / 2);
        return;
      }

      const slot = plotW / points.length;
      const barW = Math.max(2, Math.min(12, (slot - 6) / 2));
      const labelEvery = points.length <= 10 ? 1 : Math.ceil(points.length / 8);

      points.forEach((p, i) => {
        const x = padL + i * slot + Math.max((slot - barW * 2 - 2) / 2, 0);
        const hs = (Math.min(p.success, max) / max) * plotH;
        const hf = (Math.min(p.failures, max) / max) * plotH;
        if (hs > 0) {
          ctx.fillStyle = AUDIT_OK_COLOR;
          ctx.fillRect(x, padT + plotH - hs, barW, hs);
        }
        if (hf > 0) {
          ctx.fillStyle = AUDIT_FAIL_COLOR;
          ctx.fillRect(x + barW + 2, padT + plotH - hf, barW, hf);
        }
        if (i % labelEvery === 0) {
          ctx.fillStyle = '#666';
          ctx.fillText(p.label, x - 1, h - 4);
        }
      });

      // 基线加重，明确「零值」边界
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.45)';
      const base = Math.round(padT + plotH) + 0.5;
      ctx.beginPath();
      ctx.moveTo(padL, base);
      ctx.lineTo(w - padR, base);
      ctx.stroke();
    };

    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [points]);

  return (
    <div className="sp-audit-trend" ref={wrapRef}>
      <canvas ref={canvasRef} />
    </div>
  );
}
