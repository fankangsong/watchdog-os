import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ClassicyButton,
  ClassicyControlGroup,
  ClassicyInput,
  ClassicyPopUpMenu,
  ClassicyTable,
  type ClassicyTableColumn,
} from 'classicy';
import {
  downloadLedgerReportCsv,
  downloadLedgerTxnsCsv,
  fetchLedgerReport,
  fetchLedgerTxns,
  type LedgerFilters,
  type LedgerMeta,
  type LedgerReportResult,
  type LedgerReportRow,
  type LedgerTxn,
} from '../api';
import {
  LEDGER_EXPENSE_COLOR,
  LEDGER_INCOME_COLOR,
  LEDGER_NET_COLOR,
  fmtClock,
  formatCent,
} from '../format';
import { useAppOpen } from '../hooks/useAppOpen';
import {
  LedgerBarChart,
  LedgerCategoryBars,
  LedgerLineChart,
  type LedgerBarSeries,
  type LedgerCategoryBar,
  type LedgerPeriodPoint,
} from './LedgerCharts';

const APP_ID = 'srv-ledger.app';
const DRILL_PAGE = 200;

interface ReportDrafts {
  dim: 'period' | 'category';
  grain: 'year' | 'month';
  scope: 'net' | 'all';
  account: string;
  year: string;
  domain: string;
  direction: string;
  from: string;
  to: string;
  topN: number;
}

const DEFAULT_DRAFTS: ReportDrafts = {
  dim: 'period',
  grain: 'month',
  scope: 'net',
  account: 'all',
  year: 'all',
  domain: 'all',
  direction: 'all',
  from: '',
  to: '',
  topN: 10,
};

// 「占比」维度已移除：单根堆叠条 + 少量图例看不出数据价值，
// 类别维度本身已能给出 Top N 的收入/支出对比。
const DIM_OPTIONS = [
  { value: 'period', label: '按期间' },
  { value: 'category', label: '按类别' },
];
const GRAIN_OPTIONS = [
  { value: 'month', label: '按月' },
  { value: 'year', label: '按年' },
];
const SCOPE_OPTIONS = [
  { value: 'net', label: 'NET（剔除划转）' },
  { value: 'all', label: 'ALL（含划转）' },
];
const DIRECTION_OPTIONS = [
  { value: 'all', label: '全部方向' },
  { value: 'IN', label: '收入' },
  { value: 'OUT', label: '支出' },
];
const TOPN_OPTIONS = [10, 20, 30, 50].map((n) => ({ value: String(n), label: `Top ${n}` }));

interface DrillState {
  period: string;
  series: LedgerBarSeries;
  from: string;
  to: string;
}

/** 报表期间（YYYY-MM 或 YYYY）→ 起止日期，点击柱状图下钻时用于筛选流水 */
function periodRange(period: string): { from: string; to: string } | null {
  if (/^\d{4}-\d{2}$/.test(period)) {
    const [y, m] = period.split('-').map(Number);
    if (m < 1 || m > 12) return null;
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    return { from: `${period}-01`, to: `${period}-${String(last).padStart(2, '0')}` };
  }
  if (/^\d{4}$/.test(period)) return { from: `${period}-01-01`, to: `${period}-12-31` };
  return null;
}

const SERIES_LABEL: Record<LedgerBarSeries, string> = {
  income: '收入',
  expense: '支出',
  all: '全部',
};

/**
 * 报表：dim(period/category) + 筛选控件 + 汇总卡 + 手写 canvas 图表 + 结果表 + CSV 导出。
 * 分组柱状图支持 hover 数值浮层；点击柱子按「期间 + 命中的收支方向」下钻流水明细。
 * 颜色遵循中国习惯：收入/上涨红、支出/下跌绿（语义色集中 format.ts）。
 */
