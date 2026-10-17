// 后端 API 封装：全部使用相对路径，兼容任意 basePath 部署

export interface HealthInfo {
  ok: boolean;
  basePath: string;
}

export async function fetchHealth(): Promise<HealthInfo> {
  const r = await fetch('./api/health');
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json() as Promise<HealthInfo>;
}

export class Unauthorized extends Error {
  constructor() {
    super('Unauthorized');
    this.name = 'Unauthorized';
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, init);
  if (r.status === 401) throw new Unauthorized();
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json() as Promise<T>;
}

export interface HostInfo {
  hostname: string;
  platform: string;
  release: string;
  arch: string;
  cpuModel: string;
  cpuCount: number;
  totalMem: number;
  uptime: number;
  lanIp: string[];
  wanIp: string | null;
}

export interface TempItem {
  label: string;
  temp: number;
}

export interface DiskItem {
  fs: string;
  mount: string;
  size: number;
  used: number;
  usagePct: number;
}

export interface Metrics {
  cpu: { usage: number; cores: number[]; loadavg: number[] | null };
  mem: { total: number; used: number; free: number; usagePct: number };
  swap: { total: number; used: number; usagePct: number } | null;
  temps: TempItem[];
  disks: DiskItem[];
  host: HostInfo;
  history: Array<{ t: number; cpu: number; mem: number }>;
}

export interface ProcItem {
  pid: number;
  user: string;
  cpuPct: number;
  mem: number;
  memPct: number;
  etime: string;
  cmd: string;
}

export interface Processes {
  available: boolean;
  list: ProcItem[];
  error?: string;
}

export interface DockerContainer {
  name: string;
  image: string;
  status: string;
  state: string;
  cpu: string;
  mem: string;
  memPct: string;
  net: string;
  block: string;
  pids: string;
}

export interface DockerState {
  available: boolean;
  containers: DockerContainer[];
  error?: string;
}

export const fetchMetrics = () => request<Metrics>('./api/metrics');
export const fetchProcesses = () => request<Processes>('./api/processes');
export const fetchDocker = () => request<DockerState>('./api/docker');

/** 获取终端（ttyd）访问令牌；503 + Terminal disabled 表示后端未启用终端功能 */
export async function getTerminalToken(): Promise<string> {
  const r = await fetch('./api/terminal/token');
  if (r.status === 401) throw new Unauthorized();
  if (r.status === 503) {
    const data = (await r.json().catch(() => null)) as { error?: string; detail?: string } | null;
    if (data?.error === 'Terminal disabled') throw new Error('Terminal disabled');
    // 后端已启用终端，但 ttyd 进程未就绪（未安装/端口冲突/重试中）
    throw new TerminalUnavailable(data?.detail || data?.error || 'ttyd 未运行');
  }
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const data = (await r.json()) as { token?: string };
  // ttyd 1.7+ 返回 { token }，旧版返回纯文本 token
  return data.token ?? (data as unknown as string);
}

/** 终端暂时不可用（ttyd 未就绪），与“未启用”区分，可由用户重试 */
export class TerminalUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TerminalUnavailable';
  }
}

