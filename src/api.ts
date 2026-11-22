// 后端 API 封装：全部使用相对路径，兼容任意 basePath 部署
import { notifyUnauthorized } from './session';

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

/**
 * 构造 401 异常并**同时通知会话失效**（清本地会话存储 + 回登录页）。
 * 所有鉴权接口的 401 都必须走这里，否则会出现「某个应用 401 了、界面却停在桌面」的半死状态。
 * 例外：`login()` 的 401 是「密码错误」，不是会话失效，不得调用本函数。
 */
function unauthorized(): Unauthorized {
  notifyUnauthorized();
  return new Unauthorized();
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, init);
  if (r.status === 401) throw unauthorized();
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json() as Promise<T>;
}

/**
 * 静默鉴权探测（App 启动时判断是否已登录）。
 * 专用公开接口 `/api/auth/check`：恒 200 + `{ authenticated }`，几十字节。
 * 不用受保护接口（曾是 `/api/metrics`）：那会 ① 让登录页访客每次打开都写一条 401 审计，
 * 把「自己刷新页面」混进撞库信号；② 已登录时白拉整份 metrics 响应体。
 * 不读 r.status===401 的语义，故不存在「401 → 全局登出 → 重载 → 再探测」的死循环风险；
 * 服务异常 / 网络异常一律按「已登录」处理，交由后续接口自然报错。
 */
