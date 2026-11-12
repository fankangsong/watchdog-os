import { useCallback, useEffect, useMemo, useState } from 'react';
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
import {
  controlPrinterJob,
  printTestPage,
  resumePrinter,
  Unauthorized,
  type PrinterInfo,
  type PrinterJob,
  type PrinterJobAction,
  type PrinterState,
} from '../api';
import { printerHistoryPoll, printerPoll } from '../polls';
import { useSharedPoll } from '../sharedPoll';
import { useAppOpen } from '../hooks/useAppOpen';
import { quitMenuItem } from '../quitMenuItem';

const APP_ID = 'srv-printer.app';
const APP_NAME = 'Printer';

/** 链路状态（link.state）：unknown 表示探测手段不可用，不是「没插」 */
const LINK_STATE_TEXT: Record<string, string> = {
  connected: '已连接',
  disconnected: '未连接',
  unknown: '未知',
};

/** 打印能力（ready.state）：与链路层解耦，暂停/缺纸/离线各自独立 */
const READY_STATE_TEXT: Record<string, string> = {
  ready: '可以打印',
  offline: '设备离线',
  paused: '已暂停',
  error: '需要处理',
  unknown: '状态未知',
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

const JOB_ACTION_OK_TEXT: Record<PrinterJobAction, string> = {
  hold: '任务已暂停',
  resume: '任务已恢复',
  cancel: '任务已取消',
  delete: '任务已删除',
};

/** 一条操作反馈：按目标 key 就地展示在对应打印机行 / 任务行 */
interface ActionFeedback {
  key: string;
  ok: boolean;
  text: string;
}

const jobKey = (j: PrinterJob) => `job:${j.printer}-${j.id}`;
const resumeKey = (name: string) => `resume:${name}`;

function fmtTime(ms: number | null): string {
  if (!ms) return '—';
  return new Date(ms).toLocaleString();
}

function fmtClock(ms: number): string {
  return new Date(ms).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

function fmtAgo(ms: number): string {
  if (!ms) return '—';
  const min = Math.floor((Date.now() - ms) / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const h = Math.floor(min / 60);
  return h < 24 ? `${h} 小时前` : `${Math.floor(h / 24)} 天前`;
}

/** 链路：USB 由服务端 sysfs 探测；网络打印机由 CUPS 判定可达性 */
function linkStatus(p: PrinterInfo) {
  if (p.transport !== 'usb') {
    const scheme = p.deviceUri.split('://')[0] || 'other';
    return (
      <span>
        <b style={{ color: p.link?.state === 'disconnected' ? '#a00' : '#666' }}>●</b> 网络（{scheme}）
        <span style={{ color: '#666' }}> · 可达性由 CUPS 判定</span>
      </span>
    );
  }
  const link = p.link;
  if (!link) return <span style={{ color: '#666' }}>○ {LINK_STATE_TEXT.unknown}</span>;
  if (link.state === 'connected') {
    return (
      <span>
        <b style={{ color: '#0a0' }}>● {LINK_STATE_TEXT.connected}</b>
        <span style={{ color: '#666' }}>
          {` · USB ${link.devicePath}`}
          {` · ${link.driverBound ? '驱动已绑定' : '驱动未绑定'}`}
          {` · 自 ${fmtClock(link.since)}`}
        </span>
      </span>
    );
  }
  if (link.state === 'disconnected') {
    return (
      <span>
        <b style={{ color: '#a00' }}>● {LINK_STATE_TEXT.disconnected}</b>
        {link.lastSeen ? <span style={{ color: '#666' }}>{' · 最后在线 '}{fmtAgo(link.lastSeen)}</span> : null}
      </span>
    );
  }
  return (
    <span>
      <b style={{ color: '#666' }}>○ {LINK_STATE_TEXT.unknown}</b>
      {link.detail ? <span style={{ color: '#666' }}>{' · '}{link.detail}</span> : null}
    </span>
  );
}

/** 打印能力：暂停/缺纸/离线/队列长度 */
function readyStatus(p: PrinterInfo) {
  const ready = p.ready || { state: 'unknown', reasons: [], detail: '' };
  const text = p.state === 'processing' ? '打印中' : READY_STATE_TEXT[ready.state] || ready.state;
  const color = ready.state === 'ready' ? '#0a0' : ready.state === 'unknown' ? '#666' : '#a00';
  return (
    <span>
      <b style={{ color }}>● {text}</b>
      {p.accepting ? '' : <span style={{ color: '#a00' }}> · 拒收新任务</span>}
      {ready.reasons.length ? <span style={{ color: '#666' }}>（{ready.reasons.join('、')}）</span> : null}
      {ready.detail ? <span style={{ color: '#666' }}>{' · '}{ready.detail}</span> : null}
      <span style={{ color: '#666' }}>{' · 队列 '}{p.queuedJobCount ?? 0}</span>
    </span>
  );
}

/** 顶部汇总：数量 / 链路 / 异常 / 采集方式与新鲜度（探测降级时标黄） */
function PrinterSummary({ state }: { state: PrinterState }) {
  const total = state.printers.length;
  const linked = state.printers.filter((p) =>
    p.transport === 'usb' ? p.link?.state === 'connected' : p.link?.state !== 'disconnected'
  ).length;
  const issues = state.printers.filter((p) => ['offline', 'error', 'paused'].includes(p.ready?.state || '')).length;
  const probe = state.probe;
  const age = state.collectedAt ? Math.max(0, Math.round((Date.now() - state.collectedAt) / 1000)) : null;
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, fontSize: 11, color: '#666' }}>
      <span>{total} 台打印机</span>
      <span>· {linked} 已连接</span>
      <span style={{ color: issues ? '#a00' : '#666' }}>· {issues} 异常</span>
      {probe && probe.method !== 'none' ? <span>· 采集 {probe.method} {probe.durationMs}ms</span> : null}
      {age !== null ? <span>· {age} 秒前</span> : null}
      {probe?.degraded ? (
        <span style={{ color: '#a60' }}>· ⚠ 探测降级{probe.error ? `：${probe.error}` : ''}</span>
      ) : null}
    </div>
  );
}