export async function login(password: string): Promise<void> {
  const r = await fetch('./api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  if (r.status === 401) throw new Error('Incorrect password');
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
}

export async function logout(): Promise<void> {
  await fetch('./api/logout', { method: 'POST' }).catch(() => {});
}

/* ---------- 文件管理（/api/fs/*）---------- */

export type FsPreviewable = 'image' | 'text' | 'markdown' | 'none';

/** 目录条目（/api/fs/list 返回） */
export interface FsEntry {
  name: string;
  path: string;
  type: 'dir' | 'file';
  size: number;
  mtime: number;
  mode: string;
  previewable: FsPreviewable;
}

export interface FsListResult {
  path: string;
  roots: string[];
  entries: FsEntry[];
}

/** /api/fs/read 返回：tooLarge（超 2MB）或 binary（含 NUL 字节）时不含 content */
export interface FsReadResult {
  path: string;
  name: string;
  size: number;
  mtime: number;
  content?: string;
  tooLarge?: boolean;
  binary?: boolean;
}

const enc = encodeURIComponent;

export const fsList = (path: string) => request<FsListResult>(`./api/fs/list?path=${enc(path)}`);

export const fsRead = (path: string) => request<FsReadResult>(`./api/fs/read?path=${enc(path)}`);

/** create=1 时为「新建文件」语义：目标已存在返回 409，避免误覆盖 */
export const fsWrite = (path: string, content: string, create = false) =>
  request<{ ok: true; size: number; mtime: number }>(`./api/fs/write?path=${enc(path)}${create ? '&create=1' : ''}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    body: content,
  });

export const fsMkdir = (path: string) =>
  request<{ ok: true }>('./api/fs/mkdir', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path }),
  });

export const fsDelete = (path: string) =>
  request<{ ok: true }>('./api/fs/delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path }),
  });

export const fsRename = (path: string, name: string) =>
  request<{ ok: true; path: string }>('./api/fs/rename', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, name }),
  });

/**
 * 复制文件/目录到目标目录（服务端递归复制）。
 * 同名不覆盖：服务端按 Finder 惯例自动追加 " copy" / " copy 2" 后缀，响应回传实际路径。
 */
export const fsCopy = (path: string, dir: string) =>
  request<{ ok: true; path: string; name: string }>('./api/fs/copy', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, dir }),
  });

export const fsGetFavorites = () => request<{ favorites: string[] }>('./api/fs/favorites');

export const fsSetFavorites = (favorites: string[]) =>
  request<{ ok: true; favorites: string[] }>('./api/fs/favorites', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ favorites }),
  });

/** Editor 视图偏好（服务端持久化到 ~/.watchdog-os/data.json，跨浏览器/重部署生效）。
 *  PUT 为部分合并语义：仅传需要变更的字段，未传字段保留服务端原值 */
export interface EditorServerPrefs {
  wordWrap?: boolean;
  showPreview?: boolean;
}

export const prefsGetEditor = () => request<{ editor: EditorServerPrefs }>('./api/prefs/editor');

export const prefsSetEditor = (editor: EditorServerPrefs) =>
  request<{ ok: true; editor: EditorServerPrefs }>('./api/prefs/editor', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ editor }),
  });

/** 图片内联预览地址；download=1 时走附件下载（HttpOnly Cookie 鉴权天然可用） */
export const fsRawUrl = (path: string, download = false) =>
  `./api/fs/raw?path=${enc(path)}${download ? '&download=1' : ''}`;

/** 上传单个文件（XHR 以获得上传进度）；409 同名冲突时以 overwrite 重试 */
export function fsUpload(
  dir: string,
  file: File,
  overwrite = false,
  onProgress?: (loaded: number, total: number) => void
): { promise: Promise<{ ok: true; path: string; name: string; size: number }>; abort: () => void } {
  const xhr = new XMLHttpRequest();
  const promise = new Promise<{ ok: true; path: string; name: string; size: number }>((resolve, reject) => {
    xhr.open(
      'POST',
      `./api/fs/upload?path=${enc(dir)}&name=${enc(file.name)}${overwrite ? '&overwrite=1' : ''}`
    );
    xhr.responseType = 'json';
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress?.(e.loaded, e.total);
    };
    xhr.onload = () => {
      if (xhr.status === 401) return reject(new Unauthorized());
      const data = xhr.response as { ok?: boolean; error?: string; path?: string; name?: string; size?: number } | null;
      if (xhr.status >= 200 && xhr.status < 300 && data?.ok) {
        return resolve({ ok: true, path: data.path || '', name: data.name || file.name, size: data.size || file.size });
      }
      reject(new Error(data?.error || `HTTP ${xhr.status}`));
    };
    xhr.onerror = () => reject(new Error('Network error — upload failed'));
    xhr.onabort = () => reject(new Error('Upload canceled'));
    xhr.send(file);
  });
  return { promise, abort: () => xhr.abort() };
}

/* ---------- Runner（脚本任务触发，如 running_page build.sh）---------- */

/** /api/runner/status 返回的 job：运行中 exitCode/finishedAt 为 null */
export interface RunnerJob {
  id: string;
  startedAt: number;
  script?: string;
  exitCode?: number | null;
  finishedAt?: number | null;
}

/** 最近一次结束的任务摘要 */
export interface RunnerLast {
  id: string;
  startedAt: number;
  finishedAt: number;
  exitCode: number | null;
  failed: boolean;
  durationMs: number;
}

export interface RunnerStatus {
  enabled: boolean;
  script: string;
  running: boolean;
  job: RunnerJob | null;
  last: RunnerLast | null;
  log: string;
}

export const fetchRunnerStatus = () =>
  request<RunnerStatus>('./api/runner/status?lines=400');

export const startRunnerBuild = () =>
  request<{ ok: true; jobId: string; startedAt: number }>('./api/runner/start', { method: 'POST' });

export const stopRunnerBuild = () =>
  request<{ ok: true; job: RunnerJob | null }>('./api/runner/stop', { method: 'POST' });

/* ---------- Printer（CUPS 打印机与任务监控）---------- */

export interface PrinterInfo {
  name: string;
  model: string;
  /** idle 空闲 / processing 打印中 / stopped 已停止 */
  state: string;
  /** 缺纸、卡纸等状态原因（"none" 表示正常） */
  stateReasons: string;
  /** CUPS 的附加状态说明（如 "Unable to open USB device"） */
  stateMessage: string;
  accepting: boolean;
  deviceUri: string;
  /** device-uri 为 usb:// 即配置为 USB 连接 */
  usbConfigured: boolean;
  /** 与 lpinfo -v 枚举的物理设备比对得出：USB 线是否已连接 */
  usbConnected: boolean;
}

/** 一条打印任务（打印中 / 历史通用） */
export interface PrinterJob {
  id: string;
  printer: string;
  name: string;
  user: string;
  /** 发起打印的设备（客户端 IP） */
  host: string;
  state: string;
  sizeKB: number;
  createdMs: number;
  completedMs: number | null;
}

export interface PrinterState {
  available: boolean;
  collectedAt?: number;
  printers: PrinterInfo[];
  activeJobs: PrinterJob[];
  history: PrinterJob[];
  error?: string;
}

export const fetchPrinter = () => request<PrinterState>('./api/printer');

/* ---------- Chat（Hermes 聊天代理，/api/chat/*）---------- */

export interface ChatStatus {
  enabled: boolean;
  baseUrl: string;
}

/** 发送给模型的消息（OpenAI 格式，无状态协议：每次全量重传会话历史） */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export const fetchChatStatus = () => request<ChatStatus>('./api/chat/status');

/** 从错误响应中提取可读信息（兼容 OpenAI 风格 error.message 与后端 { error } / { detail }） */
async function chatHttpError(r: Response): Promise<string> {
  const data = (await r.json().catch(() => null)) as
    | { error?: { message?: string } | string; detail?: string; message?: string }
    | null;
  const msg =
    (typeof data?.error === 'object' ? data.error.message : data?.error) ||
    data?.detail ||
    data?.message ||
    `HTTP ${r.status}`;
  return msg;
}

/**
 * 非流式对话：返回完整回复文本。
 * 上游/代理错误（503 等）以 Error 抛出，message 为可读信息。
 */
export async function sendChatMessage(messages: ChatMessage[], signal?: AbortSignal): Promise<string> {
  const r = await fetch('./api/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages, stream: false }),
    signal,
  });
  if (r.status === 401) throw new Unauthorized();
  if (!r.ok) throw new Error(await chatHttpError(r));
  const data = (await r.json()) as { choices?: Array<{ message?: { content?: string } }> };
  return data?.choices?.[0]?.message?.content ?? '';
}

/** delta.tool_calls 按 index 分片累积后的单个调用视图 */
export interface StreamToolCall {
  index: number;
  /** 首片携带的调用 id（后续片可能省略） */
  id?: string;
  /** 首片携带的函数名（后续片可能省略） */
  name?: string;
  /** 各分片 arguments 字符串按序拼接，可能不完整 */
  arguments: string;
}

export interface ChatStreamHandlers {
  messages: ChatMessage[];
  signal?: AbortSignal;
  /** 服务端会话 ID（有则随 X-Hermes-Session-Id 请求头带上，让 hermes 记入同一 transcript） */
  sessionId?: string;
  /** 正文增量（choices[0].delta.content） */
  onDelta?: (text: string) => void;
  /** 推理内容增量（choices[0].delta.reasoning_content） */
  onReasoning?: (text: string) => void;
  /** 工具执行进度（自定义事件 data: {"type":"hermes.tool.progress", ...}），字段容错解析 */
  onToolProgress?: (data: Record<string, unknown>) => void;
  /**
   * 所有成功解析的 SSE JSON 事件整包透传（含未知 data.type / event: 行声明的事件）。
   * 前向兼容通道：hermes 私有协议新增事件时无需改本函数。
   * evName 为 SSE `event:` 字段行声明的类型（hermes 的工具事件用该方式传输，data JSON 内无 type 字段）。
   */
  onEvent?: (data: Record<string, unknown>, evName?: string) => void;
  /** delta.tool_calls 分片累积后的当前快照（按 index 升序全量回调） */
  onToolCall?: (calls: StreamToolCall[]) => void;
  /** 流结束（收到 [DONE] 或连接关闭；用户 abort 也归入正常结束） */
  onDone?: () => void;
  /** 请求/流错误 */
  onError?: (e: Error) => void;
  /** 从 2xx 响应头读出的 X-Hermes-Session-Id（流开始前即触发，abort 前也已到达） */
  onSessionId?: (sid: string) => void;
}

/**
 * 流式对话：fetch + ReadableStream 解析 SSE 帧（text/event-stream）。
 * - 处理跨 chunk 的行缓冲（半行数据留到下次拼接）
 * - data: [DONE] 结束；hermes.tool.progress 自定义事件按 JSON 容错解析
 * - onError 回调后 promise 正常 resolve，不向调用方抛异常
 */
export async function streamChat({
  messages,
  signal,
  sessionId,
  onDelta,
  onReasoning,
  onToolProgress,
  onEvent,
  onToolCall,
  onDone,
  onError,
  onSessionId,
}: ChatStreamHandlers): Promise<void> {
  try {
    const r = await fetch('./api/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(sessionId ? { 'X-Hermes-Session-Id': sessionId } : {}),
      },
      body: JSON.stringify({ messages, stream: true }),
      signal,
    });
    if (r.status === 401) throw new Unauthorized();
    if (!r.ok) throw new Error(await chatHttpError(r));
    const sid = r.headers.get('X-Hermes-Session-Id');
    if (sid) onSessionId?.(sid);
    if (!r.body) throw new Error('响应不含数据流');

    // delta.tool_calls 分片累积状态（每次 streamChat 调用独立，无跨流污染）
    const toolCallMap = new Map<number, StreamToolCall>();
    // 当前 SSE event: 字段行声明的类型（作用于紧随其后的 data 行，处理后重置）
    let eventName: string | undefined;

    const handleLine = (line: string) => {
      if (line.startsWith('event:')) {
        eventName = line.slice(6).trim() || undefined;
        return;
      }
      if (!line.startsWith('data:')) return;
      const payload = line.slice(5).trim();
      if (!payload) return;
      if (payload === '[DONE]') return; // 结束由连接关闭统一收口
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(payload) as Record<string, unknown>;
      } catch {
        eventName = undefined;
        return; // 非 JSON 行容错忽略
      }
      // 通用事件通道：所有解析成功的事件整包透传（含 event: 行声明的类型），放在分流之前
      onEvent?.(data, eventName);
      // hermes 工具进度：优先 data.type，回退到 SSE event: 行（真实协议为后者，data JSON 内无 type）
      const evType = typeof data.type === 'string' ? data.type : eventName;
      if (evType === 'hermes.tool.progress') {
        onToolProgress?.(data);
        eventName = undefined;
        return;
      }
      const delta = (data as { choices?: Array<{ delta?: { content?: string; reasoning_content?: string; tool_calls?: unknown } }> })
        ?.choices?.[0]?.delta;
      // OpenAI 标准工具调用分片：按 index 累积（id/name 首片取值，arguments 字符串拼接）
      if (Array.isArray(delta?.tool_calls)) {
        (delta.tool_calls as Array<Record<string, unknown>>).forEach((c, i) => {
          const idx = typeof c.index === 'number' ? c.index : i;
          const fn = (c.function ?? {}) as Record<string, unknown>;
          const cur = toolCallMap.get(idx) ?? { index: idx, arguments: '' };
          if (typeof c.id === 'string' && c.id) cur.id = c.id;
          if (typeof fn.name === 'string' && fn.name) cur.name = fn.name;
          if (typeof fn.arguments === 'string') cur.arguments += fn.arguments;
          toolCallMap.set(idx, cur);
        });
        onToolCall?.([...toolCallMap.values()].sort((a, b) => a.index - b.index));
        // 不提前 return：同一 delta 可能同时携带 tool_calls 与 content/reasoning
      }
      if (typeof delta?.content === 'string' && delta.content) onDelta?.(delta.content);
      if (typeof delta?.reasoning_content === 'string' && delta.reasoning_content) {
        onReasoning?.(delta.reasoning_content);
      }
      eventName = undefined; // data 行处理完毕，event: 类型不向后泄漏
    };

    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, '');
        buf = buf.slice(nl + 1);
        handleLine(line);
      }
    }
    buf += dec.decode(); // 冲刷解码器残存的半行
    if (buf) handleLine(buf.replace(/\r$/, ''));
    onDone?.();
  } catch (e) {
    // 用户主动停止（AbortController.abort）视为正常结束，保留已收到的部分回复
    if (e instanceof DOMException && e.name === 'AbortError') {
      onDone?.();
      return;
    }
    onError?.(e instanceof Error ? e : new Error(String(e)));
  }
}

/* ---------- Chat Sessions（hermes 服务端会话列表 / 历史，/api/chat/sessions*）---------- */

/** hermes 服务端会话（列表/元数据经适配后的展示模型） */
export interface HermesSession {
  id: string;
  /** 展示标题，提取失败回退 'Untitled' */
  title: string;
  /** ms 时间戳，解析失败为 0 */
  updatedAt: number;
  messageCount?: number;
}

/** 服务端历史消息适配后的最小气泡模型（ChatApp 再补 id 映射为 ChatBubble） */
export interface ChatHistoryBubble {
  role: 'user' | 'assistant';
  content: string;
  reasoning?: string;
}

/* --- 宽松字段提取工具（hermes 响应 JSON 结构官方文档未详述，按候选键容错）--- */

function pickStr(obj: Record<string, unknown>, keys: string[]): string {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v) return v;
  }
  return '';
}

function pickNum(obj: Record<string, unknown>, keys: string[]): number | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return undefined;
}

/** 从任意形状响应中取第一个数组（messages/data/sessions/items 包裹或直接数组） */
function pickArray(raw: unknown): Record<string, unknown>[] {
  if (Array.isArray(raw)) return raw as Record<string, unknown>[];
  if (raw && typeof raw === 'object') {
    for (const k of ['messages', 'data', 'sessions', 'items', 'results']) {
      const v = (raw as Record<string, unknown>)[k];
      if (Array.isArray(v)) return v as Record<string, unknown>[];
    }
  }
  return [];
}

/** 时间字段归一为 ms：ISO 字符串 / 秒 / 毫秒均尝试，失败返回 0 */
function pickTime(obj: Record<string, unknown>, keys: string[]): number {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) {
      return v > 1e12 ? v : v * 1000; // 秒 → 毫秒
    }
    if (typeof v === 'string' && v) {
      const t = Date.parse(v);
      if (!Number.isNaN(t)) return t;
    }
  }
  return 0;
}

/** 会话的「最后更新时间」候选键：last_active 为 hermes 实测字段（秒级浮点） */
const SESSION_UPDATED_KEYS = [
  'last_active',
  'lastActive',
  'updated_at',
  'updatedAt',
  'last_message_at',
  'last_activity_at',
  'modified_at',
  'created_at',
  'createdAt',
];

/** 消息 content 容错提取：string 直用；blocks 数组拼接各块 .text；对象取 .text/.body */
function pickContent(m: Record<string, unknown>): string {
  const c = m.content ?? m.text ?? m.body;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c
      .map((b) => (b && typeof b === 'object' && typeof (b as Record<string, unknown>).text === 'string' ? (b as Record<string, unknown>).text : ''))
      .join('');
  }
  if (c && typeof c === 'object') {
    const o = c as Record<string, unknown>;
    if (typeof o.text === 'string') return o.text;
    if (typeof o.body === 'string') return o.body;
  }
  return '';
}

/** 会话列表适配：id 提取失败的条目丢弃 */
function adaptSessions(raw: unknown): HermesSession[] {
  const out: HermesSession[] = [];
  for (const s of pickArray(raw)) {
    if (!s || typeof s !== 'object') continue;
    const id = pickStr(s, ['id', 'session_id', 'sessionId', 'uuid']);
    if (!id) continue;
    const count = pickNum(s, ['message_count', 'messageCount', 'count', 'turns']);
    out.push({
      id,
      title: pickStr(s, ['title', 'name', 'summary', 'label', 'preview']) || 'Untitled',
      updatedAt: pickTime(s, SESSION_UPDATED_KEYS),
      messageCount: count,
    });
  }
  return out;
}

/** 服务端历史消息适配：仅保留 user/assistant，role 提取失败或空消息跳过，末尾 200 条防巨型历史 */
function adaptSessionMessages(raw: unknown): ChatHistoryBubble[] {
  const out: ChatHistoryBubble[] = [];
  for (const m of pickArray(raw)) {
    if (!m || typeof m !== 'object') continue;
    const roleRaw = pickStr(m, ['role', 'sender', 'author']).toLowerCase();
    const role = /^(user|human)$/.test(roleRaw) ? 'user' : /^(assistant|ai|model)$/.test(roleRaw) ? 'assistant' : null;
    if (!role) continue;
    const content = pickContent(m);
    const reasoning = pickStr(m, ['reasoning_content', 'reasoning', 'thinking']);
    if (!content && !reasoning) continue;
    out.push({ role, content, reasoning: reasoning || undefined });
  }
  return out.slice(-200);
}

/** 会话列表（服务端为准，按时间倒序由前端表格排序） */
export async function fetchChatSessions(limit = 50): Promise<HermesSession[]> {
  const raw = await request<unknown>(`./api/chat/sessions?limit=${limit}`);
  return adaptSessions(raw);
}

/** 会话历史消息（原始 JSON，由调用方经 adaptSessionMessages 适配——保持独立便于测试） */
export async function fetchChatSessionMessagesRaw(id: string): Promise<unknown> {
  return request<unknown>(`./api/chat/sessions/${encodeURIComponent(id)}/messages?inline_images=false`);
}

export async function fetchChatSessionMessages(id: string): Promise<ChatHistoryBubble[]> {
  return adaptSessionMessages(await fetchChatSessionMessagesRaw(id));
}

export async function deleteChatSession(id: string): Promise<void> {
  await request<unknown>(`./api/chat/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' });
}
