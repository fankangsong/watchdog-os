// 后端 API 封装：全部使用相对路径，兼容任意 basePath 部署

export interface HealthInfo {
  ok: boolean;
  basePath: string;
  hostname: string;
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

export const fsWrite = (path: string, content: string) =>
  request<{ ok: true; size: number; mtime: number }>(`./api/fs/write?path=${enc(path)}`, {
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

export const fsGetFavorites = () => request<{ favorites: string[] }>('./api/fs/favorites');

export const fsSetFavorites = (favorites: string[]) =>
  request<{ ok: true; favorites: string[] }>('./api/fs/favorites', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ favorites }),
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
    xhr.onerror = () => reject(new Error('网络错误，上传失败'));
    xhr.onabort = () => reject(new Error('上传已取消'));
    xhr.send(file);
  });
  return { promise, abort: () => xhr.abort() };
}
