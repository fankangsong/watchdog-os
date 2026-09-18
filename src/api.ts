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
    super('未授权');
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

export async function login(password: string): Promise<void> {
  const r = await fetch('./api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  if (r.status === 401) throw new Error('密码错误');
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
}

export async function logout(): Promise<void> {
  await fetch('./api/logout', { method: 'POST' }).catch(() => {});
}
