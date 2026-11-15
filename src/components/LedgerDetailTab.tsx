import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ClassicyButton,
  ClassicyForm,
  ClassicyFormButtonRow,
  ClassicyInput,
  ClassicyPopUpMenu,
  ClassicyTable,
  ClassicyWindow,
  type ClassicyPopUpMenuEntry,
  type ClassicyTableColumn,
} from 'classicy';
import {
  downloadLedgerTxnsCsv,
  fetchLedgerTxns,
  setLedgerCategory,
  type LedgerFilters,
  type LedgerMeta,
  type LedgerTxn,
  type LedgerTxnResult,
} from '../api';
import {
  LEDGER_EXPENSE_COLOR,
  LEDGER_INCOME_COLOR,
  LEDGER_NET_COLOR,
  fmtClock,
  formatCent,
} from '../format';
import { useAppOpen } from '../hooks/useAppOpen';

const APP_ID = 'srv-ledger.app';
const POLL_MS = 15000;
const PAGE = 100;

/** 筛选草稿：PopUpMenu / Input 直接改草稿，点 Filter 才成为生效值（参考 AuditApp） */
interface Drafts {
  account: string;
  year: string;
  month: string;
  day: string;
  category: string;
  direction: string;
  domain: string;
  scope: 'net' | 'all';
  q: string;
}

const DEFAULT_DRAFTS: Drafts = {
  account: 'all',
  year: 'all',
  month: 'all',
  day: '',
  category: 'all',
  direction: 'all',
  domain: 'all',
  scope: 'net',
  q: '',
};

/**
 * 流水明细：草稿/生效值分离的筛选 + 15s 轮询 + 多选改类别 + Load more 翻页 + CSV 导出。
 * refreshKey 变化时重载；错误保留上次数据并在状态栏红字提示，同时上报 onError（Unauthorized 登出）。
 */
