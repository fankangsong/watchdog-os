import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ClassicyAlert,
  ClassicyApp,
  ClassicyButton,
  ClassicyIcons,
  ClassicyTable,
  ClassicyWindow,
  dispatch,
  useClassicyAboutMenu,
  useClassicyEditMenu,
} from 'classicy';
import type { ClassicyTableColumn } from 'classicy';
import {
  deleteChatSession,
  fetchChatSessionMessages,
  fetchChatSessions,
  fetchChatStatus,
  streamChat,
  Unauthorized,
  type ChatMessage,
  type HermesSession,
} from '../api';
import { MarkdownPreview } from '../components/MarkdownPreview';
import { quitMenuItem } from '../quitMenuItem';
// ⚠️ 必须用 ?no-inline（仅 ?url 不够）让 Vite 输出独立文件 URL。
// 原因同 TerminalApp：classicy 桌面图标把图标地址写进 CSS 的
// --classicy-icon-mask: url(...)，而 Vite 内联 SVG 时会把双引号换成单引号，
// 导致 CSS 无引号 url() 非法、自定义属性被浏览器丢弃，遮罩失效。
import chatIcon from '../assets/icons/chat.svg?no-inline';

const APP_ID = 'srv-chat.app';
const APP_NAME = 'Chat';
/** 应用图标：自绘 SVG（Mac OS 9 层叠对话气泡），见 src/assets/icons/chat.svg */
const ICON = chatIcon;

/** 会话流中的一个气泡（UI 状态模型，发送时才映射回 OpenAI ChatMessage） */
interface ChatBubble {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  /** 推理内容（reasoning_content 增量累积），折叠展示 */
  reasoning?: string;
  /** 工具执行进度状态行（流式期间展示，结束清除） */
  tool?: string;
  /** 错误气泡：红字显示 error 信息，不参与下一轮上下文 */
  error?: string;
  /** 本轮工具/中间步骤时间线（按发生顺序），折叠展示 */
  tools?: ToolStep[];
}

type ToolStepStatus = 'running' | 'done' | 'error';

/** 删除确认 / 错误提示弹窗（对齐 FinderApp 的 FmAlert 结构） */
interface ChatAlert {
  alertType: 'caution' | 'stop';
  label: string;
  message?: string;
  buttons: Array<{ id: string; label: string; role?: 'default' | 'cancel' | 'normal'; onClick?: () => void }>;
}

/** 时间线中的一步：hermes 工具进度（tool）/ OpenAI 标准调用（call）/ 未知事件（event） */
interface ToolStep {
  /** 合并键：'tool:<name>' | 'call:<index>' | 'event:<type>' */
  key: string;
  kind: 'tool' | 'call' | 'event';
  name: string;
  status: ToolStepStatus;
  /** 首次出现时间 */
  startedAt: number;
  /** 离开 running 的时间；running 中不显示耗时 */
  endedAt?: number;
  /** 入参 JSON（截断至 2000 字符，容错序列化） */
  args?: string;
  /** 返回结果（hermes 事件里有就存，截断同上） */
  result?: string;
  /** kind='event' 时原始 JSON 兜底展示 */
  detail?: string;
}

