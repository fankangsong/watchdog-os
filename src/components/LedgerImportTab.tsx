import { useMemo, useState } from 'react';
import {
  ClassicyButton,
  ClassicyControlGroup,
  ClassicyFileInput,
  ClassicyInput,
  ClassicyPopUpMenu,
  ClassicyTable,
  type ClassicyTableColumn,
} from 'classicy';
import {
  commitImport,
  previewImport,
  type LedgerPreviewResult,
  type LedgerPreviewRow,
} from '../api';
import { LEDGER_EXPENSE_COLOR, LEDGER_INCOME_COLOR, formatCent } from '../format';

/** 状态标签：新增（可勾选，默认选中）/ 已存在（置灰，默认不选）/ 冲突（禁选，标红） */
function statusBadge(status: LedgerPreviewRow['status']) {
  const style: Record<LedgerPreviewRow['status'], { cls: string; label: string }> = {
    new: { cls: 'sp-ledger-badge-new', label: '新增' },
    exists: { cls: 'sp-ledger-badge-exists', label: '已存在' },
    conflict: { cls: 'sp-ledger-badge-conflict', label: '冲突' },
  };
  const s = style[status];
  return <span className={`sp-ledger-badge ${s.cls}`}>{s.label}</span>;
}

/**
 * CSV 导入：选文件 → FileReader(UTF-8) → previewImport → 前端筛选 / 勾选 → commitImport。
 * 错误一律保留上次预览数据，仅在状态栏红字提示并上报 onError（由 App 处理 Unauthorized 登出）。
 */
