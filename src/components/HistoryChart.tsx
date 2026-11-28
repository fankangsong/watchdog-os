import { useCallback, useEffect, useRef } from 'react';
import { CPU_COLOR, MEM_COLOR } from '../format';

type Point = { cpu: number; mem: number };

// CPU/内存历史曲线（canvas，高分屏自适应）
// Tabs 隐藏页的 canvas 宽度为 0，因此除了数据变化，还要用 ResizeObserver 在切回时重绘。
export function HistoryChart({ points }: { points: Point[] }) {
  const ref = useRef<HTMLCanvasElement>(null);

  const draw = useCallback(() => {
    const cv = ref.current;
    if (!cv) return;
    const dpr = window.devicePixelRatio || 1;
    const w = cv.clientWidth || 300;
    const h = cv.clientHeight || 64;
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(h * dpr);
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);

    // 25% / 50% / 75% 参考线（克制风格：只做浅色水平线，不画满格网）
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.08)';
    ctx.lineWidth = 1;
    for (const frac of [0.25, 0.5, 0.75]) {
      const y = Math.round(h * frac) + 0.5;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }

    const n = points.length;
    if (n < 2) return;

    const drawSeries = (key: 'cpu' | 'mem', color: string) => {
      // 曲线下面积：同色低透明度填充，强化趋势可读性
      ctx.beginPath();
      points.forEach((p, i) => {
        const x = (i / (n - 1)) * w;
        const y = h - (Math.min(p[key], 100) / 100) * h;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.lineTo(w, h);
      ctx.lineTo(0, h);
      ctx.closePath();
      ctx.globalAlpha = 0.12;
      ctx.fillStyle = color;
      ctx.fill();
      ctx.globalAlpha = 1;

      ctx.beginPath();
      points.forEach((p, i) => {
        const x = (i / (n - 1)) * w;
        const y = h - (Math.min(p[key], 100) / 100) * h;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    };
    drawSeries('cpu', CPU_COLOR);
    drawSeries('mem', MEM_COLOR);
  }, [points]);

  useEffect(() => {
    draw();
  }, [draw]);

  useEffect(() => {
    const cv = ref.current;
    if (!cv || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => draw());
    ro.observe(cv);
    return () => ro.disconnect();
  }, [draw]);

  return <canvas ref={ref} className="sp-chart" />;
}
