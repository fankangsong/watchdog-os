import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ClassicyAlert,
  ClassicyButton,
  ClassicyControlGroup,
  ClassicyFileInput,
  ClassicyTable,
  type ClassicyTableColumn,
} from 'classicy';
import {
  createLedgerBackup,
  deleteLedgerBackup,
  downloadCurrentDb,
  downloadLedgerBackup,
  fetchLedgerBackups,
  fetchLedgerDbInfo,
  restoreLedgerBackup,
  uploadLedgerBackup,
  type LedgerBackup,
} from '../api';
import { fmtBytes } from '../format';
import { useAppOpen } from '../hooks/useAppOpen';

const APP_ID = 'srv-ledger.app';

type DbInfo = Awaited<ReturnType<typeof fetchLedgerDbInfo>>;
type RestoreConfirm = { source: string; file?: File };

/** 备份类型徽标：安全快照（auto-before-restore）用醒目标识，Delete 由调用方禁用 */
function kindBadge(r: LedgerBackup) {
  if (r.isPreRestoreSafety || r.kind === 'auto-before-restore') {
    return <span className="sp-ledger-badge sp-ledger-badge-safety">安全快照</span>;
  }
  if (r.kind === 'auto-before-import') {
    return <span className="sp-ledger-badge sp-ledger-badge-auto">导入前自动</span>;
  }
  return <span className="sp-ledger-badge sp-ledger-badge-manual">手动</span>;
}

/**
 * 备份 / 恢复：当前库信息卡片、手动备份、下载、备份列表、外部 .db 上传恢复。
 * 任何覆盖操作都经 ClassicyAlert 二次确认（Cancel 默认），恢复前快照可用于撤销。
 * 409 restore in progress 时禁用全部操作按钮并提示稍后重试。
 */
