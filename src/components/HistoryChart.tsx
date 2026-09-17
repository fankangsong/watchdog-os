import { useEffect, useRef } from 'react';
import { CPU_COLOR, MEM_COLOR } from '../format';

type Point = { cpu: number; mem: number };

// CPU/内存历史曲线（canvas，高分屏自适应）
export function HistoryChart({ points }: { points: Point[] }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
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

    const n = points.length;
    if (n < 2) return;

    const draw = (key: 'cpu' | 'mem', color: string) => {
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
    draw('cpu', CPU_COLOR);
    draw('mem', MEM_COLOR);
  }, [points]);

  return <canvas ref={ref} className="sp-chart" />;
}
