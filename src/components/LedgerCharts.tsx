import { useCallback, useEffect, useRef, useState } from 'react';
import {
  LEDGER_CHART_DIM,
  LEDGER_CHART_GRID,
  LEDGER_CHART_TEXT,
  LEDGER_EXPENSE_COLOR,
  LEDGER_INCOME_COLOR,
  LEDGER_NET_COLOR,
  formatCent,
} from '../format';

/** canvas 绘图中性色：优先实时读取 classicy 主题变量，缺失时回退到 format.ts 常量 */
interface ChartTheme {
  grid: string;
  text: string;
  dim: string;
}

type DrawFn = (ctx: CanvasRenderingContext2D, w: number, h: number, theme: ChartTheme) => void;

/**
 * 通用 canvas 渲染器：dpr 自适应 + ResizeObserver 重绘。
 * 渲染函数存 ref，数据变化只重绘、不重建 ResizeObserver；
 * 额外暴露 redraw() 供 hover 高亮这类「数据不变但外观变」的场景手动刷新。
 */
function useLedgerCanvas(draw: DrawFn) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const drawRef = useRef(draw);
  drawRef.current = draw;
  const renderRef = useRef<() => void>(() => {});

  useEffect(() => {
    const cv = canvasRef.current;
    const wrap = wrapRef.current;
    if (!cv || !wrap) return;
    const render = () => {
      const dpr = window.devicePixelRatio || 1;
      const w = Math.max(cv.clientWidth || wrap.clientWidth || 240, 120);
      const h = Math.max(cv.clientHeight || 160, 60);
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(h * dpr);
      const ctx = cv.getContext('2d');
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      // 每次重绘先复位文本对齐，避免上一次 draw 留下的 textAlign 影响坐标轴
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
      const cs = window.getComputedStyle(wrap);
      const theme: ChartTheme = {
        grid: cs.getPropertyValue('--color-system-03').trim() || LEDGER_CHART_GRID,
        text: cs.getPropertyValue('--color-system-07').trim() || LEDGER_CHART_TEXT,
        dim: cs.getPropertyValue('--color-system-05').trim() || LEDGER_CHART_DIM,
      };
      drawRef.current(ctx, w, h, theme);
    };
    renderRef.current = render;
    render();
    const ro = new ResizeObserver(render);
    ro.observe(wrap);
    return () => {
      ro.disconnect();
      renderRef.current = () => {};
    };
  }, []);

  // 数据/绘制函数变化时重绘（draw 由 useCallback 保持稳定引用）
  useEffect(() => {
    renderRef.current();
  }, [draw]);

  const redraw = useCallback(() => renderRef.current(), []);
  return { canvasRef, wrapRef, redraw };
}

/** 折线 / 柱状图共用：画 0 / 半 / 满三条参考线与左侧「元」刻度，返回绘图区几何 */
function drawAxes(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  maxCent: number,
  minCent: number,
  theme: ChartTheme
): { padL: number; padR: number; padT: number; padB: number; plotW: number; plotH: number; yOf: (cent: number) => number } {
  const padL = 52;
  const padR = 8;
  const padT = 10;
  const padB = 20;
  const plotW = Math.max(w - padL - padR, 10);
  const plotH = Math.max(h - padT - padB, 10);
  const span = Math.max(1, maxCent - minCent);
  const yOf = (cent: number) => padT + plotH - ((cent - minCent) / span) * plotH;
  ctx.font = '10px Helvetica, Arial, sans-serif';
  ctx.lineWidth = 1;
  const ticks = [minCent, minCent + span / 2, maxCent];
  for (const t of [...new Set(ticks.map((v) => Math.round(v)))]) {
    const y = Math.round(yOf(t)) + 0.5;
    ctx.strokeStyle = theme.grid;
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(w - padR, y);
    ctx.stroke();
    ctx.fillStyle = theme.dim;
    ctx.fillText(formatCent(t), 2, y + 3);
  }
  return { padL, padR, padT, padB, plotW, plotH, yOf };
}

/** 空数据提示（居中） */
function drawEmpty(ctx: CanvasRenderingContext2D, w: number, h: number, theme: ChartTheme): void {
  ctx.fillStyle = theme.dim;
  ctx.font = '12px Helvetica, Arial, sans-serif';
  ctx.fillText('暂无数据', Math.max(8, w / 2 - 24), h / 2);
}