export async function probeAuth(): Promise<boolean> {
  try {
    const r = await fetch('./api/auth/check');
    if (!r.ok) return true;
    const d = (await r.json()) as { authenticated?: boolean };
    return d.authenticated === true;
  } catch {
    return true;
  }
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

/** 对齐后端 server/api/metrics.js readDisks()：{ mount, total, free, used, usagePct, error? } */
export interface DiskItem {
  mount: string;
  total: number;
  free: number;
  used: number;
  usagePct: number;
  /** statfs 读取失败时的降级标记（此时容量字段全为 0） */
  error?: string;
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
  if (r.status === 401) throw unauthorized();
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

export type FsPreviewable = 'image' | 'pdf' | 'docx' | 'text' | 'markdown' | 'none';

/** 目录条目（/api/fs/list 返回） */
export interface FsEntry {
  name: string;
  path: string;
  type: 'dir' | 'file';
  size: number;
  mtime: number;
  mode: string;
  previewable: FsPreviewable;
  /** 仅根列表里的网络挂载条目携带：'smb' | 'webdav'，用于显示网络磁盘图标 */
  network?: string;
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

/* ---------- 网络挂载（/api/mounts）：Files 的 SMB / WebDAV 远程目录 ---------- */

export type MountProtocol = 'smb' | 'webdav';

/** 连接配置（密码由服务端单独存 600 凭据文件，任何响应都不回传） */
export interface MountConnection {
  id: string;
  name: string;
  protocol: MountProtocol;
  host: string;
  share: string;
  domain: string;
  url: string;
  username: string;
  autoMount: boolean;
  createdAt: number;
  mountPoint: string;
  mounted: boolean;
}

export interface MountCaps {
  platform: string;
  supported: boolean;
  reasons: string[];
  missing: string[];
  sudoersOk: boolean;
  helper: string;
  mountsDir: string;
  engines: { smb: boolean; webdav: boolean };
}

export interface MountsPayload {
  connections: MountConnection[];
  caps: MountCaps;
}

/** 新建/更新连接：password 新增必填，更新时留空 = 保留原密码 */
export interface MountInput {
  name: string;
  protocol: MountProtocol;
  host?: string;
  share?: string;
  domain?: string;
  url?: string;
  username: string;
  password?: string;
  autoMount: boolean;
}

export const mountsList = () => request<MountsPayload>('./api/mounts');
export const mountsCaps = () => request<MountCaps>('./api/mounts/caps');

export const mountsCreate = (input: MountInput) =>
  request<{ ok: true; connection: MountConnection }>('./api/mounts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });

export const mountsUpdate = (id: string, input: MountInput) =>
  request<{ ok: true; connection: MountConnection }>(`./api/mounts/${enc(id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });

export const mountsDelete = (id: string) =>
  request<{ ok: true }>(`./api/mounts/${enc(id)}`, { method: 'DELETE' });

export const mountsMount = (id: string) =>
  request<{ ok: true; mountPoint: string }>(`./api/mounts/${enc(id)}/mount`, { method: 'POST' });

export const mountsUnmount = (id: string) =>
  request<{ ok: true }>(`./api/mounts/${enc(id)}/unmount`, { method: 'POST' });

/** Editor 偏好（服务端持久化到 ~/.watchdog-os/data.json，跨浏览器/重部署生效）。
 *  PUT 为部分合并语义：仅传需要变更的字段，未传字段保留服务端原值。
 *  服务端只校验类型与长度，枚举（主题 id / 字体栈）由前端按 EDITOR_THEMES / EDITOR_FONTS 回退。 */
export interface EditorServerPrefs {
  wordWrap?: boolean;
  showPreview?: boolean;
  theme?: string;
  fontSize?: number;
  fontFamily?: string;
}

/** file 为服务端实际落盘路径（~/.watchdog-os/data.json），设置面板据此展示；PUT 不返回 */
export const prefsGetEditor = () => request<{ editor: EditorServerPrefs; file?: string }>('./api/prefs/editor');

export const prefsSetEditor = (editor: EditorServerPrefs) =>
  request<{ ok: true; editor: EditorServerPrefs }>('./api/prefs/editor', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ editor }),
  });

/** Files 偏好（服务端持久化到 ~/.watchdog-os/data.json 的 finder 键）。
 *  键缺失语义由前端决定：showFavoritesSidebar 缺省视为 true（首次打开即展开收藏夹侧栏） */
export interface FinderServerPrefs {
  showFavoritesSidebar?: boolean;
  showHiddenFiles?: boolean;
}

export const prefsGetFinder = () => request<{ finder: FinderServerPrefs }>('./api/prefs/finder');

export const prefsSetFinder = (finder: FinderServerPrefs) =>
  request<{ ok: true; finder: FinderServerPrefs }>('./api/prefs/finder', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ finder }),
  });

/* ---------- 编辑器草稿（/api/drafts）：未保存内容的自动缓存 ---------- */

/** 源文件当前状态（服务端 stat 得出，只含元数据；列表里用来标「已变更 / 已删除」） */
export interface DraftDiskState {
  exists: boolean;
  mtime: number | null;
}

/** 列表条目：**不含正文**（正文可能 2MB，列表只读文件头） */
export interface DraftEntry {
  id: string;
  path: string;
  name: string;
  size: number;
  updatedAt: number;
  /** 草稿基于的磁盘 mtime；恢复时与当前 mtime 比对判断源文件是否已变 */
  baseMtime: number | null;
  disk: DraftDiskState;
}

export interface DraftFull extends DraftEntry {
  content: string;
}

export interface DraftListResult {
  drafts: DraftEntry[];
  limits: { maxBytes: number; maxEntries: number; retentionDays: number };
  dir: string;
}

export const draftsList = () => request<DraftListResult>('./api/drafts');

export const draftsGet = (id: string) => request<DraftFull>(`./api/drafts/${enc(id)}`);

/** 写入草稿（body 为 UTF-8 正文原文，与 /api/fs/write 同构）；baseMtime 供恢复时判断源文件是否已变 */
export const draftsPut = (path: string, content: string, baseMtime: number | null) =>
  request<{ ok: true; id: string; size: number; updatedAt: number; baseMtime: number | null }>(
    `./api/drafts?path=${enc(path)}${baseMtime != null ? `&baseMtime=${baseMtime}` : ''}`,
    { method: 'PUT', headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body: content }
  );

/** 按路径删除（幂等）：保存成功 / 用户丢弃后调用，deleted=false 不算错误 */
export const draftsDeleteByPath = (path: string) =>
  request<{ ok: true; deleted: boolean }>(`./api/drafts?path=${enc(path)}`, { method: 'DELETE' });

export const draftsDeleteById = (id: string) =>
  request<{ ok: true; deleted: boolean }>(`./api/drafts/${enc(id)}`, { method: 'DELETE' });

export const draftsDeleteAll = () =>
  request<{ ok: true; deleted: number }>('./api/drafts', { method: 'DELETE' });

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
      if (xhr.status === 401) return reject(unauthorized());
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

/* ---------- 归档（压缩 / 解压，单请求 NDJSON 进度流）---------- */

export type ArchiveFormat = 'zip' | 'tar.gz';

/** 单个动作的工具能力；ok=false 时 hint 给出安装命令 */
export interface ArchiveCapability {
  ok: boolean;
  /** 实际使用的工具：bsdtar / gnutar / unzip / zip */
  via: string | null;
  hint: string | null;
}

/** /api/fs/archive/caps：服务端探测到的归档工具（能力按探测结果分派，不按 OS 硬编码） */
export interface ArchiveCaps {
  platform: string;
  tools: {
    tar: { path: string; kind: string; version: string } | null;
    unzip: { path: string } | null;
    zip: { path: string } | null;
    gzip: { path: string } | null;
  };
  can: {
    extractZip: ArchiveCapability;
    extractTarGz: ArchiveCapability;
    compressZip: ArchiveCapability;
    compressTarGz: ArchiveCapability;
  };
  checkedAt: number;
}

export type ArchivePhase = 'listing' | 'running' | 'finalizing';

/** 流式进度帧；total=null 表示条目数未知（进度条走不确定态） */
export interface ArchiveProgress {
  phase: ArchivePhase;
  processed: number;
  total: number | null;
  percent: number;
  current: string;
}

export interface ArchiveResult {
  dest: string;
  items: number;
  bytes?: number;
  createdDest?: boolean;
  warnings?: string[];
}

interface ArchiveErrorBody {
  error?: string;
  code?: string;
  hint?: string | null;
  detail?: string | null;
  dest?: string;
}

/**
 * 归档接口错误：保留服务端的 code / hint / detail。
 * 与 request() 只抛 `HTTP xxx` 不同——缺工具时的安装命令、目标非空时的 dest
 * 都是界面必须展示的信息，不能被吞掉。
 */
export class ArchiveError extends Error {
  code: string;
  hint: string | null;
  detail: string | null;
  dest?: string;

  constructor(message: string, code: string, hint: string | null = null, detail: string | null = null, dest?: string) {
    super(message);
    this.name = 'ArchiveError';
    this.code = code;
    this.hint = hint;
    this.detail = detail;
    this.dest = dest;
  }
}

function archiveErrorFrom(data: ArchiveErrorBody | null, status: number): ArchiveError {
  return new ArchiveError(
    data?.error || `HTTP ${status}`,
    data?.code || `HTTP_${status}`,
    data?.hint ?? null,
    data?.detail ?? null,
    data?.dest
  );
}

export async function fetchArchiveCaps(refresh = false): Promise<ArchiveCaps> {
  const r = await fetch(`./api/fs/archive/caps${refresh ? '?refresh=1' : ''}`);
  if (r.status === 401) throw unauthorized();
  if (!r.ok) throw archiveErrorFrom(await r.json().catch(() => null), r.status);
  return r.json() as Promise<ArchiveCaps>;
}

/**
 * 一次请求跑完解压/压缩：响应是 NDJSON 流，`done` 帧到达时 resolve。
 * 调用方 `await promise` 即「同步等待结果」，进度由 onProgress 实时回调（无轮询、无 job id）。
 * abort() 会断开连接，服务端据此杀子进程并清理半成品。
 */
function archiveStream(
  url: string,
  payload: Record<string, unknown>,
  onProgress?: (p: ArchiveProgress) => void
): { promise: Promise<ArchiveResult>; abort: () => void } {
  const ac = new AbortController();
  const promise = (async (): Promise<ArchiveResult> => {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: ac.signal,
    });
    if (r.status === 401) throw unauthorized();
    if (!r.ok) throw archiveErrorFrom(await r.json().catch(() => null), r.status);
    if (!r.body) throw new ArchiveError('Response does not contain a data stream', 'NO_STREAM');

    const out: { result: ArchiveResult | null; error: ArchiveError | null } = { result: null, error: null };

    const handleLine = (line: string) => {
      const s = line.trim();
      if (!s) return;
      let evt: Record<string, unknown>;
      try {
        evt = JSON.parse(s) as Record<string, unknown>;
      } catch {
        return; // 半行/非 JSON 容错忽略
      }
      if (evt.t === 'progress') {
        onProgress?.({
          phase: (evt.phase as ArchivePhase) || 'running',
          processed: typeof evt.processed === 'number' ? evt.processed : 0,
          total: typeof evt.total === 'number' ? evt.total : null,
          percent: typeof evt.percent === 'number' ? evt.percent : 0,
          current: typeof evt.current === 'string' ? evt.current : '',
        });
      } else if (evt.t === 'done') {
        out.result = {
          dest: typeof evt.dest === 'string' ? evt.dest : '',
          items: typeof evt.items === 'number' ? evt.items : 0,
          bytes: typeof evt.bytes === 'number' ? evt.bytes : undefined,
          createdDest: evt.createdDest === true,
          warnings: Array.isArray(evt.warnings) ? evt.warnings.map(String) : [],
        };
      } else if (evt.t === 'error') {
        out.error = new ArchiveError(
          typeof evt.error === 'string' ? evt.error : 'Archive task failed',
          typeof evt.code === 'string' ? evt.code : 'TOOL_FAILED',
          typeof evt.hint === 'string' ? evt.hint : null,
          typeof evt.detail === 'string' ? evt.detail : null
        );
      }
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
        handleLine(buf.slice(0, nl).replace(/\r$/, ''));
        buf = buf.slice(nl + 1);
      }
    }
    buf += dec.decode();
    if (buf) handleLine(buf.replace(/\r$/, ''));
    if (out.error) throw out.error;
    if (!out.result) {
      throw new ArchiveError('Connection closed before the task finished — check the destination folder.', 'UNEXPECTED_END');
    }
    return out.result;
  })();
  return { promise, abort: () => ac.abort() };
}

/** 解压归档；dest 为空串表示由服务端按「同名子文件夹 + 自动编号」推导 */
export function fsExtract(
  path: string,
  dest: string,
  overwrite = false,
  onProgress?: (p: ArchiveProgress) => void
): { promise: Promise<ArchiveResult>; abort: () => void } {
  return archiveStream('./api/fs/archive/extract', { path, dest, overwrite }, onProgress);
}

/** 压缩选中的文件/目录；重名由服务端自动追加 " 2"，绝不覆盖 */
export function fsCompress(
  paths: string[],
  format: ArchiveFormat,
  dest: string,
  name: string,
  onProgress?: (p: ArchiveProgress) => void
): { promise: Promise<ArchiveResult>; abort: () => void } {
  return archiveStream('./api/fs/archive/compress', { paths, format, dest, name }, onProgress);
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

/* ---------- Blog（static-gallary-generator 构建，复用 Runner 引擎响应结构）---------- */

export const fetchBlogStatus = () => request<RunnerStatus>('./api/blog/status?lines=400');

export const startBlogBuild = () =>
  request<{ ok: true; jobId: string; startedAt: number }>('./api/blog/start', { method: 'POST' });

export const stopBlogBuild = () =>
  request<{ ok: true; job: RunnerJob | null }>('./api/blog/stop', { method: 'POST' });

/* ---------- Printer（CUPS 打印机与任务监控）---------- */

/** 物理链路：unknown 表示探测手段不可用，不等于未连接 */
export interface PrinterLink {
  state: 'connected' | 'disconnected' | 'unknown';
  /** sysfs / lpinfo / cups / none */
  source: string;
  /** USB 设备在 sysfs 中的路径，如 1-1.2 */
  devicePath: string;
  /** 内核 usblp 是否已绑定（打印中 CUPS 会临时占用，可能为 false） */
  driverBound: boolean;
  serial: string;
  /** 同型号多台且 device-uri 无序列号时无法唯一确定 */
  ambiguous: boolean;
  detail: string;
  /** 本次状态开始时间 / 最近一次确认在位时间（ms） */
  since: number;
  lastSeen: number;
}

/** 打印能力：由 CUPS 状态推导，与链路层解耦 */
export interface PrinterReady {
  state: 'ready' | 'offline' | 'paused' | 'error' | 'unknown';
  reasons: string[];
  detail: string;
}

/** 本轮链路探测的元信息 */
export interface PrinterProbe {
  method: string;
  durationMs: number;
  degraded: boolean;
  error: string;
}

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
  /** CUPS 队列长度（queued-job-count） */
  queuedJobCount: number;
  deviceUri: string;
  /** usb / network / other */
  transport: 'usb' | 'network' | 'other';
  /** device-uri 为 usb:// 即配置为 USB 连接 */
  usbConfigured: boolean;
  /** 兼容字段：等价于 link.state === 'connected'（探测失败时为 false） */
  usbConnected: boolean;
  link: PrinterLink;
  ready: PrinterReady;
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
  probe?: PrinterProbe;
  printers: PrinterInfo[];
  activeJobs: PrinterJob[];
  error?: string;
}

/** GET /api/printer/history：历史独立采集（服务端默认 60s 一轮） */
export interface PrinterHistory {
  collectedAt?: number;
  history: PrinterJob[];
  error?: string;
}

export const fetchPrinter = () => request<PrinterState>('./api/printer');
export const fetchPrinterHistory = () => request<PrinterHistory>('./api/printer/history');

/** POST /api/printer/test-page 成功响应（jobId 为 CUPS 作业号字符串） */
export interface PrinterTestPageResult {
  ok: true;
  printer: string;
  jobId: string;
  requestId: string;
  title: string;
}

/** 提交打印测试页：非 2xx 时把服务端 error/detail 合并进异常消息（lp 的失败原因在 detail 里） */
export async function printTestPage(printer: string): Promise<PrinterTestPageResult> {
  const r = await fetch('./api/printer/test-page', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ printer }),
  });
  if (r.status === 401) throw unauthorized();
  const data = (await r.json().catch(() => null)) as
    | (PrinterTestPageResult & { error?: string; detail?: string })
    | null;
  if (!r.ok) {
    const msg = [data?.error, data?.detail].filter(Boolean).join('：') || `HTTP ${r.status}`;
    throw new Error(msg);
  }
  return data as PrinterTestPageResult;
}

/** POST /api/printer/print 的请求体：打印 Files 中选中的文件 */
export interface PrintFileOptions {
  /** 服务端 FS_ROOTS 白名单内的绝对路径 */
  path: string;
  /** CUPS 打印机名 */
  printer: string;
  /** media / PPD PageSize 关键字，见 server/api/printer.js 的 PRINT_PAPER_SIZES */
  paperSize: string;
  /** 'color' 彩色 / 'mono' 黑白 */
  colorMode: 'color' | 'mono';
  /** 页码范围（如 '1-3,5'、'8-'）；空串表示全部 */
  pageRange: string;
}

export interface PrintFileResult {
  ok: true;
  printer: string;
  jobId: string;
  requestId: string;
  title: string;
  pageRange: string;
}

/** 提交文件打印任务：非 2xx 时把服务端 error/detail 合并进异常消息（lp 的失败原因在 detail 里） */
export async function printFile(opts: PrintFileOptions): Promise<PrintFileResult> {
  const r = await fetch('./api/printer/print', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(opts),
  });
  if (r.status === 401) throw unauthorized();
  const data = (await r.json().catch(() => null)) as
    | (PrintFileResult & { error?: string; detail?: string })
    | null;
  if (!r.ok) {
    const msg = [data?.error, data?.detail].filter(Boolean).join('：') || `HTTP ${r.status}`;
    throw new Error(msg);
  }
  return data as PrintFileResult;
}

/* ---------- Printer 控制接口（恢复打印机 / 队列任务控制）---------- */

/** Printer 写接口公共 POST 封装：非 2xx 时把服务端 error/detail 合并进异常消息 */
async function printerPost<T>(url: string, body: unknown): Promise<T> {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (r.status === 401) throw unauthorized();
  const data = (await r.json().catch(() => null)) as (T & { error?: string; detail?: string }) | null;
  if (!r.ok) {
    const msg = [data?.error, data?.detail].filter(Boolean).join('：') || `HTTP ${r.status}`;
    throw new Error(msg);
  }
  return data as T;
}

/** 恢复被暂停的打印机：解除「已停止」并恢复接收新任务 */
export const resumePrinter = (printer: string) =>
  printerPost<{ ok: true; printer: string }>('./api/printer/resume', { printer });

/** 队列任务动作：hold 暂停 / resume 恢复（挂起）/ cancel 取消 / delete 删除 */
export type PrinterJobAction = 'hold' | 'resume' | 'cancel' | 'delete';

export const controlPrinterJob = (printer: string, jobId: string, action: PrinterJobAction) =>
  printerPost<{ ok: true; printer: string; jobId: string; action: PrinterJobAction }>(
    './api/printer/job',
    { printer, jobId, action }
  );

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
  if (r.status === 401) throw unauthorized();
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
    if (r.status === 401) throw unauthorized();
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
  /** 消息时间（ms，提取失败为 0；hermes 字段官方未详述，按候选键容错） */
  at: number;
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

/** 消息时间候选键（hermes 消息字段官方未详述，宽松容错；提取不到为 0，前端不显示时间） */
const MESSAGE_TIME_KEYS = [
  'created_at',
  'createdAt',
  'timestamp',
  'ts',
  'time',
  'sent_at',
  'date',
  'updated_at',
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
    out.push({ role, content, reasoning: reasoning || undefined, at: pickTime(m, MESSAGE_TIME_KEYS) });
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

/* ---------- Usage Dashboard（大模型余额/配额，/api/usage/*）---------- */

/** DeepSeek 余额（上游官方 /user/balance 响应原样透传） */
export interface DeepseekBalance {
  is_available: boolean;
  balance_infos: Array<{ currency: string; total_balance: string; granted_balance: string; topped_up_balance: string }>;
}

/** BigModel 标准 API 余额（上游账户报告接口原样透传；金额为人民币元，字段可能为 null） */
export interface BigmodelBalance {
  code?: number;
  success?: boolean;
  msg?: string;
  data?: {
    balance?: number | null;
    rechargeAmount?: number | null;
    giveAmount?: number | null;
    totalSpendAmount?: number | null;
    todaySpendAmount?: number | null;
    frozenBalance?: number | null;
    availableBalance?: number | null;
  };
}

/** 用量接口结果：503（未启用/未配置）标记 disabled，供前端区分「未配置」与「服务异常」 */
export type UsageResult<T> = { ok: true; data: T } | { ok: false; error: string; disabled?: boolean };

async function fetchUsage<T>(path: string): Promise<UsageResult<T>> {
  try {
    const r = await fetch(path);
    if (r.status === 401) throw unauthorized();
    const body = (await r.json().catch(() => null)) as (T & { error?: string }) | null;
    if (!r.ok) {
      const err = body && typeof body.error === 'string' ? body.error : `HTTP ${r.status}`;
      return { ok: false, error: err, disabled: r.status === 503 };
    }
    return { ok: true, data: body as T };
  } catch (e) {
    if (e instanceof Unauthorized) throw e; // 冒泡给调用方走统一登出
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export const fetchDeepseekUsage = () => fetchUsage<DeepseekBalance>('./api/usage/deepseek');
export const fetchBigmodelUsage = () => fetchUsage<BigmodelBalance>('./api/usage/bigmodel');

/* ---------- 登录审计日志（/api/audit/*，AuditApp）---------- */

export type AuditEventType = 'login' | 'logout' | 'unauthorized';
export type AuditTypeFilter = 'all' | AuditEventType;
export type AuditResultFilter = 'all' | 'success' | 'failure';

/** 一条审计事件（服务端 JSONL 一行的读取视图；字段全部容错，缺失即空） */
export interface AuditEvent {
  /** 事件时间（ms） */
  t: number;
  type: AuditEventType;
  ok: boolean;
  /** 失败原因：bad-password / bad-body / unauthorized / logout / ok */
  reason: string;
  /** 客户端 IP（反代下取 X-Forwarded-For 首段） */
  ip: string;
  /** 直连地址（未过代理时为同一值） */
  remoteIp: string;
  ua: string;
  path: string;
  status: number;
  durationMs?: number;
  /** 401 去重窗口内合并的次数（登录事件恒为 1） */
  count: number;
  /** 合并窗口内最后一次出现时间（登录事件与 t 相同） */
  lastSeen: number;
}

export interface AuditSource {
  ip: string;
  total: number;
  failures: number;
  firstSeen: number;
  lastSeen: number;
}

export interface AuditBruteForce {
  ip: string;
  /** 窗口内命中次数 */
  count: number;
  firstSeen: number;
  lastSeen: number;
}

export interface AuditNewSource {
  ip: string;
  firstSeen: number;
}

export interface AuditStats {
  total: number;
  success: number;
  failures: number;
  /** 失败率（百分比，一位小数） */
  failureRate: number;
  unauthorized: number;
  sources: number;
  byDay: Array<{ day: string; success: number; failures: number }>;
  byHour: Array<{ hour: number; success: number; failures: number }>;
  topSources: AuditSource[];
  recentFailures: AuditEvent[];
  anomalies: {
    bruteForce: AuditBruteForce[];
    newSources: AuditNewSource[];
  };
}

export interface AuditMeta {
  retentionDays: number;
  /** 查询范围天数，0 = 全部保留期 */
  days: number;
  limit: number;
  /** 命中服务端解析条数上限（更早的数据被截断） */
  truncated: boolean;
  dir: string;
  generatedAt: number;
  /** 疑似暴力破解判定窗口（分钟）与阈值：用于异常条目文案（服务端配置下发） */
  bruteWindowMinutes?: number;
  bruteThreshold?: number;
}

export interface AuditLogResponse {
  enabled: boolean;
  /** 目录不可写等原因（enabled 仍为 true 时也会带上） */
  error?: string;
  entries: AuditEvent[];
  stats: AuditStats;
  meta: AuditMeta;
}

export interface AuditQuery {
  days: number;
  type?: AuditTypeFilter;
  ok?: AuditResultFilter;
  ip?: string;
  limit?: number;
}

function auditQs(q: AuditQuery): string {
  const p = new URLSearchParams({
    days: String(q.days),
    type: q.type || 'all',
    ok: q.ok || 'all',
    limit: String(q.limit ?? 200),
  });
  const ip = (q.ip || '').trim();
  if (ip) p.set('ip', ip);
  return p.toString();
}

export const fetchAuditLog = (q: AuditQuery) =>
  request<AuditLogResponse>(`./api/audit/login-log?${auditQs(q)}`);

/** 从 Content-Disposition 取文件名（服务端保证带引号；解析失败回退本地日期名） */
function csvFileName(cd: string): string {
  const m = /filename="([^"]+)"/.exec(cd || '');
  return m ? m[1] : `login-log-${new Date().toISOString().slice(0, 10)}.csv`;
}

/**
 * 导出当前筛选的完整日志（CSV，不受列表 limit 限制）。
 * 用 fetch + Blob 而非 `a[href]` 直链：会话只在 HttpOnly Cookie 里，直链无法区分 401 与其它错误；
 * 与其它接口一致，401 抛 Unauthorized 交给调用方登出。
 */
export async function downloadAuditCsv(q: AuditQuery): Promise<void> {
  const r = await fetch(`./api/audit/login-log.csv?${auditQs(q)}`);
  if (r.status === 401) throw unauthorized();
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const blob = await r.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = csvFileName(r.headers.get('content-disposition') || '');
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  // 立即移除锚点 / revoke 会让部分浏览器把下载中断成「Download canceled」，
  // 等下载真正开始后再释放（4s 足够，内存占用可忽略）
  window.setTimeout(() => {
    a.remove();
    URL.revokeObjectURL(url);
  }, 4000);
}

/* ============================ 财务账本 Ledger ============================ *
 * 所有接口走相对路径 ./api/ledger/...（兼容 basePath 子路径部署），
 * 401 统一走 unauthorized() → 全局登出；错误体里的 error 字段透出给用户看。
 * 服务端只返回脱敏后的 memoClean，绝不返回 memoRaw。
 * ======================================================================== */

export interface LedgerAccount {
  accountId: number;
  accountNoMasked: string;
  bankName: string | null;
  cardType: string | null;
  currency: string;
}

export interface LedgerCategory {
  categoryId: number;
  code: string;
  domain: string;
  level1: string;
  level2: string | null;
  label: string;
  includeInStats: number;
  sortNo: number;
}

export interface LedgerMeta {
  accounts: LedgerAccount[];
  categories: LedgerCategory[];
  years: string[];
  months: string[];
  channels: string[];
  txnTypes: string[];
  domains: string[];
}

export interface LedgerStats {
  txnCount: number;
  incomeCount: number;
  expenseCount: number;
  dateMin: string | null;
  dateMax: string | null;
  lockedCount: number;
  transferPairs: number;
  categoryCount: number;
  ruleCount: number;
  accountCount: number;
  fileName: string;
  sizeBytes: number;
  mtime: string | null;
  journalMode: string;
}

export interface LedgerStatus {
  enabled: boolean;
  available: boolean;
  engine: string;
  nodeVersion: string;
  experimentalWarning: boolean;
  dbPath: string;
  stats: LedgerStats | null;
  backup: { dir: string; count: number; lastAt: string | null };
  reason: string;
}

export interface LedgerFilters {
  account?: number | 'all';
  year?: string | 'all';
  month?: string | 'all';
  day?: string;
  from?: string;
  to?: string;
  category?: string | 'all';
  domain?: string | 'all';
  direction?: 'IN' | 'OUT' | 'all';
  scope?: 'net' | 'all';
  q?: string;
  sort?: 'txn_ts' | 'txn_date' | 'amount';
  order?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
  dim?: 'period' | 'category';
  grain?: 'year' | 'month';
  topN?: number;
}

export interface LedgerTxn {
  txnId: number;
  txnDate: string;
  txnTime: string;
  txnTs: string;
  accountNoMasked: string | null;
  direction: 'IN' | 'OUT';
  incomeCent: number;
  expenseCent: number;
  amountSignedCent: number;
  balanceCent: number;
  txnType: string;
  memoClean: string | null;
  counterparty: string | null;
  channel: string | null;
  categoryCode: string | null;
  categoryLabel: string | null;
  domain: string | null;
  source: string | null;
  confidence: number | null;
  locked: number;
  isInternalTransfer: number;
}

export interface LedgerTxnResult {
  rows: LedgerTxn[];
  total: number;
  limit: number;
  offset: number;
  summary: {
    incomeCent: number;
    expenseCent: number;
    netCent: number;
    incomeCount: number;
    expenseCount: number;
  };
}

export interface LedgerReportRow {
  period?: string;
  categoryCode?: string;
  categoryLabel?: string;
  domain?: string;
  level1?: string;
  includeInStats?: number;
  incomeCent: number;
  expenseCent: number;
  netCent?: number;
  incomeCount?: number;
  expenseCount?: number;
  txnCount: number;
  expensePct?: number;
}

export interface LedgerReportResult {
  dim: string;
  grain: string;
  scope: string;
  filters: Record<string, unknown>;
  rows: LedgerReportRow[];
  totals: {
    incomeCent: number;
    expenseCent: number;
    netCent: number;
    txnCount: number;
    incomeCount: number;
    expenseCount: number;
  };
  generatedAt: number;
}

export interface LedgerPreviewRow {
  lineNo: number;
  rowHash: string;
  txnDate: string;
  txnTime: string;
  direction: 'IN' | 'OUT';
  amountCent: number;
  incomeCent: number;
  expenseCent: number;
  balanceCent: number;
  txnType: string;
  memoClean: string;
  counterparty: string | null;
  channel: string;
  categoryGuess: string;
  status: 'new' | 'exists' | 'conflict';
}

export interface LedgerPreviewResult {
  filename: string;
  account: {
    accountNoMasked: string;
    bankName: string;
    currency: string;
    periodStart: string | null;
    periodEnd: string | null;
    exportedAt: string | null;
  };
  declared: Record<string, number | null>;
  actual: Record<string, number>;
  checked: { declaredMatch: boolean; balanceChainWithinFile: boolean; chainErrors: string[] };
  warnings: string[];
  rowCount: number;
  counts: { new: number; exists: number; conflict: number };
  rows: LedgerPreviewRow[];
}

export interface LedgerBackup {
  name: string;
  kind: 'manual' | 'auto-before-import' | 'auto-before-restore';
  createdAt: string;
  sizeBytes: number;
  txnCount: number | null;
  dateMin: string | null;
  dateMax: string | null;
  lockedCount: number | null;
  transferPairs: number | null;
  sha256: string | null;
  isPreRestoreSafety: boolean;
}

export interface LedgerCommitResult {
  batchId: number;
  inserted: number;
  skipped: number;
  conflicts: number;
  classified: number;
  lowConfidence: number;
  transferPairs: number;
  autoBackup: LedgerBackup | null;
  stats: { txnCount: number };
  warnings: string[];
}

export interface LedgerRestoreResult extends LedgerStats {
  restored: boolean;
  preRestoreBackup: LedgerBackup;
  warnings: string[];
}

/** 与后端共用的请求封装：401 全局登出，其余错误透出 {error} 文本。 */
async function ledgerRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, init);
  if (r.status === 401) throw unauthorized();
  if (!r.ok) {
    let msg = `HTTP ${r.status}`;
    try {
      const d = (await r.json()) as { error?: string };
      if (d && d.error) msg = d.error;
    } catch { /* 非 JSON 错误体沿用状态码 */ }
    throw new Error(msg);
  }
  return r.json() as Promise<T>;
}

async function ledgerDownload(url: string, init?: RequestInit): Promise<void> {
  const r = await fetch(url, init);
  if (r.status === 401) throw unauthorized();
  if (!r.ok) {
    let msg = `HTTP ${r.status}`;
    try {
      const d = (await r.json()) as { error?: string };
      if (d && d.error) msg = d.error;
    } catch { /* 忽略 */ }
    throw new Error(msg);
  }
  const blob = await r.blob();
  const cd = r.headers.get('content-disposition') || '';
  const m = /filename="([^"]+)"/.exec(cd);
  const href = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = href;
  a.download = m ? m[1] : `ledger-${new Date().toISOString().slice(0, 10)}.db`;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  window.setTimeout(() => {
    a.remove();
    URL.revokeObjectURL(href);
  }, 4000);
}

function ledgerQs(f: LedgerFilters): string {
  const p = new URLSearchParams();
  const keys: (keyof LedgerFilters)[] = [
    'account', 'year', 'month', 'day', 'from', 'to', 'category', 'domain',
    'direction', 'scope', 'q', 'sort', 'order', 'limit', 'offset',
    'dim', 'grain', 'topN',
  ];
  for (const k of keys) {
    const v = f[k];
    if (v === undefined || v === null || v === '' || v === 'all') continue;
    p.set(k, String(v));
  }
  return p.toString();
}

const jsonPost = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

export const fetchLedgerStatus = () => ledgerRequest<LedgerStatus>('./api/ledger/status');
export const fetchLedgerMeta = () => ledgerRequest<LedgerMeta>('./api/ledger/meta');

export const previewImport = (filename: string, text: string) =>
  ledgerRequest<LedgerPreviewResult>('./api/ledger/import/preview', jsonPost({ filename, text }));

export const commitImport = (filename: string, text: string, selected: string[]) =>
  ledgerRequest<LedgerCommitResult>(
    './api/ledger/import/commit', jsonPost({ filename, text, selected })
  );

export const fetchImportBatches = (limit = 20) =>
  ledgerRequest<{ batches: Array<Record<string, unknown>> }>(`./api/ledger/import/batches?limit=${limit}`);

export const fetchLedgerTxns = (f: LedgerFilters) =>
  ledgerRequest<LedgerTxnResult>(`./api/ledger/transactions?${ledgerQs(f)}`);

export const downloadLedgerTxnsCsv = (f: LedgerFilters) =>
  ledgerDownload(`./api/ledger/transactions.csv?${ledgerQs(f)}`);

export const setLedgerCategory = (txnIds: number[], categoryCode: string, unlock = false) =>
  ledgerRequest<{ updated: number; locked: boolean }>('./api/ledger/classification', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ txnIds, categoryCode, unlock }),
  });

export const fetchLedgerReport = (f: LedgerFilters) =>
  ledgerRequest<LedgerReportResult>(`./api/ledger/report?${ledgerQs(f)}`);

export const downloadLedgerReportCsv = (f: LedgerFilters) =>
  ledgerDownload(`./api/ledger/report.csv?${ledgerQs(f)}`);

export const fetchLedgerDbInfo = () =>
  ledgerRequest<LedgerStats & { backupDir: string; backupCount: number; backupKeep: number }>(
    './api/ledger/db/info'
  );

export const fetchLedgerBackups = (limit = 50) =>
  ledgerRequest<{ backups: LedgerBackup[]; dir: string; keep: number }>(
    `./api/ledger/db/backups?limit=${limit}`
  );

export const createLedgerBackup = () =>
  ledgerRequest<{ backup: LedgerBackup }>('./api/ledger/db/backup', jsonPost({ kind: 'manual' }));

export const downloadLedgerBackup = (name: string) =>
  ledgerDownload(`./api/ledger/db/backup?name=${encodeURIComponent(name)}`);

export const downloadCurrentDb = () => ledgerDownload('./api/ledger/db/current.db');

export const deleteLedgerBackup = (name: string) =>
  ledgerRequest<{ deleted: string }>(
    `./api/ledger/db/backup?name=${encodeURIComponent(name)}`, { method: 'DELETE' }
  );

export const restoreLedgerBackup = (name: string) =>
  ledgerRequest<LedgerRestoreResult>(
    './api/ledger/db/restore', jsonPost({ name, confirm: true })
  );

/** 上传本地 .db 文件恢复：raw body 直传二进制（项目无 multipart）。 */
export const uploadLedgerBackup = (file: File) =>
  ledgerRequest<LedgerRestoreResult>('./api/ledger/db/restore?upload=1', {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: file,
  });