export function LedgerMaintenanceTab({
  refreshKey,
  onChanged,
  onError,
}: {
  refreshKey: number;
  onChanged: (msg: string) => void;
  onError: (e: unknown) => void;
}) {
  const open = useAppOpen(APP_ID);
  const [info, setInfo] = useState<DbInfo | null>(null);
  const [backups, setBackups] = useState<LedgerBackup[]>([]);
  const [dir, setDir] = useState('');
  const [error, setError] = useState<Error | null>(null);
  const [flash, setFlash] = useState('');
  const [busy, setBusy] = useState(false);
  const [busyAction, setBusyAction] = useState('');
  const [restoreInProgress, setRestoreInProgress] = useState(false);
  const [confirm, setConfirm] = useState<RestoreConfirm | null>(null);

  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  const load = useCallback(async () => {
    if (!open) return;
    try {
      const [i, b] = await Promise.all([fetchLedgerDbInfo(), fetchLedgerBackups()]);
      setInfo(i);
      setBackups(b.backups);
      setDir(b.dir);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e : new Error(String(e)));
      onErrorRef.current(e);
    }
  }, [open]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  /** 统一错误处理：409 恢复进行中 → 全局禁用；其余 → 状态栏红字 + 上报 */
  const handleFailure = (e: unknown) => {
    const msg = e instanceof Error ? e.message : String(e);
    if (/409|in progress/i.test(msg)) {
      setRestoreInProgress(true);
      setError(new Error('另有恢复任务正在进行，请稍后再试'));
      return;
    }
    setError(e instanceof Error ? e : new Error(String(e)));
    onErrorRef.current(e);
  };

  /** 执行动作期间的按钮禁用 + 错误收口 */
  const withBusy = async (label: string, fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setBusyAction(label);
    setError(null);
    setFlash('');
    try {
      await fn();
    } catch (e) {
      handleFailure(e);
    } finally {
      setBusy(false);
      setBusyAction('');
    }
  };

  const backupNow = () =>
    withBusy('备份', async () => {
      await createLedgerBackup();
      await load();
      setFlash('已创建手动备份');
    });

  const downloadCurrent = () =>
    withBusy('下载', async () => {
      await downloadCurrentDb();
      setFlash('已下载当前数据库');
    });

  const downloadBackup = (name: string) =>
    withBusy('下载', async () => {
      await downloadLedgerBackup(name);
      setFlash(`已下载备份 ${name}`);
    });

  const deleteBackup = (name: string) =>
    withBusy('删除', async () => {
      await deleteLedgerBackup(name);
      await load();
      setFlash(`已删除备份 ${name}`);
    });

  /** 确认后恢复：列表来源走 restoreLedgerBackup(name)，外部文件走 uploadLedgerBackup(file) */
  const doRestore = () =>
    withBusy('恢复', async () => {
      if (!confirm) return;
      const res = confirm.file
        ? await uploadLedgerBackup(confirm.file)
        : await restoreLedgerBackup(confirm.source);
      setRestoreInProgress(false);
      setConfirm(null);
      await load();
      onChanged(
        `已恢复至 ${res.dateMin ?? '—'} ~ ${res.dateMax ?? '—'}（${res.txnCount} 笔），恢复前快照 ${res.preRestoreBackup.name}`
      );
    });

  // 表格 actions 通过 ref 调用最新处理函数，避免列定义随回调每次重建
  const actionsRef = useRef<{
    download: (name: string) => void;
    restore: (name: string) => void;
    remove: (name: string) => void;
  }>({ download: () => {}, restore: () => {}, remove: () => {} });
  actionsRef.current = {
    download: (n) => {
      void downloadBackup(n);
    },
    restore: (n) => setConfirm({ source: n }),
    remove: (n) => {
      void deleteBackup(n);
    },
  };

  const columns = useMemo<ClassicyTableColumn<LedgerBackup>[]>(
    () => [
      {
        id: 'name',
        title: '名称',
        accessor: (r) => r.name,
        width: 220,
        render: (r) => (
          <span className="sp-ledger-mono" title={r.name}>
            {r.name}
          </span>
        ),
      },
      { id: 'kind', title: '类型', accessor: (r) => r.kind, width: 120, render: (r) => kindBadge(r) },
      {
        id: 'created',
        title: '创建时间',
        accessor: (r) => r.createdAt,
        width: 158,
        render: (r) => <span className="sp-ledger-mono">{r.createdAt || '—'}</span>,
      },
      {
        id: 'size',
        title: '大小',
        accessor: (r) => r.sizeBytes,
        width: 88,
        align: 'right',
        render: (r) => fmtBytes(r.sizeBytes),
      },
      {
        id: 'rows',
        title: '笔数',
        accessor: (r) => r.txnCount ?? 0,
        width: 76,
        align: 'right',
        render: (r) => (r.txnCount == null ? '—' : String(r.txnCount)),
      },
      {
        id: 'range',
        title: '日期范围',
        accessor: (r) => `${r.dateMin ?? ''}~${r.dateMax ?? ''}`,
        width: 178,
        render: (r) => (r.dateMin || r.dateMax ? `${r.dateMin ?? '—'} ~ ${r.dateMax ?? '—'}` : '—'),
      },
      {
        id: 'actions',
        title: '操作',
        accessor: (r) => r.name,
        width: 232,
        sortable: false,
        render: (r) => (
          <span className="sp-ledger-row-actions">
            <ClassicyButton
              buttonSize="small"
              disabled={busy || restoreInProgress}
              onClickFunc={(e) => {
                e.stopPropagation();
                actionsRef.current.download(r.name);
              }}
            >
              下载
            </ClassicyButton>
            <ClassicyButton
              buttonSize="small"
              disabled={busy || restoreInProgress}
              onClickFunc={(e) => {
                e.stopPropagation();
                actionsRef.current.restore(r.name);
              }}
            >
              恢复…
            </ClassicyButton>
            <ClassicyButton
              buttonSize="small"
              disabled={busy || restoreInProgress || r.isPreRestoreSafety}
              onClickFunc={(e) => {
                e.stopPropagation();
                actionsRef.current.remove(r.name);
              }}
            >
              删除
            </ClassicyButton>
          </span>
        ),
      },
    ],
    [busy, restoreInProgress]
  );

  const statusText = restoreInProgress
    ? '另有恢复任务正在进行，请稍后再试'
    : error
      ? `失败：${error.message}（显示上次数据）`
      : flash || '就绪';

  return (
    <div className="sp-ledger-tab-body">
      <div className="sp-toolbar sp-ledger-toolbar">
        <ClassicyButton disabled={busy || restoreInProgress} onClickFunc={() => void backupNow()}>
          {busyAction === '备份' ? '备份中…' : '立即备份'}
        </ClassicyButton>
        <ClassicyButton disabled={busy || restoreInProgress} onClickFunc={() => void downloadCurrent()}>
          下载当前 .db
        </ClassicyButton>
        <ClassicyButton disabled={busy || restoreInProgress} onClickFunc={() => void load()}>
          刷新
        </ClassicyButton>
        <span className="sp-ledger-note">含完整原始流水，请妥善保管</span>
      </div>

      <div className="sp-ledger-tab-scroll">
        <ClassicyControlGroup label="当前数据库" variant="primary">
          {info ? (
            <div className="sp-ledger-cards">
              <div className="sp-ledger-card">
                <span className="sp-ledger-card-value sp-ledger-mono">{info.fileName || '—'}</span>
                <span className="sp-ledger-card-label">数据库文件</span>
              </div>
              <div className="sp-ledger-card">
                <span className="sp-ledger-card-value">{fmtBytes(info.sizeBytes)}</span>
                <span className="sp-ledger-card-label">大小</span>
              </div>
              <div className="sp-ledger-card">
                <span className="sp-ledger-card-value sp-ledger-mono">{info.mtime || '—'}</span>
                <span className="sp-ledger-card-label">修改时间</span>
              </div>
              <div className="sp-ledger-card">
                <span className="sp-ledger-card-value">{info.txnCount} 笔</span>
                <span className="sp-ledger-card-label">{info.dateMin ?? '—'} ~ {info.dateMax ?? '—'}</span>
              </div>
              <div className="sp-ledger-card">
                <span className="sp-ledger-card-value">{info.journalMode || '—'}</span>
                <span className="sp-ledger-card-label">Journal 模式</span>
              </div>
              <div className="sp-ledger-card">
                <span className="sp-ledger-card-value sp-ledger-mono" title={info.backupDir}>{info.backupDir || '—'}</span>
                <span className="sp-ledger-card-label">备份目录</span>
              </div>
              <div className="sp-ledger-card">
                <span className="sp-ledger-card-value">{info.backupCount} 份</span>
                <span className="sp-ledger-card-label">备份份数</span>
              </div>
            </div>
          ) : (
            <p className="sp-dim sp-ledger-pad">正在读取数据库信息…</p>
          )}
        </ClassicyControlGroup>

        {/* 危险操作区：外部 .db 上传恢复 */}
        <div className="sp-ledger-danger">
          <div className="sp-ledger-danger-title">从外部 .db 文件恢复（危险操作）</div>
          <ClassicyFileInput
            id="ledger-restore-upload"
            accept=".db"
            labelTitle="选择 .db 文件"
            labelSize="small"
            labelPosition="left"
            disabled={busy || restoreInProgress}
            onChangeFunc={(files) => {
              const f = files[0];
              if (f) setConfirm({ source: `外部文件：${f.name}`, file: f });
            }}
          />
          <p className="sp-ledger-danger-hint">
            将覆盖当前数据库且不可自动撤销；选择文件后会二次确认，执行前系统自动保存恢复前快照。
          </p>
        </div>

        <ClassicyControlGroup label={`备份列表（${backups.length}）`} variant="primary">
          <div className="sp-ledger-table">
            {backups.length === 0 ? (
              <p className="sp-dim sp-ledger-pad">{error ? '加载失败' : '暂无备份'}</p>
            ) : (
              <ClassicyTable columns={columns} rows={backups} getRowId={(r) => r.name} stickyHeader />
            )}
          </div>
        </ClassicyControlGroup>
      </div>

      <div className="sp-ledger-status">
        <span className={error || restoreInProgress ? 'sp-ledger-status-err' : undefined}>{statusText}</span>
        <span className="sp-ledger-status-actions">
          {restoreInProgress && (
            <ClassicyButton
              buttonSize="small"
              onClickFunc={() => {
                setRestoreInProgress(false);
                void load();
              }}
            >
              重新检查
            </ClassicyButton>
          )}
          <span className="sp-ledger-mono">{dir}</span>
        </span>
      </div>

      {/* 二次确认：Cancel 默认，Restore 为危险操作（非默认按钮由 CSS 标红） */}
      {confirm && (
        <ClassicyAlert
          id="ledger-restore-alert"
          appId={APP_ID}
          alertType="caution"
          title="恢复数据库"
          label="⚠️ 此操作非常危险，将覆盖当前数据库且不可自动撤销"
          message={
            <div className="sp-ledger-confirm-msg">
              <p>
                当前库：{info?.txnCount ?? '—'} 笔 · {info?.dateMin ?? '—'} ~ {info?.dateMax ?? '—'}
              </p>
              <p>恢复来源：{confirm.source}</p>
              <p className="sp-ledger-confirm-safe">系统会自动保存一份恢复前快照，可用它撤销。</p>
            </div>
          }
          buttons={[
            { id: 'ledger-restore-cancel', label: '取消', role: 'cancel' },
            { id: 'ledger-restore-go', label: '覆盖并恢复', role: 'normal', onClick: () => void doRestore() },
          ]}
          defaultButtonId="ledger-restore-cancel"
          onClose={() => setConfirm(null)}
        />
      )}
    </div>
  );
}
