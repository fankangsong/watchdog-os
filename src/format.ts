// 通用格式化与颜色工具

export function fmtBytes(n: number): string {
  if (n == null || isNaN(n)) return '-';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return v.toFixed(v >= 100 || i === 0 ? 0 : 1) + ' ' + units[i];
}

export function fmtUptime(sec: number): string {
  if (!sec || sec < 0) return '-';
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return d > 0 ? `${d}d ${h}h ${m}m` : h > 0 ? `${h}h ${m}m` : `${m}m`;
}

// 使用率分级颜色（用于进度条/迷你条等状态色）
export function levelColor(pct: number): string {
  if (pct < 60) return '#1f9d55'; // 绿
  if (pct < 75) return '#d97706'; // 琥珀
  return '#dc2626'; // 红
}

// 温度颜色
export function tempColor(t: number): string {
  if (t < 60) return '#1f9d55';
  if (t < 75) return '#d97706';
  return '#dc2626';
}

// 固定区分色：CPU 蓝 / 内存 绿
export const CPU_COLOR = '#2563eb';
export const MEM_COLOR = '#16a34a';

/** 审计日志时间列：固定 YYYY-MM-DD HH:mm:ss（不用 toLocaleString，避免各 locale 下宽度抖动） */
export function fmtDateTime(ms: number): string {
  if (!ms) return '—';
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 只到秒的时钟（状态栏「最后更新」等紧凑位置） */
export function fmtClock(ms: number): string {
  if (!ms) return '—';
  return new Date(ms).toTimeString().slice(0, 8);
}

// 审计语义色：成功 / 失败 / 未授权（仅用于结果列与图表，chrome 一律走 classicy 主题变量）
export const AUDIT_OK_COLOR = '#1f9d55';
export const AUDIT_FAIL_COLOR = '#dc2626';
export const AUDIT_UNAUTH_COLOR = '#2563eb';

/* ---------- 财务账本 Ledger（追加，原有导出保持不变） ---------- */

/** 金额「分」→「元」，固定两位小数（后端金额一律以分为单位，展示时才转元）。 */
export function formatCent(cent: number): string {
  return (cent / 100).toFixed(2);
}

/**
 * 财务语义色，遵循中国习惯：收入 / 上涨用红色系，支出 / 下跌用绿色系，净额用中性蓝。
 * 仅用于图表与金额数字（canvas 无法读 CSS 变量）；窗口 chrome 一律走 classicy 主题变量。
 */
export const LEDGER_INCOME_COLOR = '#c0392b'; // 收入 / 上涨：红
export const LEDGER_EXPENSE_COLOR = '#1f9d55'; // 支出 / 下跌：绿
export const LEDGER_NET_COLOR = '#2b6cb0'; // 净额：中性蓝
/** canvas 中性色回退：正常情况从 classicy 主题 CSS 变量实时读取，缺失时才用这些值。 */
export const LEDGER_CHART_GRID = '#cccccc';
export const LEDGER_CHART_TEXT = '#393939';
export const LEDGER_CHART_DIM = '#808080';