/** 测试页操作结果（按打印机名关联，成功/失败都就地展示在对应行） */
interface TestPageResult {
  printer: string;
  ok: boolean;
  text: string;
}

/** 打印机状态区（单台或多台逐行展示），每台附「打印测试页」按钮，暂停时附「恢复打印」 */
function PrinterList({
  state,
  testingName,
  testResult,
  onTestPage,
  onResume,
  busy,
  activeKey,
  feedback,
}: {
  state: PrinterState | null;
  testingName: string;
  testResult: TestPageResult | null;
  onTestPage: (name: string) => void;
  onResume: (name: string) => void;
  busy: boolean;
  activeKey: string | null;
  feedback: ActionFeedback | null;
}) {
  if (!state) return <p className="sp-dim">Loading…</p>;
  if (!state.available) return <p className="sp-dim">{state.error || 'CUPS unavailable'}</p>;
  if (state.printers.length === 0) return <p className="sp-dim">未发现打印机</p>;
  return (
    <div style={{ padding: '8px 12px', display: 'grid', gap: 8, fontSize: 12 }}>
      <PrinterSummary state={state} />
      {state.printers.map((p) => {
        // 已停止（cupsdisable）或拒收新任务（cupsreject）都视为暂停，提供一键恢复
        const paused = p.state === 'stopped' || !p.accepting;
        // USB 链路确认断开时不能打印；探测 unknown 不阻止操作（可能只是探测手段不可用）
        const linkDown = p.transport === 'usb' && p.link?.state === 'disconnected';
        const rk = resumeKey(p.name);
        return (
          <div key={p.name}>
            <div>
              <b>{p.name}</b>
              <span style={{ color: '#666' }}>{p.model ? ` · ${p.model}` : ''}</span>
            </div>
            <div>链路：{linkStatus(p)}</div>
            <div>就绪：{readyStatus(p)}</div>
            <div style={{ color: '#666', fontSize: 11, wordBreak: 'break-all' }}>{p.deviceUri}</div>
            <div style={{ marginTop: 2, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <ClassicyButton
                buttonSize="small"
                disabled={!!testingName || !p.accepting || linkDown}
                title={linkDown ? 'USB 未连接，无法打印' : undefined}
                onClickFunc={() => onTestPage(p.name)}
              >
                {testingName === p.name ? '正在提交…' : '打印测试页'}
              </ClassicyButton>
              {paused && (
                <ClassicyButton
                  buttonSize="small"
                  disabled={busy}
                  title="解除「已停止」并恢复接收新任务"
                  onClickFunc={() => onResume(p.name)}
                >
                  {activeKey === rk ? '恢复中…' : '恢复打印'}
                </ClassicyButton>
              )}
              {testResult && testResult.printer === p.name && (
                <span style={{ color: testResult.ok ? '#070' : '#a00', wordBreak: 'break-all' }}>
                  {testResult.text}
                </span>
              )}
            </div>
            {feedback && feedback.key === rk && (
              <div
                className={feedback.ok ? 'sp-printer-ok' : 'sp-printer-err'}
                style={{ marginTop: 2, fontSize: 11, wordBreak: 'break-all' }}
              >
                {feedback.text}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** 队列任务操作列：暂停/恢复 + 取消 + 删除，结果就地反馈在单元格内 */
function JobActions({
  job,
  busy,
  activeKey,
  feedback,
  onAction,
}: {
  job: PrinterJob;
  busy: boolean;
  activeKey: string | null;
  feedback: ActionFeedback | null;
  onAction: (j: PrinterJob, action: PrinterJobAction) => void;
}) {
  const key = jobKey(job);
  const held = job.state === 'pending-held' || job.state === 'processing-stopped';
  const toggle: PrinterJobAction = held ? 'resume' : 'hold';
  return (
    <div className="sp-printer-job-actions">
      <ClassicyButton
        buttonSize="small"
        disabled={busy}
        title={held ? '解除挂起，重新加入队列' : '挂起任务，暂停打印'}
        onClickFunc={() => onAction(job, toggle)}
      >
        {held ? '恢复' : '暂停'}
      </ClassicyButton>
      <ClassicyButton
        buttonSize="small"
        disabled={busy}
        title="中止任务（保留在打印历史中）"
        onClickFunc={() => onAction(job, 'cancel')}
      >
        取消
      </ClassicyButton>
      <ClassicyButton
        buttonSize="small"
        disabled={busy}
        title="中止任务并删除作业数据文件（不留历史记录）"
        onClickFunc={() => onAction(job, 'delete')}
      >
        删除
      </ClassicyButton>
      {activeKey === key && <span className="sp-printer-job-feedback">处理中…</span>}
      {feedback && feedback.key === key && (
        <span
          className={`sp-printer-job-feedback ${feedback.ok ? 'sp-printer-ok' : 'sp-printer-err'}`}
          title={feedback.text}
        >
          {feedback.text}
        </span>
      )}
    </div>
  );
}

function JobTable({
  jobs,
  showCompletedAt,
  busy,
  activeKey,
  feedback,
  onAction,
}: {
  jobs: PrinterJob[];
  showCompletedAt: boolean;
  busy?: boolean;
  activeKey?: string | null;
  feedback?: ActionFeedback | null;
  onAction?: (j: PrinterJob, action: PrinterJobAction) => void;
}) {
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
      ...(onAction
        ? [
            {
              id: 'actions',
              title: '操作',
              accessor: () => '',
              width: 160,
              sortable: false,
              render: (j) => (
                <JobActions
                  job={j}
                  busy={!!busy}
                  activeKey={activeKey ?? null}
                  feedback={feedback ?? null}
                  onAction={onAction}
                />
              ),
            } as ClassicyTableColumn<PrinterJob>,
          ]
        : []),
    ],
    [showCompletedAt, onAction, busy, activeKey, feedback]
  );

  if (jobs.length === 0) {
    return <p className="sp-dim" style={{ padding: '4px 12px' }}>{showCompletedAt ? '暂无打印历史' : '队列为空'}</p>;
  }
  return <ClassicyTable columns={columns} rows={jobs} getRowId={(j) => `${j.printer}-${j.id}`} />;
}

/** 应用：CUPS 打印机状态 / 打印队列 / 打印历史 */
export function PrinterApp({ onLogout }: { onLogout?: () => void }) {
  // 仅在本应用启动期间轮询 /api/printer：未启动 / Quit 后不发请求
  const open = useAppOpen(APP_ID);
  const poll = useSharedPoll(printerPoll, open);
  // 历史单独轮询（60s）：变化慢，没必要跟着 5s 的状态刷新反复传输
  const historyPoll = useSharedPoll(printerHistoryPoll, open);

  /** 正在提交测试页的打印机名（空串 = 空闲）；结果就地展示在对应打印机行 */
  const [testingName, setTestingName] = useState('');
  const [testResult, setTestResult] = useState<TestPageResult | null>(null);

  /** 恢复打印机 / 队列任务操作的通用状态：busyKey 锁住全部按钮，feedback 就地展示结果 */
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<ActionFeedback | null>(null);

  const runAction = useCallback(
    async (key: string, fn: () => Promise<unknown>, okText: string) => {
      setBusyKey(key);
      setFeedback(null);
      try {
        await fn();
        setFeedback({ key, ok: true, text: okText });
        printerPoll.reload(); // CUPS 状态已变，立即刷新队列
        printerHistoryPoll.reload(); // 取消/删除会影响历史，立即刷新
      } catch (e) {
        setFeedback({ key, ok: false, text: e instanceof Error ? e.message : String(e) });
      } finally {
        setBusyKey(null);
      }
    },
    []
  );

  const onResume = useCallback(
    (name: string) => runAction(resumeKey(name), () => resumePrinter(name), '已恢复打印'),
    [runAction]
  );

  const onJobAction = useCallback(
    (j: PrinterJob, action: PrinterJobAction) =>
      runAction(jobKey(j), () => controlPrinterJob(j.printer, j.id, action), JOB_ACTION_OK_TEXT[action]),
    [runAction]
  );

  const onTestPage = async (name: string) => {
    setTestingName(name);
    setTestResult(null);
    try {
      const r = await printTestPage(name);
      setTestResult({ printer: name, ok: true, text: r.jobId ? `测试页已提交（作业 #${r.jobId}）` : '测试页已提交' });
      printerPoll.reload(); // 新作业会出现在队列里，立即
      printerHistoryPoll.reload(); // 新作业也会进入历史
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
  const history = historyPoll.data;
  const busy = busyKey !== null || testingName !== '';

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
        initialSize={[920, 560]}
        initialPosition={['center', 'center']}
        minimumSize={[620, 380]}
        appMenu={appMenu}
      >
        <ClassicyControlGroup label={`Printers (${state?.printers?.length ?? 0})`}>
          <PrinterList
            state={state}
            testingName={testingName}
            testResult={testResult}
            onTestPage={onTestPage}
            onResume={onResume}
            busy={busy}
            activeKey={busyKey}
            feedback={feedback}
          />
        </ClassicyControlGroup>
        <ClassicyControlGroup label={`Queue (${state?.activeJobs?.length ?? 0})`}>
          <JobTable
            jobs={state?.activeJobs ?? []}
            showCompletedAt={false}
            busy={busy}
            activeKey={busyKey}
            feedback={feedback}
            onAction={onJobAction}
          />
        </ClassicyControlGroup>
        <ClassicyControlGroup label={`History (${history?.history?.length ?? 0})`}>
          <JobTable jobs={history?.history ?? []} showCompletedAt />
        </ClassicyControlGroup>
      </ClassicyWindow>
      {aboutWindow}
    </ClassicyApp>
  );
}
