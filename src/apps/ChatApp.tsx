import { useCallback, useEffect, useRef, useState } from 'react';
import { ClassicyApp, ClassicyButton, ClassicyIcons, ClassicyWindow } from 'classicy';
import {
  fetchChatStatus,
  streamChat,
  Unauthorized,
  type ChatMessage,
} from '../api';
import { MarkdownPreview } from '../components/MarkdownPreview';
import { quitMenuItem } from '../quitMenuItem';

const APP_ID = 'srv-chat.app';
const APP_NAME = 'Chat';
const ICON = ClassicyIcons.applications.pager.app;
const HISTORY_KEY = 'watchdog-chat-history';
const HISTORY_MAX = 200; // 本地历史最多保留的气泡数

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
}

function uid(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** 从 localStorage 恢复历史会话（损坏时静默清空） */
function loadHistory(): ChatBubble[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw) as ChatBubble[];
    return Array.isArray(arr) ? arr.filter((b) => b && (b.role === 'user' || b.role === 'assistant')) : [];
  } catch {
    return [];
  }
}

/** hermes.tool.progress 自定义事件的字段容错提取，拼成状态行文案 */
function toolLabel(d: Record<string, unknown>): string {
  const label = [d.tool, d.name, d.tool_name, d.id].find(
    (v) => typeof v === 'string' && v
  ) as string | undefined;
  return label ? `正在执行工具：${label}…` : '正在执行工具…';
}

/**
 * 聊天应用：经后端 /api/chat/* 代理调用 Hermes（OpenAI 兼容协议）。
 * 多轮对话由前端维护 messages 全量重传（无状态协议）；历史持久化在 localStorage。
 */
export function ChatApp({ onLogout }: { onLogout?: () => void }) {
  const [state, setState] = useState<'loading' | 'ready' | 'unavailable'>('loading');
  const [detail, setDetail] = useState('');
  const [messages, setMessages] = useState<ChatBubble[]>(loadHistory);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

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

  // 历史持久化：会话变化即写 localStorage（超上限裁剪旧气泡）
  useEffect(() => {
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(messages.slice(-HISTORY_MAX)));
    } catch {
      // 存储失败（如隐私模式）不影响会话使用
    }
  }, [messages]);

  // 新气泡出现 / 流式增量时，若用户仍贴底则自动滚到底
  useEffect(() => {
    const el = listRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const onListScroll = useCallback(() => {
    const el = listRef.current;
    if (!el) return;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  }, []);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || streaming || state !== 'ready') return;

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
    setStreaming(true);
    const ac = new AbortController();
    abortRef.current = ac;

    const update = (patch: Partial<ChatBubble>) =>
      setMessages((prev) => prev.map((b) => (b.id === aiBubble.id ? { ...b, ...patch } : b)));

    await streamChat({
      messages: apiMessages,
      signal: ac.signal,
      onDelta: (t) =>
        setMessages((prev) =>
          prev.map((b) => (b.id === aiBubble.id ? { ...b, content: b.content + t } : b))
        ),
      onReasoning: (t) =>
        setMessages((prev) =>
          prev.map((b) => (b.id === aiBubble.id ? { ...b, reasoning: (b.reasoning ?? '') + t } : b))
        ),
      onToolProgress: (d) => update({ tool: toolLabel(d) }),
      onDone: () => update({ tool: undefined }),
      onError: (e) => update({ tool: undefined, error: e.message }),
    });
    setStreaming(false);
    abortRef.current = null;
  }, [input, messages, streaming, state]);

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const newSession = useCallback(() => {
    abortRef.current?.abort();
    setMessages([]);
    setInput('');
  }, []);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter 发送、Shift+Enter 换行；IME 组合中的 Enter（候选确认）不触发发送
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    }
  };

  const appMenu = [
    {
      id: 'chat-menu',
      title: APP_NAME,
      menuChildren: [
        { id: 'chat-new', title: '新建会话', onClickFunc: newSession },
        { id: 'chat-sep' },
        quitMenuItem(APP_ID, APP_NAME, ICON),
      ],
    },
    {
      id: 'sys',
      title: 'System',
      menuChildren: [{ id: 'logout', title: 'Sign Out', onClickFunc: handleLogout }],
    },
  ];

  return (
    <ClassicyApp id={APP_ID} name={APP_NAME} icon={ICON} defaultWindow="chat-main">
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
                  请确认服务端 config.json 已启用聊天代理后重试。
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
              {messages.length === 0 && (
                <div className="sp-chat-empty">开始与 Hermes 对话吧。</div>
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
                    {b.error ? (
                      <div className="sp-chat-err">发送失败：{b.error}</div>
                    ) : b.role === 'user' ? (
                      <div className="sp-chat-user-text">{b.content}</div>
                    ) : b.content ? (
                      <MarkdownPreview source={b.content} />
                    ) : (
                      streaming && <span className="sp-chat-cursor">▌</span>
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
                disabled={streaming}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={onKeyDown}
              />
              {streaming ? (
                <ClassicyButton buttonSize="small" onClickFunc={stop}>
                  ■ 停止
                </ClassicyButton>
              ) : (
                <ClassicyButton buttonSize="small" isDefault disabled={!input.trim()} onClickFunc={send}>
                  发送
                </ClassicyButton>
              )}
            </div>
          </div>
        )}
      </ClassicyWindow>
    </ClassicyApp>
  );
}
