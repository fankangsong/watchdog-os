import { useEffect, useMemo } from 'react';
import {
  ClassicyApp,
  ClassicyControlGroup,
  ClassicyIcons,
  ClassicyTable,
  type ClassicyTableColumn,
  ClassicyWindow,
} from 'classicy';
import { fetchPrinter, Unauthorized, type PrinterInfo, type PrinterJob, type PrinterState } from '../api';
import { usePolling } from '../hooks/usePolling';

const APP_ID = 'srv-printer.app';
const APP_NAME = 'Printer';

const PRINTER_STATE_TEXT: Record<string, string> = {
  idle: '空闲',
  processing: '打印中',
  stopped: '已停止',
};

const JOB_STATE_TEXT: Record<string, string> = {
  pending: '排队中',
  'pending-held': '已挂起',
  processing: '打印中',
  'processing-stopped': '已停止',
  canceled: '已取消',
  aborted: '异常终止',
  completed: '已完成',
};

function fmtTime(ms: number | null): string {
  if (!ms) return '—';
  return new Date(ms).toLocaleString();
}

/** 打印机工作状态展示：状态圆点 + 文案（附加缺纸/卡纸等原因） */
function printerStatus(p: PrinterInfo) {
  const text = PRINTER_STATE_TEXT[p.state] || p.state;
  const color = p.state === 'processing' ? '#0a0' : p.state === 'stopped' ? '#a00' : '#666';
  const reasons =
    p.stateReasons && p.stateReasons !== 'none'
      ? `（${p.stateReasons.replaceAll(',', '、')}）`
      : '';
  const message = p.stateMessage ? ` · ${p.stateMessage}` : '';
  return (
    <span>
      <b style={{ color }}>● {text}</b>
      {p.accepting ? '' : <span style={{ color: '#a00' }}> · 拒收新任务</span>}
      {reasons}
      {message}
    </span>
  );
}

/** USB 连接状态：USB 配置的打印机比对 lpinfo 物理设备；其余连接方式直接展示 URI */
function usbStatus(p: PrinterInfo) {
  if (!p.usbConfigured) {
    const scheme = p.deviceUri.split('://')[0] || 'other';
    return <span>网络/其他（{scheme}）</span>;
  }
  return p.usbConnected ? (
    <b style={{ color: '#0a0' }}>✓ USB 已连接</b>
  ) : (
    <b style={{ color: '#a00' }}>✗ USB 未连接</b>
  );
}

/** 打印机状态区（单台或多台逐行展示） */
function PrinterList({ state }: { state: PrinterState | null }) {
  if (!state) return <p className="sp-dim">Loading…</p>;
  if (!state.available) return <p className="sp-dim">{state.error || 'CUPS unavailable'}</p>;
  if (state.printers.length === 0) return <p className="sp-dim">未发现打印机</p>;
  return (
    <div style={{ padding: '8px 12px', display: 'grid', gap: 8, fontSize: 12 }}>
      {state.printers.map((p) => (
        <div key={p.name}>
          <div>
            <b>{p.name}</b>
            <span style={{ color: '#666' }}>{p.model ? ` · ${p.model}` : ''}</span>
          </div>
          <div>工作状态：{printerStatus(p)}</div>
          <div>
            连接：{usbStatus(p)}
            <span style={{ color: '#666', wordBreak: 'break-all' }}> · {p.deviceUri}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

function JobTable({ jobs, showCompletedAt }: { jobs: PrinterJob[]; showCompletedAt: boolean }) {
  const columns = useMemo<ClassicyTableColumn<PrinterJob>[]>(
    () => [
      { id: 'name', title: '文档', accessor: (j) => j.name },
      { id: 'printer', title: '打印机', accessor: (j) => j.printer, width: 90 },
      { id: 'host', title: '发起设备', accessor: (j) => j.host, width: 130 },
      { id: 'user', title: '用户', accessor: (j) => j.user, width: 90 },
      {
        id: 'size',
        title: '大小',
        accessor: (j) => j.sizeKB,
        width: 80,
        align: 'right',
        render: (j) => (j.sizeKB > 1024 ? `${(j.sizeKB / 1024).toFixed(1)}M` : `${j.sizeKB}K`),
      },
      ...(showCompletedAt
        ? []
        : [
            {
              id: 'state',
              title: '状态',
              accessor: (j) => JOB_STATE_TEXT[j.state] || j.state,
              width: 80,
            } as ClassicyTableColumn<PrinterJob>,
          ]),
      {
        id: 'time',
        title: showCompletedAt ? '完成时间' : '提交时间',
        accessor: (j) => (showCompletedAt ? j.completedMs ?? j.createdMs : j.createdMs),
        width: 160,
        render: (j) => fmtTime(showCompletedAt ? j.completedMs ?? j.createdMs : j.createdMs),
      },
    ],
    [showCompletedAt]
  );

  if (jobs.length === 0) {
    return <p className="sp-dim" style={{ padding: '4px 12px' }}>{showCompletedAt ? '暂无打印历史' : '队列为空'}</p>;
  }
  return <ClassicyTable columns={columns} rows={jobs} getRowId={(j) => `${j.printer}-${j.id}`} />;
}

/** 应用：CUPS 打印机状态 / 打印队列 / 打印历史 */
export function PrinterApp({ onLogout }: { onLogout?: () => void }) {
  const poll = usePolling(fetchPrinter, 5000);

  useEffect(() => {
    if (poll.error instanceof Unauthorized) onLogout?.();
  }, [poll.error, onLogout]);

  const appMenu = useMemo(
    () => [
      {
        id: 'sys',
        title: 'System',
        menuChildren: [{ id: 'logout', title: 'Sign Out', onClickFunc: () => onLogout?.() }],
      },
    ],
    [onLogout]
  );

  const state = poll.data;

  return (
    <ClassicyApp id={APP_ID} name={APP_NAME} icon={ClassicyIcons.system.printer} defaultWindow="printer-main">
      <ClassicyWindow
        id="printer-main"
        title={APP_NAME}
        icon={ClassicyIcons.system.printer}
        appId={APP_ID}
        scrollable
        resizable
        zoomable
        collapsable
        closable
        initialSize={[860, 560]}
        initialPosition={['center', 'center']}
        minimumSize={[620, 380]}
        appMenu={appMenu}
      >
        <ClassicyControlGroup label={`Printers (${state?.printers?.length ?? 0})`}>
          <PrinterList state={state} />
        </ClassicyControlGroup>
        <ClassicyControlGroup label={`Queue (${state?.activeJobs?.length ?? 0})`}>
          <JobTable jobs={state?.activeJobs ?? []} showCompletedAt={false} />
        </ClassicyControlGroup>
        <ClassicyControlGroup label={`History (${state?.history?.length ?? 0})`}>
          <JobTable jobs={state?.history ?? []} showCompletedAt />
        </ClassicyControlGroup>
      </ClassicyWindow>
    </ClassicyApp>
  );
}