function uid(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** hermes.tool.progress 事件的工具名容错提取（含 emoji 前缀与 label 命令，如「💻 terminal · date」） */
function toolName(d: Record<string, unknown>): string {
  const tool = [d.tool, d.name, d.tool_name, d.id].find(
    (v) => typeof v === 'string' && v
  ) as string | undefined;
  const emoji = typeof d.emoji === 'string' && d.emoji ? d.emoji : undefined;
  const label = typeof d.label === 'string' && d.label ? `· ${d.label}` : undefined;
  return [emoji, tool ?? '工具', label].filter(Boolean).join(' ');
}

/** hermes.tool.progress 自定义事件的字段容错提取，拼成状态行文案 */
function toolLabel(d: Record<string, unknown>): string {
  const n = toolName(d);
  return n === '工具' ? '正在执行工具…' : `正在执行工具：${n}…`;
}

/** 详情文本截断上限（防止巨型入参/结果撑爆 localStorage 与渲染） */
const STEP_CLIP = 2000;

function clip(s: string): string {
  return s.length > STEP_CLIP ? s.slice(0, STEP_CLIP) + '…' : s;
}

/** 任意值转可读文本：string 直接用，其余 JSON 序列化（失败兜底 String），统一截断 */
function stringifyClip(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  let s: string;
  if (typeof v === 'string') s = v;
  else {
    try {
      s = JSON.stringify(v);
    } catch {
      s = String(v);
    }
  }
  return s ? clip(s) : undefined;
}

/** 从事件对象按候选键列表容错提取第一个非空值 */
function pickStr(d: Record<string, unknown>, keys: string[]): unknown {
  for (const k of keys) {
    const v = d[k];
    if (typeof v === 'string' && v) return v;
    if (v !== undefined && v !== null && typeof v !== 'string') return v;
  }
  return undefined;
}

/** hermes.tool.progress 状态字段容错判定：error|fail → error；done 类 → done；否则 running */
function stepStatus(d: Record<string, unknown>): ToolStepStatus {
  const raw = [d.status, d.state, d.phase].find((v) => typeof v === 'string') as string | undefined;
  if (!raw) return 'running';
  const s = raw.toLowerCase();
  if (/error|fail/.test(s)) return 'error';
  if (/done|complete|finish|success|ok|end/.test(s)) return 'done';
  return 'running';
}

/**
 * 工具时间线合并：与最后一步 key 相同则原位合并（hermes.tool.progress 无调用 id、
 * 无明确 start/end 事件），否则追加；追加前把仍 running 的末步收口为 done。
 * 只比较数组末尾，保证时间有序且同名连续进度视为同一步骤。
 */
function upsertStep(steps: ToolStep[], incoming: ToolStep): ToolStep[] {
  const last = steps[steps.length - 1];
  if (last && last.key === incoming.key) {
    const merged: ToolStep = { ...last };
    if (incoming.status !== 'running') {
      merged.status = incoming.status;
      merged.endedAt = incoming.endedAt ?? Date.now();
    }
    if (incoming.args !== undefined) merged.args = incoming.args;
    if (incoming.result !== undefined) merged.result = incoming.result;
    if (incoming.detail !== undefined) merged.detail = incoming.detail;
    return [...steps.slice(0, -1), merged];
  }
  const closed =
    last && last.status === 'running'
      ? [...steps.slice(0, -1), { ...last, status: 'done' as const, endedAt: Date.now() }]
      : steps;
  return [...closed, incoming];
}

/** 把 running 中的步骤统一收口（流结束时 done / 出错时 error） */
function closeRunning(steps: ToolStep[], status: 'done' | 'error'): ToolStep[] {
  const now = Date.now();
  return steps.map((s) =>
    s.status === 'running' ? { ...s, status, endedAt: s.endedAt ?? now } : s
  );
}

/** 一次后台流式运行的完整记录（runsRef 注册表的一项） */
interface ChatRun {
  /** 注册表键：sessionId；新会话未关联服务端前为 `tmp:<bubbleId>` 临时键 */
  key: string;
  /** 服务端会话 ID，onSessionId 到达后回填并重映射 key */
  sessionId: string | null;
  userBubble: ChatBubble;
  /** 流式期间持续累积的 AI 气泡快照（content/reasoning/tools/tool/error） */
  aiBubble: ChatBubble;
  controller: AbortController;
  running: boolean;
  /** 等待态起点时间戳（null=正文已到，非等待态） */
  thinkStart: number | null;
  thinkTool: string;
}

/**
 * 切回会话时合并 run 记录与服务端历史：
 * - 运行中：追加本地气泡并保留 run（流式回调继续定点 patch 视图）
 * - 已完成且服务端已含该轮：服务端版本为准，丢弃 run
 * - 已完成但 transcript 写入延迟：先展示本地完整轮次并消费 run，下次切换 refetch 自然对齐
 */
function reconcileRun(
  bubbles: ChatBubble[],
  run: ChatRun | null,
  sessionId: string,
  registry: Map<string, ChatRun>,
  bump: () => void
): ChatBubble[] {
  if (!run) return bubbles;
  const userIdx = bubbles.findIndex(
    (b) => b.role === 'user' && b.content.trim() === run.userBubble.content.trim()
  );
  if (run.running) {
    // user 气泡已被 hermes 写入 transcript 时只追加 AI 气泡，避免重复
    return userIdx >= 0 ? [...bubbles, run.aiBubble] : [...bubbles, run.userBubble, run.aiBubble];
  }
  registry.delete(sessionId);
  bump();
  return userIdx >= 0 ? bubbles : [...bubbles, run.userBubble, run.aiBubble];
}

/** 工具调用时间线：折叠列表，每步显示名称+状态+耗时，可展开入参/结果详情 */
function ToolTimeline({ steps, live }: { steps: ToolStep[]; live: boolean }) {
  const running = steps.some((s) => s.status === 'running');
  return (
    <details className="sp-chat-tools">
      <summary>
        工具调用 · {steps.length}
        {running && live && <span className="sp-chat-tools-live">●</span>}
      </summary>
      <div className="sp-chat-tools-list">
        {steps.map((s, i) => {
          const dur =
            s.status !== 'running' && s.endedAt
              ? `${Math.max(1, Math.round((s.endedAt - s.startedAt) / 100) / 10)}s`
              : undefined;
          return (
            <div key={`${s.key}-${i}`} className={`sp-chat-tools-step ${s.status}`}>
              <span className="sp-chat-tools-step-name">{s.name}</span>
              <span className="sp-chat-tools-step-state">
                {s.status === 'running' ? '运行中…' : s.status === 'error' ? '出错' : dur ?? '完成'}
              </span>
              {(s.args || s.result || s.detail) && (
                <details className="sp-chat-tools-detail">
                  <summary>详情</summary>
                  {s.args && (
                    <>
                      <div className="sp-chat-tools-detail-label">入参</div>
                      <pre>{s.args}</pre>
                    </>
                  )}
                  {s.result && (
                    <>
                      <div className="sp-chat-tools-detail-label">结果</div>
                      <pre>{s.result}</pre>
                    </>
                  )}
                  {s.detail && (
                    <>
                      <div className="sp-chat-tools-detail-label">事件</div>
                      <pre>{s.detail}</pre>
                    </>
                  )}
                </details>
              )}
            </div>
          );
        })}
      </div>
    </details>
  );
}

/**
 * 会话列表窗口的初始位置：主窗口居中，列表窗优先摆其左侧（构成「列表 + 对话」布局）。
 * 视口放不下时逐级降级，任何落点都保证列表窗至少有约 200px 宽度露在主窗口之外——
 * 否则列表窗（440×320）会被更大的主窗口（620×520）完全盖住，看起来就像「没有打开」。
 */
function sessionsWindowPosition(): [number, number] {
  const vw = typeof window !== 'undefined' ? window.innerWidth : 1280;
  const vh = typeof window !== 'undefined' ? window.innerHeight : 800;
  const mainW = 620;
  const mainH = 520;
  const sessW = 440;
  const sessH = 320;
  const EDGE = 8; // 贴视口边缘留白
  const GAP = 16; // 与主窗口的间距
  const MIN_VISIBLE = 200; // 部分重叠时至少露出的宽度
  const mainX = Math.max(0, (vw - mainW) / 2);
  const mainY = Math.max(30, (vh - mainH) / 2);
  // 1) 主窗口左侧完整放下（宽屏首选）
  if (mainX - sessW - GAP >= EDGE) return [Math.round(mainX - sessW - GAP), Math.round(mainY)];
  // 2) 主窗口右侧完整放下
  if (mainX + mainW + GAP + sessW <= vw - EDGE) return [Math.round(mainX + mainW + GAP), Math.round(mainY)];
  // 3) 贴视口左缘、与主窗口顶对齐（左半区可见宽度足够）
  if (mainX - EDGE >= MIN_VISIBLE) return [EDGE, Math.round(mainY)];
  // 4) 贴视口右缘同理
  if (vw - EDGE - (mainX + mainW) >= MIN_VISIBLE) return [Math.round(vw - EDGE - sessW), Math.round(mainY)];
  // 5) 兜底（极窄视口）：主窗口左下层叠，标题栏错开保证两窗都能被看到
  return [EDGE, Math.round(Math.min(mainY + 64, Math.max(30, vh - sessH - EDGE)))];
}

/**
 * 聊天应用：经后端 /api/chat/* 代理调用 Hermes。
 * 发送走 OpenAI 兼容 /api/chat/completions（无状态协议，前端全量重传 messages）；
 * 会话列表/历史以 hermes 服务端 Sessions API 为准（/api/chat/sessions* 代理），
 * 本地不做持久化——currentId=null 表示尚未关联服务端会话的新会话。
 */
export function ChatApp({ onLogout }: { onLogout?: () => void }) {
  const [state, setState] = useState<'loading' | 'ready' | 'unavailable'>('loading');
  const [detail, setDetail] = useState('');
  // 服务端会话（列表窗口数据源）与加载态
  const [serverSessions, setServerSessions] = useState<HermesSession[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [sessionsError, setSessionsError] = useState<string | null>(null);
  // 当前会话：null = 未关联服务端的新会话（首次发送后从响应头 X-Hermes-Session-Id 关联）
  const [currentId, setCurrentId] = useState<string | null>(null);
  // 当前会话的消息视图（发送后流式更新；切换会话时从服务端拉取整体替换）
  const [messages, setMessages] = useState<ChatBubble[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [alert, setAlert] = useState<ChatAlert | null>(null);
  const [input, setInput] = useState('');
  // 后台流式运行注册表：key 为 sessionId（新会话未关联前为 `tmp:<bubbleId>` 临时键）。
  // 流式增量永远写入 run 快照；仅当该会话正被查看时才同步写 messages 视图——
  // 切换会话因此不中断流（不再 abort），切回时由 reconcileRun 合并恢复。
  const runsRef = useRef(new Map<string, ChatRun>());
  const [runsVersion, setRunsVersion] = useState(0);
  const bumpRuns = useCallback(() => setRunsVersion((v) => v + 1), []);
  // currentId 镜像：流式回调据此判断「run 所属会话是否正被查看」（避免闭包读到旧 state）
  const currentIdRef = useRef<string | null>(null);
  const applyCurrentId = useCallback((id: string | null) => {
    currentIdRef.current = id;
    setCurrentId(id);
  }, []);
  // 新会话（currentId=null）视图跟随的临时 run key（send 时设置；切换/认领时更新或清空）
  const [viewRunKey, setViewRunKey] = useState<string | null>(null);
  const viewRunKeyRef = useRef<string | null>(null);
  const applyViewRunKey = useCallback((key: string | null) => {
    viewRunKeyRef.current = key;
    setViewRunKey(key);
  }, []);
  // 历史加载竞态序号：快速连续切换会话时丢弃过期响应
  const loadSeqRef = useRef(0);
  // 等待态秒表显示值（等待起点存于 run.thinkStart，这里只存每秒 tick）
  const [thinkSec, setThinkSec] = useState(0);

  // 当前查看会话对应的运行记录（currentId 优先，未关联会话回退临时键）
  const currentRun = useMemo(() => {
    void runsVersion; // run 注册/结束/删除时 bump，驱动此处重算
    const key = currentId ?? viewRunKey;
    return key ? (runsRef.current.get(key) ?? null) : null;
  }, [currentId, viewRunKey, runsVersion]);

  // 视图实时状态全部派生自 currentRun：切走会话天然复位，切回运行中会话天然恢复
  const streaming = currentRun?.running ?? false;
  const activeAiId = currentRun?.aiBubble.id ?? null;
  const thinkStart = currentRun?.thinkStart ?? null;
  const thinkTool = currentRun?.thinkTool ?? '';

  const { aboutMenuItem, aboutWindow } = useClassicyAboutMenu(APP_ID, APP_NAME, ICON);
  // 消息输入为标准 textarea，编辑命令由 classicy 作用于最后聚焦的文本框
  const editMenuItem = useClassicyEditMenu('chat');
  // 会话列表窗口初始位置（挂载时算一次；窗口注册后位置由用户拖动接管）
  const sessionsPos = useMemo(sessionsWindowPosition, []);

  // 自动滚动：用户上滚（离底超过阈值）时暂停拉底，回到底部附近自动恢复
  const listRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);

  const handleLogout = useCallback(() => onLogout?.(), [onLogout]);

  const loadStatus = useCallback(async () => {
    setState('loading');
    try {
      const s = await fetchChatStatus();
      if (s.enabled) {
        setState('ready');
        setDetail('');
      } else {
        setState('unavailable');
        setDetail('服务端未启用 hermes 聊天代理');
      }
    } catch (e) {
      if (e instanceof Unauthorized) {
        handleLogout();
        return;
      }
      setState('unavailable');
      setDetail(e instanceof Error ? e.message : String(e));
    }
  }, [handleLogout]);

  useEffect(() => {
    loadStatus();
  }, [loadStatus]);

  // 旧版本地会话存储（单会话 key / 多会话索引与消息体）已废弃，挂载时一次性清理
  useEffect(() => {
    try {
      localStorage.removeItem('watchdog-chat-history');
      localStorage.removeItem('watchdog-chat-sessions');
      const kill: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k?.startsWith('watchdog-chat-session:')) kill.push(k);
      }
      kill.forEach((k) => localStorage.removeItem(k));
    } catch {
      // 隐私模式等场景忽略
    }
  }, []);

  // 新气泡出现 / 流式增量时，若用户仍贴底则自动滚到底
  useEffect(() => {
    const el = listRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  // 等待态秒表：每秒刷新「已用 Ns」；等待态结束或组件卸载时清理定时器
  useEffect(() => {
    if (thinkStart === null) return;
    const tick = () => setThinkSec(Math.floor((Date.now() - thinkStart) / 1000));
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [thinkStart]);

  const onListScroll = useCallback(() => {
    const el = listRef.current;
    if (!el) return;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  }, []);

  /** 拉取服务端会话列表（打开窗口 / Refresh / 新会话首次发送后静默刷新共用）；silent 时不闪 Loading */
  const loadSessions = useCallback(async (silent = false) => {
    if (!silent) setSessionsLoading(true);
    setSessionsError(null);
    try {
      setServerSessions(await fetchChatSessions(50));
    } catch (e) {
      if (e instanceof Unauthorized) {
        handleLogout();
        return;
      }
      setSessionsError(e instanceof Error ? e.message : String(e));
    } finally {
      setSessionsLoading(false);
    }
  }, [handleLogout]);

  // 就绪后自动拉取一次会话列表：sessions 窗口常驻渲染树，app 打开时 classicy 会把所有
  // 已注册窗口置为可见（见 AGENTS.md 注意事项 11），首屏即能看到列表窗——若不主动加载，
  // 窗口会一直停在「No sessions」空态，直到用户从菜单重开才触发 loadSessions。
  useEffect(() => {
    if (state === 'ready') void loadSessions();
  }, [state, loadSessions]);

  const send = useCallback(async () => {
    const text = input.trim();
    // 仅「当前查看会话已有运行中的流」时禁止重复发送；其他会话的后台流不受影响（并行收发）
    const viewKey = currentId ?? viewRunKey;
    if (!text || historyLoading || state !== 'ready') return;
    if (viewKey && runsRef.current.get(viewKey)?.running) return;

    // 组装 API 消息：错误气泡与空回复不进入上下文
    const apiMessages: ChatMessage[] = [
      ...messages
        .filter((b) => !b.error && b.content)
        .map((b) => ({ role: b.role, content: b.content }) as ChatMessage),
      { role: 'user', content: text },
    ];
    const userBubble: ChatBubble = { id: uid(), role: 'user', content: text };
    const aiBubble: ChatBubble = { id: uid(), role: 'assistant', content: '' };

    setMessages((prev) => [...prev, userBubble, aiBubble]);
    setInput('');

    // 注册后台运行：新会话（未关联）用临时键，onSessionId 到达后重映射到真实 sessionId
    const ac = new AbortController();
    const isTemp = currentId === null;
    const key = isTemp ? `tmp:${aiBubble.id}` : currentId;
    const run: ChatRun = {
      key,
      sessionId: isTemp ? null : currentId,
      userBubble,
      aiBubble,
      controller: ac,
      running: true,
      // 进入等待态：显示「思考中 · 已用 Ns」直到首条正文到达
      thinkStart: Date.now(),
      thinkTool: '',
    };
    runsRef.current.set(key, run);
    if (isTemp) applyViewRunKey(key);
    bumpRuns();

    // 双写：增量永远累积进 run 快照；仅当该会话正被查看时才同步进 messages 视图
    const aiId = aiBubble.id;
    const isLive = () => (currentIdRef.current ?? viewRunKeyRef.current) === run.key;
    const commit = (patch: Partial<ChatBubble>) => {
      run.aiBubble = { ...run.aiBubble, ...patch };
      if (isLive()) setMessages((prev) => prev.map((b) => (b.id === aiId ? { ...b, ...patch } : b)));
    };

    // 本轮工具时间线（闭包累积，经 commit 写回气泡与 run 快照）
    let tools: ToolStep[] = [];

    await streamChat({
      messages: apiMessages,
      signal: ac.signal,
      // 已关联服务端会话则带上会话头，让 hermes 记入同一 transcript
      sessionId: run.sessionId ?? undefined,
      // 首次发送：从响应头关联服务端会话；重映射注册表键。用户仍停留在发起视图
      // 时才认领 currentId 并刷新列表，否则只静默重映射（不劫持已切换的会话）
      onSessionId: (sid) => {
        if (run.sessionId === sid) return;
        const followed = viewRunKeyRef.current === run.key;
        runsRef.current.delete(run.key);
        run.key = sid;
        run.sessionId = sid;
        runsRef.current.set(sid, run);
        if (followed) {
          applyViewRunKey(sid);
          applyCurrentId(sid);
          void loadSessions(true);
        }
        bumpRuns();
      },
      onDelta: (t) => {
        // 首条正文到达即结束等待态，后续 tool.progress 回退到气泡内小状态行
        if (run.thinkStart !== null) {
          run.thinkStart = null;
          run.thinkTool = '';
        }
        commit({ content: run.aiBubble.content + t });
      },
      onReasoning: (t) => commit({ reasoning: (run.aiBubble.reasoning ?? '') + t }),
      onToolProgress: (d) => {
        const label = toolLabel(d);
        // 等待期（尚无正文）的工具进度提升到「思考中」块内展示
        if (run.thinkStart !== null) run.thinkTool = label;
        // 并入时间线：真实协议经 SSE event: 行传输，data 含 toolCallId（同一调用的 running/completed 帧靠它合并）
        const status = stepStatus(d);
        const id = typeof d.toolCallId === 'string' && d.toolCallId ? d.toolCallId : undefined;
        const name = toolName(d);
        tools = upsertStep(tools, {
          key: `tool:${id ?? name}`,
          kind: 'tool',
          name,
          status,
          startedAt: Date.now(),
          endedAt: status !== 'running' ? Date.now() : undefined,
          args: stringifyClip(pickStr(d, ['args', 'arguments', 'input', 'params'])),
          result: stringifyClip(pickStr(d, ['result', 'output', 'response', 'message'])),
        });
        commit({ tool: label, tools: [...tools] });
      },
      onToolCall: (calls) => {
        const now = Date.now();
        for (const c of calls) {
          tools = upsertStep(tools, {
            key: `call:${c.index}`,
            kind: 'call',
            name: c.name ?? c.id ?? `调用 #${c.index}`,
            status: 'running',
            startedAt: now,
            args: c.arguments || undefined,
          });
        }
        commit({ tools: [...tools] });
      },
      onEvent: (d, evName) => {
        // 未知自定义事件兜底进时间线：类型优先取 data.type，回退到 SSE event: 行声明的 evName；
        // 标准 OpenAI chunk 两者皆无，天然过滤
        const t = typeof d.type === 'string' ? d.type : evName;
        if (typeof t !== 'string' || t === 'hermes.tool.progress') return;
        const status = stepStatus(d);
        tools = upsertStep(tools, {
          key: `event:${t}`,
          kind: 'event',
          name: t,
          status,
          startedAt: Date.now(),
          endedAt: status !== 'running' ? Date.now() : undefined,
          args: stringifyClip(pickStr(d, ['args', 'arguments', 'input', 'params'])),
          result: stringifyClip(pickStr(d, ['result', 'output', 'response', 'message'])),
          detail: stringifyClip(d),
        });
        commit({ tools: [...tools] });
      },
      onDone: () => {
        tools = closeRunning(tools, 'done');
        commit({ tool: undefined, tools: [...tools] });
        run.running = false;
        // 查看中：视图已是最终态，直接消费 run；后台结束的 run 保留，待切回时 reconcileRun 对齐服务端
        if (isLive()) runsRef.current.delete(run.key);
        bumpRuns();
        void loadSessions(true); // 静默刷新列表的 updatedAt / messageCount
      },
      onError: (e) => {
        tools = closeRunning(tools, 'error');
        commit({ tool: undefined, error: e.message, tools: [...tools] });
        run.running = false;
        if (isLive()) runsRef.current.delete(run.key);
        bumpRuns();
        void loadSessions(true);
      },
    });
  }, [input, messages, historyLoading, currentId, viewRunKey, state, loadSessions, applyCurrentId, applyViewRunKey, bumpRuns]);

  /** 停止按钮：只中止当前查看会话的运行；其他会话的后台流不受影响 */
  const stop = useCallback(() => {
    const k = currentIdRef.current ?? viewRunKeyRef.current;
    const r = k ? runsRef.current.get(k) : undefined;
    if (r?.running) r.controller.abort(); // AbortError 由 api 层转为 onDone 正常收尾
  }, []);

  /**
   * 切换会话：不中断后台流（运行中的 run 继续接收 SSE，hermes transcript 完整）；
   * 拉取服务端历史替换视图，有 run 记录时经 reconcileRun 合并（服务端为准 + 本地实时气泡）。
   */
  const switchSession = useCallback(
    async (id: string) => {
      if (id === currentIdRef.current) return;
      applyViewRunKey(null); // 未关联会话的临时视图跟随结束（后台 run 不受影响）
      const seq = ++loadSeqRef.current;
      applyCurrentId(id);
      setMessages([]);
      setHistoryLoading(true);
      setInput('');
      stickRef.current = true;
      const run = runsRef.current.get(id) ?? null;
      try {
        const bubbles = (await fetchChatSessionMessages(id)).map<ChatBubble>((b) => ({ ...b, id: uid() }));
        if (loadSeqRef.current !== seq) return; // 已被更新的切换覆盖
        setMessages(reconcileRun(bubbles, run, id, runsRef.current, bumpRuns));
      } catch (e) {
        if (loadSeqRef.current !== seq) return;
        if (e instanceof Unauthorized) {
          handleLogout();
          return;
        }
        setAlert({
          alertType: 'stop',
          label: 'Load failed',
          message: e instanceof Error ? e.message : String(e),
          buttons: [{ id: 'ok', label: 'OK', role: 'default' }],
        });
        applyCurrentId(null); // 会话可能已被删除等 → 回到空会话
      } finally {
        if (loadSeqRef.current === seq) setHistoryLoading(false);
      }
    },
    [applyCurrentId, applyViewRunKey, bumpRuns, handleLogout]
  );

  /** 新会话：只切换视图，不中断后台运行（原会话的流继续接收，完成后可从列表切回） */
  const newSession = useCallback(() => {
    applyCurrentId(null);
    applyViewRunKey(null);
    setMessages([]);
    setInput('');
    stickRef.current = true;
  }, [applyCurrentId, applyViewRunKey]);

  /** 打开会话列表窗口：Open + Focus 双发，保证重开已关闭窗口时置顶聚焦；每次打开都刷新列表 */
  const openSessionList = useCallback(() => {
    dispatch({
      type: 'ClassicyWindowOpen',
      app: { id: APP_ID },
      window: { id: 'chat-sessions', minimumSize: [320, 220], size: [440, 320], position: sessionsPos },
    });
    dispatch({
      type: 'ClassicyWindowFocus',
      app: { id: APP_ID },
      window: { id: 'chat-sessions' },
    });
    void loadSessions();
  }, [loadSessions, sessionsPos]);

  /** 确认后删除服务端会话；该会话有运行中的流则一并中止；删除当前会话时回到空会话 */
  const doDelete = useCallback(
    async (s: HermesSession) => {
      try {
        await deleteChatSession(s.id);
        setServerSessions((prev) => prev.filter((x) => x.id !== s.id));
        const run = runsRef.current.get(s.id);
        if (run) {
          if (run.running) run.controller.abort();
          runsRef.current.delete(s.id);
          bumpRuns();
        }
        if (s.id === currentIdRef.current) {
          applyCurrentId(null);
          setMessages([]);
        }
      } catch (e) {
        if (e instanceof Unauthorized) {
          handleLogout();
          return;
        }
        setAlert({
          alertType: 'stop',
          label: 'Delete failed',
          message: e instanceof Error ? e.message : String(e),
          buttons: [{ id: 'ok', label: 'OK', role: 'default' }],
        });
      }
    },
    [applyCurrentId, bumpRuns, handleLogout]
  );

  /** 行内删除图标：弹确认框（确认后 doDelete） */
  const requestDelete = useCallback(
    (s: HermesSession) => {
      setAlert({
        alertType: 'caution',
        label: `Delete “${s.title}”?`,
        message: 'The conversation history on the server will be permanently deleted. This cannot be undone.',
        buttons: [
          { id: 'cancel', label: 'Cancel', role: 'cancel' },
          { id: 'ok', label: 'Delete', role: 'default', onClick: () => void doDelete(s) },
        ],
      });
    },
    [doDelete]
  );

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter 发送、Shift+Enter 换行；IME 组合中的 Enter（候选确认）不触发发送
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    }
  };

  // 有流式运行中的会话集合（驱动列表「运行中」图标；runsVersion 变化时重算）
  const runningIds = useMemo(() => {
    const s = new Set<string>();
    runsRef.current.forEach((r) => {
      if (r.running && r.sessionId) s.add(r.sessionId);
    });
    return s;
  }, [runsVersion]);

  // 会话列表列定义；Title 列带「运行中」脉冲圆点，末列为行内删除图标（点击不触发行选中）
  const sessionColumns = useMemo<ClassicyTableColumn<HermesSession>[]>(
    () => [
      {
        id: 'title',
        title: 'Title',
        accessor: (s) => s.title,
        render: (s) => (
          <span className="sp-chat-session-title">
            {runningIds.has(s.id) && <span className="sp-chat-run-dot" />}
            {s.title}
          </span>
        ),
      },
      {
        id: 'count',
        title: 'Messages',
        accessor: (s) => s.messageCount ?? Number.NaN,
        width: 72,
        align: 'right',
        render: (s) => (s.messageCount == null ? '' : String(s.messageCount)),
      },
      {
        id: 'updated',
        title: 'Updated',
        accessor: (s) => s.updatedAt,
        width: 120,
        render: (s) => (s.updatedAt > 0 ? new Date(s.updatedAt).toLocaleString() : ''),
      },
      {
        id: 'actions',
        title: '',
        accessor: () => '',
        width: 40,
        sortable: false,
        resizable: false,
        render: (s) => (
          <button
            type="button"
            className="sp-chat-session-del"
            title="Delete session"
            onClick={(e) => {
              e.stopPropagation(); // 不触发行选中/切换
              requestDelete(s);
            }}
          >
            <img src={ClassicyIcons.system.desktop.trashEmpty} alt="" />
          </button>
        ),
      },
    ],
    [requestDelete, runningIds]
  );

  const appMenu = useMemo(
    () => [
      {
        id: 'chat-menu',
        title: APP_NAME,
        menuChildren: [
          aboutMenuItem,
          { id: 'spacer' },
          quitMenuItem(APP_ID, APP_NAME, ICON),
        ],
      },
      editMenuItem,
      {
        id: 'chat-session',
        title: 'Session',
        menuChildren: [
          { id: 'chat-m-list', title: 'Session List…', onClickFunc: openSessionList },
          { id: 'chat-m-refresh', title: 'Refresh Sessions', onClickFunc: () => void loadSessions() },
          { id: 'chat-m-new', title: 'New Session', onClickFunc: newSession },
        ],
      },
    ],
    [aboutMenuItem, editMenuItem, newSession, openSessionList, loadSessions]
  );

  return (
    <ClassicyApp id={APP_ID} name={APP_NAME} icon={ICON} defaultWindow="chat-main">
      {/* 会话列表窗口：常驻渲染树（内容由 serverSessions/currentId 驱动），Open/Focus 控制显隐；
          复用主 appMenu，聚焦列表窗口时菜单栏同样可用（Refresh Sessions 等）。
          ⚠️ 必须放在主窗口之前：classicy 按挂载顺序注册窗口且「后注册者获得焦点」，
          主窗口最后注册即持有启动焦点（与 defaultWindow 一致），列表窗不会抢焦点。 */}
      <ClassicyWindow
        id="chat-sessions"
        title="Sessions"
        icon={ICON}
        appId={APP_ID}
        resizable
        closable
        initialSize={[440, 320]}
        initialPosition={sessionsPos}
        minimumSize={[320, 220]}
        appMenu={appMenu}
      >
        {sessionsLoading ? (
          <div className="sp-chat-sessions-empty">Loading sessions…</div>
        ) : sessionsError ? (
          <div className="sp-chat-sessions-empty">
            <div>
              {sessionsError}
              <br />
              <ClassicyButton buttonSize="small" onClickFunc={() => void loadSessions()}>
                Retry
              </ClassicyButton>
            </div>
          </div>
        ) : serverSessions.length === 0 ? (
          <div className="sp-chat-sessions-empty">No sessions on the server yet.</div>
        ) : (
          <div className="sp-chat-sessions">
            <ClassicyTable
              columns={sessionColumns}
              rows={serverSessions}
              getRowId={(s) => s.id}
              selectionMode="single"
              selected={currentId ? [currentId] : []}
              onSelectionChange={(ids) => {
                if (ids[0]) void switchSession(ids[0]);
              }}
              onActivateRow={(id) => {
                void switchSession(id);
                dispatch({ type: 'ClassicyWindowClose', app: { id: APP_ID }, window: { id: 'chat-sessions' } });
              }}
              defaultSort={{ columnId: 'updated', desc: true }}
            />
          </div>
        )}
      </ClassicyWindow>
      <ClassicyWindow
        id="chat-main"
        title={APP_NAME}
        icon={ICON}
        appId={APP_ID}
        resizable
        zoomable
        collapsable
        closable
        initialSize={[620, 520]}
        initialPosition={['center', 'center']}
        minimumSize={[420, 340]}
        appMenu={appMenu}
      >
        {state !== 'ready' ? (
          // 未启用 / 不可达：窗口内提示，不渲染会话与输入区（对齐 TerminalApp 处理模式）
          <div className="sp-chat-disabled">
            {state === 'loading' ? '正在连接 Hermes…' : 'Hermes 未启用或不可达'}
            {state === 'unavailable' && (
              <>
                <div className="sp-chat-disabled-tip">
                  {detail}
                  <br />
                  请确认服务端 .env 已启用聊天代理（HERMES_ENABLED=true）后重试。
                </div>
                <ClassicyButton buttonSize="small" onClickFunc={loadStatus}>
                  重试
                </ClassicyButton>
              </>
            )}
          </div>
        ) : (
          <div className="sp-chat">
            <div className="sp-chat-list" ref={listRef} onScroll={onListScroll}>
              {historyLoading ? (
                <div className="sp-chat-empty">Loading conversation…</div>
              ) : (
                messages.length === 0 && <div className="sp-chat-empty">开始与 Hermes 对话吧。</div>
              )}
              {messages.map((b) => (
                <div key={b.id} className={`sp-chat-row ${b.role}`}>
                  <div className={`sp-chat-bubble ${b.role}${b.error ? ' error' : ''}`}>
                    {b.tool && <div className="sp-chat-tool">{b.tool}</div>}
                    {b.reasoning && (
                      <details className="sp-chat-reasoning">
                        <summary>推理过程</summary>
                        <div className="sp-chat-reasoning-body">{b.reasoning}</div>
                      </details>
                    )}
                    {b.tools && b.tools.length > 0 && (
                      <ToolTimeline steps={b.tools} live={streaming && b.id === activeAiId} />
                    )}
                    {b.error ? (
                      <div className="sp-chat-err">发送失败：{b.error}</div>
                    ) : b.role === 'user' ? (
                      <div className="sp-chat-user-text">{b.content}</div>
                    ) : b.content ? (
                      <MarkdownPreview source={b.content} />
                    ) : b.id === activeAiId && thinkStart !== null ? (
                      // 等待状态块：请求已发出但尚无可见正文
                      <div className="sp-chat-thinking">
                        <div className="sp-chat-thinking-title">
                          思考中 · 已用 {thinkSec}s
                          <span className="sp-chat-thinking-caret">▌</span>
                        </div>
                        {thinkTool && <div className="sp-chat-thinking-tool">{thinkTool}</div>}
                      </div>
                    ) : (
                      // 流式光标仅属于当前运行中的 AI 气泡：历史中断轮次留下的空气泡不显示
                      streaming && b.id === activeAiId && <span className="sp-chat-cursor">▌</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
            <div className="sp-chat-input">
              <textarea
                className="sp-chat-textarea"
                value={input}
                placeholder={streaming ? '回复中…' : '输入消息，Enter 发送，Shift+Enter 换行'}
                disabled={streaming || historyLoading}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={onKeyDown}
              />
              {streaming ? (
                <ClassicyButton buttonSize="small" onClickFunc={stop}>
                  ■ 停止
                </ClassicyButton>
              ) : (
                <ClassicyButton buttonSize="small" isDefault disabled={!input.trim() || historyLoading} onClickFunc={send}>
                  发送
                </ClassicyButton>
              )}
            </div>
          </div>
        )}
      </ClassicyWindow>
      {alert && (
        <ClassicyAlert
          appId={APP_ID}
          alertType={alert.alertType}
          label={alert.label}
          message={alert.message}
          buttons={alert.buttons}
          onClose={() => setAlert(null)}
        />
      )}
      {aboutWindow}
    </ClassicyApp>
  );
}