export function LedgerDetailTab({
  meta,
  refreshKey,
  onChanged,
  onError,
}: {
  meta: LedgerMeta;
  refreshKey: number;
  onChanged: (msg: string) => void;
  onError: (e: unknown) => void;
}) {
  const open = useAppOpen(APP_ID);
  const [draft, setDraft] = useState<Drafts>(DEFAULT_DRAFTS);
  const [applied, setApplied] = useState<Drafts>(DEFAULT_DRAFTS);
  const [result, setResult] = useState<LedgerTxnResult | null>(null);
  const [rows, setRows] = useState<LedgerTxn[]>([]);
  const [error, setError] = useState<Error | null>(null);
  const [updatedAt, setUpdatedAt] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [catOpen, setCatOpen] = useState(false);
  const [catCode, setCatCode] = useState('');
  const [catBusy, setCatBusy] = useState(false);

  // 用 ref 保持最新回调，避免 onError 引用变化让轮询 effect 反复重建
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const queryRef = useRef<LedgerFilters>({});
  const setD = <K extends keyof Drafts>(key: K, value: Drafts[K]) =>
    setDraft((prev) => ({ ...prev, [key]: value }));

  /**
   * 下拉筛选即时生效：用户改完下拉不必再点「筛选」。
   * 文本输入框仍走 setD + 回车/「筛选」提交，避免逐字符发请求。
   * 选中 YYYY-MM 月份时同步年份，避免「年=2025 + 月=2026-10」这种自相矛盾的组合。
   */
  const setSelectD = <K extends keyof Drafts>(key: K, value: Drafts[K]) => {
    const next: Drafts = { ...draft, [key]: value };
    if (key === 'month') {
      const m = String(value);
      if (/^\d{4}-\d{2}$/.test(m)) next.year = m.slice(0, 4);
    } else if (key === 'year' && value !== 'all' && /^\d{4}-\d{2}$/.test(next.month)) {
      if (!next.month.startsWith(String(value))) next.month = 'all';
    }
    setDraft(next);
    setApplied(next);
  };

  const accountOptions = useMemo(
    () => [
      { value: 'all', label: '全部账户' },
      ...meta.accounts.map((a) => ({
        value: String(a.accountId),
        label: `${a.bankName || '账户'} ${a.accountNoMasked}`,
      })),
    ],
    [meta.accounts]
  );
  const yearOptions = useMemo(
    () => [{ value: 'all', label: '全部年份' }, ...meta.years.map((y) => ({ value: y, label: y }))],
    [meta.years]
  );
  const monthOptions = useMemo(
    () => [{ value: 'all', label: '全部月份' }, ...meta.months.map((m) => ({ value: m, label: m }))],
    [meta.months]
  );
  // 类别按 level1 分组 + 全部
  const categoryOptions = useMemo<ClassicyPopUpMenuEntry[]>(() => {
    const groups = new Map<string, { value: string; label: string }[]>();
    for (const c of meta.categories) {
      const k = c.level1 || '其它';
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k)!.push({ value: c.code, label: c.label });
    }
    return [
      { value: 'all', label: '全部类别' },
      ...[...groups.entries()].map(([groupLabel, options]) => ({ groupLabel, options })),
    ];
  }, [meta.categories]);
  const categoryFlatOptions = useMemo(
    () => [
      { value: '', label: '请选择类别' },
      ...meta.categories.map((c) => ({ value: c.code, label: `${c.level1} / ${c.label}` })),
    ],
    [meta.categories]
  );
  const directionOptions = [
    { value: 'all', label: '全部方向' },
    { value: 'IN', label: '收入' },
    { value: 'OUT', label: '支出' },
  ];
  const domainOptions = useMemo(
    () => [{ value: 'all', label: '全部域' }, ...meta.domains.map((d) => ({ value: d, label: d }))],
    [meta.domains]
  );
  const scopeOptions = [
    { value: 'net', label: 'NET（剔除划转）' },
    { value: 'all', label: 'ALL（含划转）' },
  ];

  // 生效值 → 查询参数（useMemo 稳定引用，作为轮询 effect 依赖）
  const query = useMemo<LedgerFilters>(
    () => ({
      account: applied.account === 'all' ? 'all' : Number(applied.account),
      year: applied.year,
      month: applied.month,
      day: applied.day || undefined,
      category: applied.category,
      direction: applied.direction as LedgerFilters['direction'],
      domain: applied.domain,
      scope: applied.scope,
      q: applied.q || undefined,
      limit: PAGE,
      offset: 0,
    }),
    [applied]
  );
  queryRef.current = query;

  // 手写 useEffect 轮询（参考 usePolling.ts）：query / refreshKey 变化即重载第一页
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const run = async () => {
      try {
        const d = await fetchLedgerTxns({ ...queryRef.current, offset: 0, limit: PAGE });
        if (cancelled) return;
        setResult(d);
        setRows(d.rows);
        setError(null);
        setUpdatedAt(Date.now());
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e : new Error(String(e)));
        onErrorRef.current(e);
      }
    };
    void run();
    const id = window.setInterval(() => {
      void run();
    }, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [open, query, refreshKey]);

  const loadMore = async () => {
    if (!result || loadingMore || rows.length >= result.total) return;
    setLoadingMore(true);
    try {
      const d = await fetchLedgerTxns({ ...query, offset: rows.length, limit: PAGE });
      setRows((prev) => [...prev, ...d.rows]);
      setResult(d);
      setError(null);
      setUpdatedAt(Date.now());
    } catch (e) {
      setError(e instanceof Error ? e : new Error(String(e)));
      onError(e);
    } finally {
      setLoadingMore(false);
    }
  };

  const applyCategory = async () => {
    if (!catCode || selected.length === 0 || catBusy) return;
    setCatBusy(true);
    try {
      const ids = selected.map(Number).filter(Number.isFinite);
      const res = await setLedgerCategory(ids, catCode);
      setCatOpen(false);
      setCatCode('');
      onChanged(`已更新 ${res.updated} 笔类别`);
    } catch (e) {
      onError(e);
    } finally {
      setCatBusy(false);
    }
  };

  const onExport = async () => {
    setExporting(true);
    try {
      await downloadLedgerTxnsCsv(query);
    } catch (e) {
      onError(e);
    } finally {
      setExporting(false);
    }
  };

  const columns = useMemo<ClassicyTableColumn<LedgerTxn>[]>(
    () => [
      { id: 'date', title: '日期', accessor: (r) => r.txnDate, width: 96 },
      { id: 'time', title: '时间', accessor: (r) => r.txnTime, width: 72 },
      { id: 'account', title: '账户', accessor: (r) => r.accountNoMasked ?? '', width: 130 },
      {
        id: 'in',
        title: '收入(¥)',
        accessor: (r) => r.incomeCent,
        width: 92,
        align: 'right',
        render: (r) => (
          <span className="sp-ledger-num" style={{ color: r.incomeCent ? LEDGER_INCOME_COLOR : undefined }}>
            {r.incomeCent ? formatCent(r.incomeCent) : '—'}
          </span>
        ),
      },
      {
        id: 'out',
        title: '支出(¥)',
        accessor: (r) => r.expenseCent,
        width: 92,
        align: 'right',
        render: (r) => (
          <span className="sp-ledger-num" style={{ color: r.expenseCent ? LEDGER_EXPENSE_COLOR : undefined }}>
            {r.expenseCent ? formatCent(r.expenseCent) : '—'}
          </span>
        ),
      },
      {
        id: 'balance',
        title: '余额(¥)',
        accessor: (r) => r.balanceCent,
        width: 100,
        align: 'right',
        render: (r) => <span className="sp-ledger-num">{formatCent(r.balanceCent)}</span>,
      },
      { id: 'type', title: '类型', accessor: (r) => r.txnType, width: 96 },
      { id: 'category', title: '类别', accessor: (r) => r.categoryLabel ?? '', width: 110 },
      { id: 'counterparty', title: '对方', accessor: (r) => r.counterparty ?? '' },
      { id: 'channel', title: '渠道', accessor: (r) => r.channel ?? '', width: 90 },
      { id: 'memo', title: '备注', accessor: (r) => r.memoClean ?? '' },
      { id: 'src', title: '来源', accessor: (r) => r.source ?? '', width: 80 },
    ],
    []
  );

  const summary = result?.summary;

  return (
    <div className="sp-ledger-tab-body">
      <div className="sp-toolbar sp-ledger-toolbar sp-ledger-toolbar-wrap">
        <ClassicyPopUpMenu id="ledger-t-account" label="账户" labelPosition="left" labelSize="small" size="small"
          options={accountOptions} selected={draft.account} onChangeFunc={(e) => setSelectD('account', e.target.value)} />
        <ClassicyPopUpMenu id="ledger-t-year" label="年" labelPosition="left" labelSize="small" size="small"
          options={yearOptions} selected={draft.year} onChangeFunc={(e) => setSelectD('year', e.target.value)} />
        <ClassicyPopUpMenu id="ledger-t-month" label="月" labelPosition="left" labelSize="small" size="small"
          options={monthOptions} selected={draft.month} onChangeFunc={(e) => setSelectD('month', e.target.value)} />
        <ClassicyInput id="ledger-t-day" labelTitle="日" labelSize="small" labelPosition="left"
          placeholder="YYYY-MM-DD" prefillValue={draft.day} onChangeFunc={(e) => setD('day', e.target.value)}
          onEnterFunc={() => setApplied({ ...draft })} />
        <ClassicyPopUpMenu id="ledger-t-category" label="类别" labelPosition="left" labelSize="small" size="small"
          options={categoryOptions} selected={draft.category} onChangeFunc={(e) => setSelectD('category', e.target.value)} />
        <ClassicyPopUpMenu id="ledger-t-direction" label="方向" labelPosition="left" labelSize="small" size="small"
          options={directionOptions} selected={draft.direction} onChangeFunc={(e) => setSelectD('direction', e.target.value)} />
        <ClassicyPopUpMenu id="ledger-t-domain" label="域" labelPosition="left" labelSize="small" size="small"
          options={domainOptions} selected={draft.domain} onChangeFunc={(e) => setSelectD('domain', e.target.value)} />
        <ClassicyPopUpMenu id="ledger-t-scope" label="口径" labelPosition="left" labelSize="small" size="small"
          options={scopeOptions} selected={draft.scope}
          onChangeFunc={(e) => setSelectD('scope', e.target.value as Drafts['scope'])} />
        {draft.scope === 'net' && <span className="sp-ledger-note">已剔除跨卡划转</span>}
        <ClassicyInput id="ledger-t-q" labelTitle="关键字" labelSize="small" labelPosition="left"
          placeholder="备注 / 对方…" prefillValue={draft.q} onChangeFunc={(e) => setD('q', e.target.value)}
          onEnterFunc={() => setApplied({ ...draft })} />
        <ClassicyButton buttonSize="small" isDefault onClickFunc={() => setApplied({ ...draft })}>筛选</ClassicyButton>
        <ClassicyButton buttonSize="small" onClickFunc={() => { setDraft(DEFAULT_DRAFTS); setApplied(DEFAULT_DRAFTS); }}>重置</ClassicyButton>
      </div>

      <div className="sp-ledger-tab-scroll">
        {summary && (
          <div className="sp-ledger-summary">
            <span>收入 <b style={{ color: LEDGER_INCOME_COLOR }}>¥{formatCent(summary.incomeCent)}</b></span>
            <span>支出 <b style={{ color: LEDGER_EXPENSE_COLOR }}>¥{formatCent(summary.expenseCent)}</b></span>
            <span>净额 <b style={{ color: LEDGER_NET_COLOR }}>¥{formatCent(summary.netCent)}</b></span>
            <span>共 {result?.total ?? 0} 笔</span>
          </div>
        )}
        <div className="sp-ledger-table">
          {rows.length === 0 ? (
            <p className="sp-dim sp-ledger-pad">{error ? '加载失败' : '当前筛选无流水'}</p>
          ) : (
            <ClassicyTable
              columns={columns}
              rows={rows}
              getRowId={(r) => String(r.txnId)}
              selectionMode="multi"
              selected={selected}
              onSelectionChange={setSelected}
              stickyHeader
            />
          )}
        </div>
      </div>

      <div className="sp-ledger-status">
        <span className={error ? 'sp-ledger-status-err' : undefined}>
          {error ? `刷新失败：${error.message}（显示上次数据）` : `上次更新 ${fmtClock(updatedAt)}`}
        </span>
        <span className="sp-ledger-status-actions">
          <ClassicyButton buttonSize="small" disabled={!result || rows.length >= result.total || loadingMore}
            onClickFunc={() => { void loadMore(); }}>
            {loadingMore ? '加载中…' : '加载更多'}
          </ClassicyButton>
          <ClassicyButton buttonSize="small" disabled={selected.length === 0} onClickFunc={() => setCatOpen(true)}>
            设置类别…
          </ClassicyButton>
          <ClassicyButton buttonSize="small" disabled={exporting} onClickFunc={() => { void onExport(); }}>
            {exporting ? '导出中…' : '导出 CSV'}
          </ClassicyButton>
        </span>
      </div>

      {/* 改类别：modal + ClassicyForm(layout=dialog) + FormButtonRow */}
      {catOpen && (
        <ClassicyWindow
          modal
          id="ledger-category-window"
          title="设置类别"
          appId={APP_ID}
          scrollable={false}
          closable={false}
          initialSize={[360, 190]}
          initialPosition={['center', 'center']}
          onCloseFunc={() => setCatOpen(false)}
        >
          <ClassicyForm
            layout="dialog"
            onSubmitFunc={(e) => {
              e.preventDefault();
              void applyCategory();
            }}
          >
            <ClassicyPopUpMenu
              id="ledger-cat-select"
              label="类别"
              labelPosition="left"
              labelSize="small"
              options={categoryFlatOptions}
              selected={catCode}
              onChangeFunc={(e) => setCatCode(e.target.value)}
            />
            <ClassicyFormButtonRow>
              <ClassicyButton onClickFunc={() => setCatOpen(false)}>取消</ClassicyButton>
              <ClassicyButton isDefault buttonType="submit" disabled={!catCode || catBusy}>
                {catBusy ? '保存中…' : '确定'}
              </ClassicyButton>
            </ClassicyFormButtonRow>
          </ClassicyForm>
        </ClassicyWindow>
      )}
    </div>
  );
}