export function LedgerReportTab({
  meta,
  refreshKey,
  onError,
}: {
  meta: LedgerMeta;
  refreshKey: number;
  onError: (e: unknown) => void;
}) {
  const open = useAppOpen(APP_ID);
  const [draft, setDraft] = useState<ReportDrafts>(DEFAULT_DRAFTS);
  const [applied, setApplied] = useState<ReportDrafts>(DEFAULT_DRAFTS);
  const [result, setResult] = useState<LedgerReportResult | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [exporting, setExporting] = useState(false);
  const [drill, setDrill] = useState<DrillState | null>(null);
  const [drillRows, setDrillRows] = useState<LedgerTxn[]>([]);
  const [drillTotal, setDrillTotal] = useState(0);
  const [drillBusy, setDrillBusy] = useState(false);
  const [drillError, setDrillError] = useState<Error | null>(null);
  const [drillExporting, setDrillExporting] = useState(false);

  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const queryRef = useRef<LedgerFilters>({});
  const drillSeq = useRef(0);
  const setD = <K extends keyof ReportDrafts>(key: K, value: ReportDrafts[K]) =>
    setDraft((prev) => ({ ...prev, [key]: value }));
  /** 下拉即时生效；文本输入仍由回车 /「筛选」提交，避免逐字符发请求 */
  const setSelectD = <K extends keyof ReportDrafts>(key: K, value: ReportDrafts[K]) => {
    const next: ReportDrafts = { ...draft, [key]: value };
    setDraft(next);
    setApplied(next);
  };

  const accountOptions = useMemo(
    () => [
      { value: 'all', label: '全部账户' },
      ...meta.accounts.map((a) => ({ value: String(a.accountId), label: `${a.bankName || '账户'} ${a.accountNoMasked}` })),
    ],
    [meta.accounts]
  );
  const yearOptions = useMemo(
    () => [{ value: 'all', label: '全部年份' }, ...meta.years.map((y) => ({ value: y, label: y }))],
    [meta.years]
  );
  const domainOptions = useMemo(
    () => [{ value: 'all', label: '全部域' }, ...meta.domains.map((d) => ({ value: d, label: d }))],
    [meta.domains]
  );

  const query = useMemo<LedgerFilters>(
    () => ({
      dim: applied.dim,
      grain: applied.grain,
      scope: applied.scope,
      account: applied.account === 'all' ? 'all' : Number(applied.account),
      year: applied.year,
      domain: applied.domain,
      direction: applied.direction as LedgerFilters['direction'],
      from: applied.from || undefined,
      to: applied.to || undefined,
      topN: applied.topN,
    }),
    [applied]
  );
  queryRef.current = query;

  // useEffect 加载：query / refreshKey 变化即重载；失败保留上次数据。
  // 报表口径变了，旧的下钻明细不再对应当前图表，直接收起。
  useEffect(() => {
    if (!open) return;
    drillSeq.current += 1;
    setDrill(null);
    setDrillRows([]);
    let cancelled = false;
    fetchLedgerReport(queryRef.current)
      .then((d) => {
        if (cancelled) return;
        setResult(d);
        setError(null);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(e instanceof Error ? e : new Error(String(e)));
        onErrorRef.current(e);
      });
    return () => {
      cancelled = true;
    };
  }, [open, query, refreshKey]);

  const onExport = async () => {
    setExporting(true);
    try {
      await downloadLedgerReportCsv(query);
    } catch (e) {
      onError(e);
    } finally {
      setExporting(false);
    }
  };

  /** 下钻使用的筛选条件（表格与 CSV 导出共用，保证口径一致） */
  const drillFilters = useMemo<LedgerFilters | null>(() => {
    if (!drill) return null;
    const dir: LedgerFilters['direction'] =
      drill.series === 'income' ? 'IN' : drill.series === 'expense' ? 'OUT'
        : (applied.direction as LedgerFilters['direction']);
    return {
      account: applied.account === 'all' ? 'all' : Number(applied.account),
      domain: applied.domain,
      scope: applied.scope,
      direction: dir,
      from: drill.from,
      to: drill.to,
      sort: 'txn_date',
      order: 'asc',
      limit: DRILL_PAGE,
      offset: 0,
    };
  }, [drill, applied]);

  const onDrill = (point: LedgerPeriodPoint, series: LedgerBarSeries) => {
    const range = periodRange(point.label);
    if (!range) return;
    // 报表自身若有日期区间，与下钻期间取交集
    const from = applied.from && applied.from > range.from ? applied.from : range.from;
    const to = applied.to && applied.to < range.to ? applied.to : range.to;
    const seq = ++drillSeq.current;
    setDrill({ period: point.label, series, from, to });
    setDrillRows([]);
    setDrillTotal(0);
    setDrillError(null);
    setDrillBusy(true);
    const f: LedgerFilters = {
      account: applied.account === 'all' ? 'all' : Number(applied.account),
      domain: applied.domain,
      scope: applied.scope,
      direction: series === 'income' ? 'IN' : series === 'expense' ? 'OUT'
        : (applied.direction as LedgerFilters['direction']),
      from,
      to,
      sort: 'txn_date',
      order: 'asc',
      limit: DRILL_PAGE,
      offset: 0,
    };
    fetchLedgerTxns(f)
      .then((d) => {
        if (seq !== drillSeq.current) return;
        setDrillRows(d.rows);
        setDrillTotal(d.total);
      })
      .catch((e: unknown) => {
        if (seq !== drillSeq.current) return;
        setDrillError(e instanceof Error ? e : new Error(String(e)));
        onErrorRef.current(e);
      })
      .finally(() => {
        if (seq === drillSeq.current) setDrillBusy(false);
      });
  };

  const onDrillExport = async () => {
    if (!drillFilters) return;
    setDrillExporting(true);
    try {
      await downloadLedgerTxnsCsv(drillFilters);
    } catch (e) {
      onError(e);
    } finally {
      setDrillExporting(false);
    }
  };

  const periodPoints = useMemo<LedgerPeriodPoint[]>(() => {
    if (!result || result.dim !== 'period') return [];
    return result.rows.map((r) => ({
      label: r.period ?? '',
      incomeCent: r.incomeCent,
      expenseCent: r.expenseCent,
      netCent: r.netCent ?? r.incomeCent - r.expenseCent,
    }));
  }, [result]);

  const categoryRows = useMemo<LedgerCategoryBar[]>(() => {
    if (!result || result.dim !== 'category') return [];
    return result.rows.slice(0, applied.topN).map((r) => ({
      label: r.categoryLabel ?? r.level1 ?? r.categoryCode ?? '未分类',
      incomeCent: r.incomeCent,
      expenseCent: r.expenseCent,
    }));
  }, [result, applied.topN]);

  const columns = useMemo<ClassicyTableColumn<LedgerReportRow>[]>(
    () => [
      {
        id: 'group',
        title: '分组',
        accessor: (r) => r.period ?? r.categoryLabel ?? r.domain ?? r.categoryCode ?? '',
        width: 150,
      },
      { id: 'level1', title: '一级 / 域', accessor: (r) => r.level1 ?? r.domain ?? '', width: 110 },
      {
        id: 'income', title: '收入(¥)', accessor: (r) => r.incomeCent, width: 100, align: 'right',
        render: (r) => <span className="sp-ledger-num" style={{ color: LEDGER_INCOME_COLOR }}>{formatCent(r.incomeCent)}</span>,
      },
      {
        id: 'expense', title: '支出(¥)', accessor: (r) => r.expenseCent, width: 100, align: 'right',
        render: (r) => <span className="sp-ledger-num" style={{ color: LEDGER_EXPENSE_COLOR }}>{formatCent(r.expenseCent)}</span>,
      },
      {
        id: 'net', title: '净额(¥)', accessor: (r) => r.netCent ?? r.incomeCent - r.expenseCent, width: 100, align: 'right',
        render: (r) => <span className="sp-ledger-num">{formatCent(r.netCent ?? r.incomeCent - r.expenseCent)}</span>,
      },
      { id: 'txnCount', title: '笔数', accessor: (r) => r.txnCount, width: 72, align: 'right' },
    ],
    []
  );

  const drillColumns = useMemo<ClassicyTableColumn<LedgerTxn>[]>(
    () => [
      { id: 'date', title: '日期', accessor: (r) => r.txnDate, width: 94 },
      { id: 'time', title: '时间', accessor: (r) => r.txnTime, width: 68 },
      { id: 'account', title: '账户', accessor: (r) => r.accountNoMasked ?? '', width: 120 },
      {
        id: 'in', title: '收入(¥)', accessor: (r) => r.incomeCent, width: 96, align: 'right',
        render: (r) => (
          <span className="sp-ledger-num" style={{ color: r.incomeCent ? LEDGER_INCOME_COLOR : undefined }}>
            {r.incomeCent ? formatCent(r.incomeCent) : '—'}
          </span>
        ),
      },
      {
        id: 'out', title: '支出(¥)', accessor: (r) => r.expenseCent, width: 96, align: 'right',
        render: (r) => (
          <span className="sp-ledger-num" style={{ color: r.expenseCent ? LEDGER_EXPENSE_COLOR : undefined }}>
            {r.expenseCent ? formatCent(r.expenseCent) : '—'}
          </span>
        ),
      },
      { id: 'category', title: '类别', accessor: (r) => r.categoryLabel ?? '', width: 110 },
      { id: 'type', title: '类型', accessor: (r) => r.txnType, width: 96 },
      { id: 'counterparty', title: '对方', accessor: (r) => r.counterparty ?? '' },
      { id: 'memo', title: '备注', accessor: (r) => r.memoClean ?? '' },
    ],
    []
  );

  const totals = result?.totals;

  return (
    <div className="sp-ledger-tab-body">
      <div className="sp-toolbar sp-ledger-toolbar sp-ledger-toolbar-wrap">
        <ClassicyPopUpMenu id="ledger-r-dim" label="维度" labelPosition="left" labelSize="small" size="small"
          options={DIM_OPTIONS} selected={draft.dim}
          onChangeFunc={(e) => setSelectD('dim', e.target.value as ReportDrafts['dim'])} />
        <ClassicyPopUpMenu id="ledger-r-grain" label="粒度" labelPosition="left" labelSize="small" size="small"
          options={GRAIN_OPTIONS} selected={draft.grain}
          onChangeFunc={(e) => setSelectD('grain', e.target.value as ReportDrafts['grain'])} />
        <ClassicyPopUpMenu id="ledger-r-scope" label="口径" labelPosition="left" labelSize="small" size="small"
          options={SCOPE_OPTIONS} selected={draft.scope}
          onChangeFunc={(e) => setSelectD('scope', e.target.value as ReportDrafts['scope'])} />
        {draft.scope === 'net' && <span className="sp-ledger-note">已剔除跨卡划转</span>}
        <ClassicyPopUpMenu id="ledger-r-account" label="账户" labelPosition="left" labelSize="small" size="small"
          options={accountOptions} selected={draft.account} onChangeFunc={(e) => setSelectD('account', e.target.value)} />
        <ClassicyPopUpMenu id="ledger-r-year" label="年" labelPosition="left" labelSize="small" size="small"
          options={yearOptions} selected={draft.year} onChangeFunc={(e) => setSelectD('year', e.target.value)} />
        <ClassicyPopUpMenu id="ledger-r-domain" label="域" labelPosition="left" labelSize="small" size="small"
          options={domainOptions} selected={draft.domain} onChangeFunc={(e) => setSelectD('domain', e.target.value)} />
        <ClassicyPopUpMenu id="ledger-r-direction" label="方向" labelPosition="left" labelSize="small" size="small"
          options={DIRECTION_OPTIONS} selected={draft.direction}
          onChangeFunc={(e) => setSelectD('direction', e.target.value)} />
        <ClassicyInput id="ledger-r-from" labelTitle="起" labelSize="small" labelPosition="left"
          placeholder="YYYY-MM-DD" prefillValue={draft.from} onChangeFunc={(e) => setD('from', e.target.value)}
          onEnterFunc={() => setApplied({ ...draft })} />
        <ClassicyInput id="ledger-r-to" labelTitle="止" labelSize="small" labelPosition="left"
          placeholder="YYYY-MM-DD" prefillValue={draft.to} onChangeFunc={(e) => setD('to', e.target.value)}
          onEnterFunc={() => setApplied({ ...draft })} />
        <ClassicyPopUpMenu id="ledger-r-topn" label="Top N" labelPosition="left" labelSize="small" size="small"
          options={TOPN_OPTIONS} selected={String(draft.topN)}
          onChangeFunc={(e) => setSelectD('topN', Number(e.target.value))} />
        <ClassicyButton buttonSize="small" isDefault onClickFunc={() => setApplied({ ...draft })}>筛选</ClassicyButton>
        <ClassicyButton buttonSize="small" onClickFunc={() => { setDraft(DEFAULT_DRAFTS); setApplied(DEFAULT_DRAFTS); }}>重置</ClassicyButton>
      </div>

      <div className="sp-ledger-tab-scroll">
        {totals && (
          <ClassicyControlGroup label="汇总" variant="primary">
            <div className="sp-ledger-cards">
              <div className="sp-ledger-card">
                <span className="sp-ledger-card-value" style={{ color: LEDGER_INCOME_COLOR }}>¥{formatCent(totals.incomeCent)}</span>
                <span className="sp-ledger-card-label">总收入</span>
              </div>
              <div className="sp-ledger-card">
                <span className="sp-ledger-card-value" style={{ color: LEDGER_EXPENSE_COLOR }}>¥{formatCent(totals.expenseCent)}</span>
                <span className="sp-ledger-card-label">总支出</span>
              </div>
              <div className="sp-ledger-card">
                <span className="sp-ledger-card-value" style={{ color: LEDGER_NET_COLOR }}>¥{formatCent(totals.netCent)}</span>
                <span className="sp-ledger-card-label">净额</span>
              </div>
              <div className="sp-ledger-card">
                <span className="sp-ledger-card-value">{totals.txnCount}</span>
                <span className="sp-ledger-card-label">笔数</span>
              </div>
            </div>
          </ClassicyControlGroup>
        )}

        <ClassicyControlGroup label="图表" variant="primary">
          <div className="sp-ledger-legend">
            <span><i style={{ background: LEDGER_INCOME_COLOR }} /> 收入 / 上涨</span>
            <span><i style={{ background: LEDGER_EXPENSE_COLOR }} /> 支出 / 下跌</span>
            <span><i style={{ background: LEDGER_NET_COLOR }} /> 净额</span>
          </div>
          <div className="sp-ledger-charts">
            {result?.dim === 'period' && (
              <>
                <div className="sp-ledger-chart-block">
                  <div className="sp-ledger-chart-title">收入 / 支出（分组柱状 · 悬停看数值，点击查看明细）</div>
                  <LedgerBarChart points={periodPoints} onSelect={onDrill} />
                </div>
                <div className="sp-ledger-chart-block">
                  <div className="sp-ledger-chart-title">净额趋势</div>
                  <LedgerLineChart points={periodPoints} />
                </div>
              </>
            )}
            {result?.dim === 'category' && (
              <div className="sp-ledger-chart-block">
                <div className="sp-ledger-chart-title">类别 Top {applied.topN}（收入 / 支出）</div>
                <LedgerCategoryBars rows={categoryRows} />
              </div>
            )}
            {!result && <p className="sp-dim sp-ledger-pad">正在生成报表…</p>}
          </div>
        </ClassicyControlGroup>

        {drill && (
          <div className="sp-ledger-drill">
            <div className="sp-ledger-drill-head">
              <span>
                下钻明细 · <b>{drill.period}</b> · {SERIES_LABEL[drill.series]}
                {drillBusy ? '（加载中…）' : `（共 ${drillTotal} 笔，显示前 ${drillRows.length} 笔）`}
              </span>
              <span className="sp-ledger-status-actions">
                <ClassicyButton buttonSize="small" disabled={drillExporting} onClickFunc={() => { void onDrillExport(); }}>
                  {drillExporting ? '导出中…' : '导出明细 CSV'}
                </ClassicyButton>
                <ClassicyButton buttonSize="small" onClickFunc={() => { drillSeq.current += 1; setDrill(null); }}>关闭</ClassicyButton>
              </span>
            </div>
            {drillError ? (
              <p className="sp-ledger-bad sp-ledger-pad">下钻失败：{drillError.message}</p>
            ) : drillRows.length === 0 && !drillBusy ? (
              <p className="sp-dim sp-ledger-pad">该期间在当前口径下没有流水</p>
            ) : (
              <div className="sp-ledger-table">
                <ClassicyTable
                  columns={drillColumns}
                  rows={drillRows}
                  getRowId={(r) => String(r.txnId)}
                  stickyHeader
                />
              </div>
            )}
            {drillTotal > drillRows.length && (
              <p className="sp-ledger-note">表格仅显示前 {DRILL_PAGE} 笔；点「导出明细 CSV」可获取全部 {drillTotal} 笔。</p>
            )}
          </div>
        )}

        <ClassicyControlGroup label={`报表明细（${result?.rows.length ?? 0}）`} variant="primary">
          <div className="sp-ledger-table">
            {result && result.rows.length > 0 ? (
              <ClassicyTable
                columns={columns}
                rows={result.rows}
                getRowId={(r) => [r.period, r.categoryCode, r.domain, r.level1, r.txnCount].join('|')}
                stickyHeader
              />
            ) : (
              <p className="sp-dim sp-ledger-pad">{error ? '生成失败' : '暂无数据'}</p>
            )}
          </div>
        </ClassicyControlGroup>
      </div>

      <div className="sp-ledger-status">
        <span className={error ? 'sp-ledger-status-err' : undefined}>
          {error
            ? `生成失败：${error.message}（显示上次数据）`
            : `${result?.scope === 'net' ? 'NET 口径（已剔除跨卡划转）' : 'ALL 口径（含划转）'}${result ? ` · 生成 ${fmtClock(result.generatedAt)}` : ''}`}
        </span>
        <span>
          <ClassicyButton buttonSize="small" disabled={exporting} onClickFunc={() => { void onExport(); }}>
            {exporting ? '导出中…' : '导出 CSV'}
          </ClassicyButton>
        </span>
      </div>
    </div>
  );
}