export function LedgerImportTab({
  onImported,
  onError,
}: {
  onImported: (msg: string) => void;
  onError: (e: unknown) => void;
}) {
  const [filename, setFilename] = useState('');
  const [text, setText] = useState('');
  const [preview, setPreview] = useState<LedgerPreviewResult | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [monthFilter, setMonthFilter] = useState('all');
  const [dayDraft, setDayDraft] = useState('');
  const [dayFilter, setDayFilter] = useState('');

  // 选 .csv → 读为文本 → 预览；成功后默认勾选全部「新增」行
  const onFile = (files: File[]) => {
    const file = files[0];
    if (!file) return;
    setError('');
    setBusy(true);
    const reader = new FileReader();
    reader.onload = async () => {
      const content = typeof reader.result === 'string' ? reader.result : '';
      setFilename(file.name);
      setText(content);
      try {
        const res = await previewImport(file.name, content);
        setPreview(res);
        setSelected(res.rows.filter((r) => r.status === 'new').map((r) => r.rowHash));
        setMonthFilter('all');
        setDayFilter('');
        setDayDraft('');
      } catch (e) {
        // 失败保留上次预览数据
        setError(e instanceof Error ? e.message : String(e));
        onError(e);
      } finally {
        setBusy(false);
      }
    };
    reader.onerror = () => {
      setBusy(false);
      const err = new Error('读取文件失败');
      setError(err.message);
      onError(err);
    };
    reader.readAsText(file, 'UTF-8');
  };

  // 月份选项：从预览行的 txnDate 取 YYYY-MM 去重，含「全部月份」
  const months = useMemo(() => {
    if (!preview) return [{ value: 'all', label: '全部月份' }];
    const set = new Set(preview.rows.map((r) => r.txnDate.slice(0, 7)).filter(Boolean));
    return [
      { value: 'all', label: '全部月份' },
      ...[...set].sort().map((m) => ({ value: m, label: m })),
    ];
  }, [preview]);

  // 筛选纯前端：月 + 日（生效值由回车 / 筛选按钮应用，与输入框草稿分离）
  const filteredRows = useMemo(() => {
    if (!preview) return [];
    return preview.rows.filter((r) => {
      if (monthFilter !== 'all' && r.txnDate.slice(0, 7) !== monthFilter) return false;
      if (dayFilter && r.txnDate !== dayFilter) return false;
      return true;
    });
  }, [preview, monthFilter, dayFilter]);

  // 受控选择：conflict 行永远从选中集里剔除，实现「禁选」
  const onSelectionChange = (ids: string[]) => {
    const conflict = new Set(
      (preview?.rows ?? []).filter((r) => r.status === 'conflict').map((r) => r.rowHash)
    );
    setSelected(ids.filter((id) => !conflict.has(id)));
  };

  const selectAllNew = () => {
    if (!preview) return;
    setSelected((prev) => {
      const next = new Set(prev);
      preview.rows.filter((r) => r.status === 'new').forEach((r) => next.add(r.rowHash));
      return [...next];
    });
  };

  const columns = useMemo<ClassicyTableColumn<LedgerPreviewRow>[]>(
    () => [
      { id: 'status', title: '状态', accessor: (r) => r.status, width: 72, render: (r) => statusBadge(r.status) },
      { id: 'date', title: '日期', accessor: (r) => r.txnDate, width: 96 },
      { id: 'time', title: '时间', accessor: (r) => r.txnTime, width: 72 },
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
      { id: 'counterparty', title: '对方', accessor: (r) => r.counterparty ?? '' },
      { id: 'channel', title: '渠道', accessor: (r) => r.channel, width: 96 },
      { id: 'category', title: '类别(推测)', accessor: (r) => r.categoryGuess, width: 110 },
      { id: 'memo', title: '备注(清洗)', accessor: (r) => r.memoClean },
    ],
    []
  );

  const onCommit = async () => {
    if (!preview || selected.length === 0 || busy) return;
    setBusy(true);
    setError('');
    try {
      const res = await commitImport(filename, text, selected);
      // 成功后清空预览
      setPreview(null);
      setSelected([]);
      setFilename('');
      setText('');
      onImported(`已入库 ${res.inserted} 笔（跳过 ${res.skipped}、冲突 ${res.conflicts}）`);
    } catch (e) {
      // 失败保留上次预览数据
      setError(e instanceof Error ? e.message : String(e));
      onError(e);
    } finally {
      setBusy(false);
    }
  };

  const statusText = error
    ? `失败：${error}`
    : preview
      ? `预览 ${preview.rowCount} · 新增 ${preview.counts.new} · 已存在 ${preview.counts.exists} · 冲突 ${preview.counts.conflict} · 已选 ${selected.length} · 当前显示 ${filteredRows.length}`
      : busy
        ? '正在解析 CSV…'
        : '选择银行导出的 .csv 文件开始预览';

  return (
    <div className="sp-ledger-tab-body">
      <div className="sp-toolbar sp-ledger-toolbar">
        <ClassicyFileInput
          id="ledger-import-file"
          accept=".csv"
          labelTitle="选择 CSV"
          labelSize="small"
          labelPosition="left"
          onChangeFunc={onFile}
        />
        <ClassicyPopUpMenu
          id="ledger-import-month"
          label="月份"
          labelPosition="left"
          labelSize="small"
          size="small"
          options={months}
          selected={monthFilter}
          disabled={!preview}
          onChangeFunc={(e) => setMonthFilter(e.target.value)}
        />
        <ClassicyInput
          id="ledger-import-day"
          labelTitle="日期"
          labelSize="small"
          labelPosition="left"
          placeholder="YYYY-MM-DD"
          prefillValue={dayDraft}
          disabled={!preview}
          onChangeFunc={(e) => setDayDraft(e.target.value)}
          onEnterFunc={() => setDayFilter(dayDraft.trim())}
        />
        <ClassicyButton buttonSize="small" disabled={!preview} onClickFunc={() => setDayFilter(dayDraft.trim())}>
          筛选
        </ClassicyButton>
        <ClassicyButton buttonSize="small" disabled={!preview} onClickFunc={selectAllNew}>
          全选新增
        </ClassicyButton>
        {(monthFilter !== 'all' || dayFilter) && (
          <ClassicyButton
            buttonSize="small"
            onClickFunc={() => {
              setMonthFilter('all');
              setDayFilter('');
              setDayDraft('');
            }}
          >
            重置
          </ClassicyButton>
        )}
      </div>

      <div className="sp-ledger-tab-scroll">
        {preview && (
          <ClassicyControlGroup label="账户与合计核对" variant="primary">
            <div className="sp-ledger-cards">
              <div className="sp-ledger-card">
                <span className="sp-ledger-card-value">{preview.account.accountNoMasked || '—'}</span>
                <span className="sp-ledger-card-label">账户</span>
              </div>
              <div className="sp-ledger-card">
                <span className="sp-ledger-card-value">
                  {preview.account.bankName || '—'} · {preview.account.currency}
                </span>
                <span className="sp-ledger-card-label">银行 / 币种</span>
              </div>
              <div className="sp-ledger-card">
                <span className="sp-ledger-card-value">
                  {preview.account.periodStart || '—'} ~ {preview.account.periodEnd || '—'}
                </span>
                <span className="sp-ledger-card-label">账期</span>
              </div>
              <div className="sp-ledger-card">
                <span className={`sp-ledger-card-value ${preview.checked.declaredMatch ? 'sp-ledger-ok' : 'sp-ledger-bad'}`}>
                  {preview.checked.declaredMatch ? '一致' : '不一致'}
                </span>
                <span className="sp-ledger-card-label">声明合计核对</span>
              </div>
              <div className="sp-ledger-card">
                <span className={`sp-ledger-card-value ${preview.checked.balanceChainWithinFile ? 'sp-ledger-ok' : 'sp-ledger-bad'}`}>
                  {preview.checked.balanceChainWithinFile ? '连续' : '断裂'}
                </span>
                <span className="sp-ledger-card-label">文件内余额链</span>
              </div>
              <div className="sp-ledger-card">
                <span className="sp-ledger-card-value">{preview.rowCount}</span>
                <span className="sp-ledger-card-label">解析行数</span>
              </div>
            </div>

            {Object.keys(preview.actual).length > 0 && (
              <div className="sp-ledger-checks">
                {Object.entries(preview.actual).map(([k, v]) => (
                  <span key={k} className="sp-ledger-check">
                    {k}：声明 {preview.declared[k] ?? '—'} / 实际 {v}
                  </span>
                ))}
              </div>
            )}
            {preview.checked.chainErrors.length > 0 && (
              <div className="sp-ledger-warnings">
                {preview.checked.chainErrors.map((c, i) => (
                  <div key={i}>余额链：{c}</div>
                ))}
              </div>
            )}
            {preview.warnings.length > 0 && (
              <div className="sp-ledger-warnings">
                {preview.warnings.map((w, i) => (
                  <div key={i}>⚠ {w}</div>
                ))}
              </div>
            )}
          </ClassicyControlGroup>
        )}

        <ClassicyControlGroup label={`预览明细（${filteredRows.length}）`} variant="primary">
          <div className="sp-ledger-table">
            {filteredRows.length === 0 ? (
              <p className="sp-dim sp-ledger-pad">{preview ? '当前筛选无匹配行' : '尚未选择文件'}</p>
            ) : (
              <ClassicyTable
                columns={columns}
                rows={filteredRows}
                getRowId={(r) => r.rowHash}
                selectionMode="multi"
                selected={selected}
                onSelectionChange={onSelectionChange}
                stickyHeader
              />
            )}
          </div>
        </ClassicyControlGroup>
      </div>

      <div className="sp-ledger-status">
        <span className={error ? 'sp-ledger-status-err' : undefined}>{statusText}</span>
        <span>
          <ClassicyButton
            disabled={!preview || selected.length === 0 || busy}
            onClickFunc={() => {
              void onCommit();
            }}
          >
            {busy ? '处理中…' : '导入选中'}
          </ClassicyButton>
        </span>
      </div>
    </div>
  );
}