export interface LedgerPeriodPoint {
  label: string;
  incomeCent: number;
  expenseCent: number;
  netCent: number;
}

/** 点击柱状图时区分点中的是收入柱、支出柱还是整组 */
export type LedgerBarSeries = 'income' | 'expense' | 'all';

interface BarGeometry {
  padL: number;
  padT: number;
  plotH: number;
  slot: number;
  barW: number;
}

/**
 * 按期间：收入（红）/ 支出（绿）分组柱状图。
 * hover 时高亮整组并显示数值浮层；点击回调把期间 + 命中的收支方向交给上层下钻。
 */
export function LedgerBarChart({
  points,
  onSelect,
}: {
  points: LedgerPeriodPoint[];
  onSelect?: (point: LedgerPeriodPoint, series: LedgerBarSeries, index: number) => void;
}) {
  const geometry = useRef<BarGeometry>({ padL: 52, padT: 10, plotH: 60, slot: 1, barW: 4 });
  const hoverIndex = useRef(-1);
  const [tip, setTip] = useState<{ index: number; x: number; y: number } | null>(null);

  // 报表数据换了，旧浮层的下标可能越界，先收起
  useEffect(() => {
    hoverIndex.current = -1;
    setTip(null);
  }, [points]);

  const draw = useCallback<DrawFn>(
    (ctx, w, h, theme) => {
      if (points.length === 0) return drawEmpty(ctx, w, h, theme);
      const max = Math.max(1, ...points.map((p) => Math.max(p.incomeCent, p.expenseCent)));
      const { padL, padR, padT, plotW, plotH, yOf } = drawAxes(ctx, w, h, max, 0, theme);
      const slot = plotW / points.length;
      const barW = Math.max(2, Math.min(14, (slot - 6) / 2));
      geometry.current = { padL, padT, plotH, slot, barW };

      // hover 高亮（半透明底色，不遮挡柱体）
      const hi = hoverIndex.current;
      if (hi >= 0 && hi < points.length) {
        ctx.save();
        ctx.globalAlpha = 0.3;
        ctx.fillStyle = theme.grid;
        ctx.fillRect(padL + hi * slot, padT, slot, plotH);
        ctx.restore();
      }
      points.forEach((p, i) => {
        const groupStart = Math.max((slot - barW * 2 - 2) / 2, 0);
        const x = padL + i * slot + groupStart;
        const hiBar = (Math.min(p.incomeCent, max) / max) * plotH;
        const heBar = (Math.min(p.expenseCent, max) / max) * plotH;
        if (hiBar > 0) {
          ctx.fillStyle = LEDGER_INCOME_COLOR;
          ctx.fillRect(x, yOf(0) - hiBar, barW, hiBar);
        }
        if (heBar > 0) {
          ctx.fillStyle = LEDGER_EXPENSE_COLOR;
          ctx.fillRect(x + barW + 2, yOf(0) - heBar, barW, heBar);
        }
      });
      // 零线加重
      ctx.strokeStyle = theme.text;
      const base = Math.round(yOf(0)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(padL, base);
      ctx.lineTo(w - padR, base);
      ctx.stroke();
      // x 轴标签
      const labelEvery = points.length <= 10 ? 1 : Math.ceil(points.length / 8);
      ctx.fillStyle = theme.dim;
      ctx.textAlign = 'center';
      points.forEach((p, i) => {
        if (i % labelEvery === 0) ctx.fillText(p.label, padL + i * slot + slot / 2, h - 5);
      });
      ctx.textAlign = 'left';
    },
    [points]
  );

  const { canvasRef, wrapRef, redraw } = useLedgerCanvas(draw);

  /** 把鼠标坐标换算成「第几组 + 命中哪根柱」；落在组内空白处视为整组 */
  const locate = (clientX: number, clientY: number) => {
    const wrap = wrapRef.current;
    if (!wrap || points.length === 0) return null;
    const rect = wrap.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    const g = geometry.current;
    if (g.slot <= 0) return null;
    const index = Math.floor((x - g.padL) / g.slot);
    if (index < 0 || index >= points.length) return null;
    const groupStart = Math.max((g.slot - g.barW * 2 - 2) / 2, 0);
    const local = x - (g.padL + index * g.slot) - groupStart;
    let series: LedgerBarSeries = 'all';
    if (local >= 0 && local < g.barW) series = 'income';
    else if (local >= g.barW + 2 && local < g.barW * 2 + 2) series = 'expense';
    return { index, series, x, y };
  };

  const clearHover = () => {
    if (hoverIndex.current !== -1) {
      hoverIndex.current = -1;
      redraw();
    }
    setTip(null);
  };

  const tipPoint = tip ? points[tip.index] : null;
  // 靠近右边缘时翻到光标左侧，避免浮层被容器裁掉
  const tipLeft = tip
    ? (() => {
        const wrapW = wrapRef.current?.clientWidth ?? 320;
        const right = tip.x + 16;
        return right + 178 > wrapW ? Math.max(4, tip.x - 178 - 16) : right;
      })()
    : 0;
  const tipTop = tip
    ? Math.max(2, Math.min(tip.y - 84, (wrapRef.current?.clientHeight ?? 150) - 92))
    : 0;

  return (
    <div
      className={`sp-ledger-chart${onSelect ? ' sp-ledger-chart-interactive' : ''}`}
      ref={wrapRef}
      onMouseMove={(e) => {
        const hit = locate(e.clientX, e.clientY);
        if (!hit) return clearHover();
        if (hoverIndex.current !== hit.index) {
          hoverIndex.current = hit.index;
          redraw();
        }
        setTip({ index: hit.index, x: hit.x, y: hit.y });
      }}
      onMouseLeave={clearHover}
      onClick={(e) => {
        const hit = locate(e.clientX, e.clientY);
        if (hit && onSelect) onSelect(points[hit.index], hit.series, hit.index);
      }}
    >
      <canvas ref={canvasRef} />
      {tip && tipPoint && (
        <div className="sp-ledger-chart-tip" style={{ left: tipLeft, top: tipTop }}>
          <div className="sp-ledger-chart-tip-title">{tipPoint.label}</div>
          <div><i style={{ background: LEDGER_INCOME_COLOR }} />收入 <b>¥{formatCent(tipPoint.incomeCent)}</b></div>
          <div><i style={{ background: LEDGER_EXPENSE_COLOR }} />支出 <b>¥{formatCent(tipPoint.expenseCent)}</b></div>
          <div><i style={{ background: LEDGER_NET_COLOR }} />净额 <b>¥{formatCent(tipPoint.netCent)}</b></div>
          {onSelect && <div className="sp-ledger-chart-tip-hint">点击查看该期间流水明细</div>}
        </div>
      )}
    </div>
  );
}

/** 按期间：净额折线（跨零轴，中性蓝） */
export function LedgerLineChart({ points }: { points: LedgerPeriodPoint[] }) {
  const draw = useCallback<DrawFn>(
    (ctx, w, h, theme) => {
      if (points.length === 0) return drawEmpty(ctx, w, h, theme);
      const nets = points.map((p) => p.netCent);
      const max = Math.max(0, ...nets);
      const min = Math.min(0, ...nets);
      const { padL, padR, plotW, yOf } = drawAxes(ctx, w, h, max, min, theme);
      // 零轴（净额正负分界）
      const zeroY = Math.round(yOf(0)) + 0.5;
      ctx.strokeStyle = theme.text;
      ctx.beginPath();
      ctx.moveTo(padL, zeroY);
      ctx.lineTo(w - padR, zeroY);
      ctx.stroke();
      const slot = plotW / Math.max(points.length, 1);
      const xOf = (i: number) => padL + i * slot + slot / 2;
      ctx.strokeStyle = LEDGER_NET_COLOR;
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      points.forEach((p, i) => {
        const x = xOf(i);
        const y = yOf(p.netCent);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
      ctx.fillStyle = LEDGER_NET_COLOR;
      points.forEach((p, i) => {
        ctx.beginPath();
        ctx.arc(xOf(i), yOf(p.netCent), 2.2, 0, Math.PI * 2);
        ctx.fill();
      });
      const labelEvery = points.length <= 10 ? 1 : Math.ceil(points.length / 8);
      ctx.fillStyle = theme.dim;
      ctx.font = '10px Helvetica, Arial, sans-serif';
      ctx.textAlign = 'center';
      points.forEach((p, i) => {
        if (i % labelEvery === 0) ctx.fillText(p.label, xOf(i), h - 5);
      });
      ctx.textAlign = 'left';
    },
    [points]
  );
  const { canvasRef, wrapRef } = useLedgerCanvas(draw);
  return (
    <div className="sp-ledger-chart sp-ledger-chart-line" ref={wrapRef}>
      <canvas ref={canvasRef} />
    </div>
  );
}

export interface LedgerCategoryBar {
  label: string;
  incomeCent: number;
  expenseCent: number;
}

/**
 * 按类别：固定三列布局（类别名 / 双色条 / 收入·支出数值）。
 * 名称与两列数值各自在列内水平居中，同一行的三个元素共用 cy 垂直居中；
 * 画布高度随实际行数增长，Top 50 也不会被压扁。
 */
export function LedgerCategoryBars({ rows }: { rows: LedgerCategoryBar[] }) {
  const draw = useCallback<DrawFn>(
    (ctx, w, h, theme) => {
      if (rows.length === 0) return drawEmpty(ctx, w, h, theme);
      const max = Math.max(1, ...rows.map((r) => Math.max(r.incomeCent, r.expenseCent)));
      const padX = 8;
      const labelW = Math.min(160, Math.max(90, w * 0.22));
      const valW = 84;
      const padT = 20;
      const padB = 4;
      const plotX = padX + labelW;
      const plotW = Math.max(w - padX * 2 - labelW - valW * 2, 20);
      const rowH = Math.max(20, (h - padT - padB) / rows.length);
      const barH = Math.max(3, Math.min(6, rowH / 4));
      ctx.font = '10px Helvetica, Arial, sans-serif';

      // 表头：与数据列共用同一组 x 坐标，视觉上严格对齐
      ctx.fillStyle = theme.dim;
      ctx.textAlign = 'center';
      ctx.fillText('类别', padX + labelW / 2, 12);
      ctx.fillText('收入', plotX + plotW + valW / 2, 12);
      ctx.fillText('支出', plotX + plotW + valW * 1.5, 12);
      ctx.textAlign = 'left';
      ctx.fillText('收入 / 支出（元）', plotX, 12);
      ctx.strokeStyle = theme.grid;
      ctx.beginPath();
      ctx.moveTo(padX, 15.5);
      ctx.lineTo(w - padX, 15.5);
      ctx.stroke();

      rows.forEach((r, i) => {
        const cy = padT + i * rowH + rowH / 2;
        // 类别名：列内水平居中 + 行内垂直居中
        ctx.fillStyle = theme.text;
        ctx.textAlign = 'center';
        const label = r.label.length > 14 ? `${r.label.slice(0, 13)}…` : r.label;
        ctx.fillText(label, padX + labelW / 2, cy + 3);
        // 双色条：两根围绕 cy 对称，作为一组垂直居中
        const wi = (Math.min(r.incomeCent, max) / max) * plotW;
        const we = (Math.min(r.expenseCent, max) / max) * plotW;
        ctx.fillStyle = LEDGER_INCOME_COLOR;
        ctx.fillRect(plotX, cy - barH - 1, wi, barH);
        ctx.fillStyle = LEDGER_EXPENSE_COLOR;
        ctx.fillRect(plotX, cy + 1, we, barH);
        // 数值：固定在右两列并居中，不再随条长漂移
        ctx.fillStyle = theme.dim;
        ctx.textAlign = 'center';
        ctx.fillText(formatCent(r.incomeCent), plotX + plotW + valW / 2, cy + 3);
        ctx.fillText(formatCent(r.expenseCent), plotX + plotW + valW * 1.5, cy + 3);
        ctx.textAlign = 'left';
      });
      ctx.textAlign = 'left';
    },
    [rows]
  );
  const { canvasRef, wrapRef } = useLedgerCanvas(draw);
  const height = Math.max(120, rows.length * 26 + 26);
  return (
    <div className="sp-ledger-chart" ref={wrapRef} style={{ height }}>
      <canvas ref={canvasRef} />
    </div>
  );
}
