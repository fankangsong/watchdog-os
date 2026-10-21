import { useEffect, useMemo, useState } from 'react';
import {
  ClassicyApp,
  ClassicyButton,
  ClassicyControlGroup,
  ClassicyIcons,
  ClassicyTable,
  type ClassicyTableColumn,
  ClassicyWindow,
  useClassicyAboutMenu,
} from 'classicy';
import { printTestPage, Unauthorized, type PrinterInfo, type PrinterJob, type PrinterState } from '../api';
import { printerPoll } from '../polls';
import { useSharedPoll } from '../sharedPoll';
import { quitMenuItem } from '../quitMenuItem';

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

/** 测试页操作结果（按打印机名关联，成功/失败都就地展示在对应行） */
interface TestPageResult {
  printer: string;
  ok: boolean;
  text: string;
}

/** 打印机状态区（单台或多台逐行展示），每台附「打印测试页」按钮 */
function PrinterList({
  state,
  testingName,
  testResult,
  onTestPage,
}: {
  state: PrinterState | null;
  testingName: string;
  testResult: TestPageResult | null;
  onTestPage: (name: string) => void;
}) {
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
          <div style={{ marginTop: 2, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <ClassicyButton
              buttonSize="small"
              disabled={!!testingName || !p.accepting}
              onClickFunc={() => onTestPage(p.name)}
            >
              {testingName === p.name ? '正在提交…' : '打印测试页'}
            </ClassicyButton>
            {testResult && testResult.printer === p.name && (
              <span style={{ color: testResult.ok ? '#070' : '#a00', wordBreak: 'break-all' }}>
                {testResult.text}
              </span>
            )}
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
  // 页面级共享轮询（printerPoll）：退出应用不中断（docs/tasks.md）
  const poll = useSharedPoll(printerPoll);

  /** 正在提交测试页的打印机名（空串 = 空闲）；结果就地展示在对应打印机行 */
  const [testingName, setTestingName] = useState('');
  const [testResult, setTestResult] = useState<TestPageResult | null>(null);

  const onTestPage = async (name: string) => {
    setTestingName(name);
    setTestResult(null);
    try {
      const r = await printTestPage(name);
      setTestResult({ printer: name, ok: true, text: r.jobId ? `测试页已提交（作业 #${r.jobId}）` : '测试页已提交' });
      printerPoll.reload(); // 新作业会出现在队列/历史里，立即刷新
    } catch (e) {
      setTestResult({ printer: name, ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setTestingName('');
    }
  };

  const { aboutMenuItem, aboutWindow } = useClassicyAboutMenu(APP_ID, APP_NAME, ClassicyIcons.system.printer);

  useEffect(() => {
    if (poll.error instanceof Unauthorized) onLogout?.();
  }, [poll.error, onLogout]);

  const appMenu = useMemo(
    () => [
      {
        id: 'printer-menu',
        title: APP_NAME,
        menuChildren: [
          aboutMenuItem,
          { id: 'spacer' },
          quitMenuItem(APP_ID, APP_NAME, ClassicyIcons.system.printer),
        ],
      },
    ],
    [aboutMenuItem]
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
          <PrinterList state={state} testingName={testingName} testResult={testResult} onTestPage={onTestPage} />
        </ClassicyControlGroup>
        <ClassicyControlGroup label={`Queue (${state?.activeJobs?.length ?? 0})`}>
          <JobTable jobs={state?.activeJobs ?? []} showCompletedAt={false} />
        </ClassicyControlGroup>
        <ClassicyControlGroup label={`History (${state?.history?.length ?? 0})`}>
          <JobTable jobs={state?.history ?? []} showCompletedAt />
        </ClassicyControlGroup>
      </ClassicyWindow>
      {aboutWindow}
    </ClassicyApp>
  );
}
