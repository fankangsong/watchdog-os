// 网络挂载外部 store：数据源为服务端 /api/mounts（连接配置持久化在 ~/.watchdog-os/data.json，
// 密码单独存 600 凭据文件）。多个 FinderBrowser 实例共享同一份连接列表与能力矩阵。
//
// 状态刷新策略：
//   1. 惰性加载：首个订阅触发一次 GET（失败保持未加载，下次订阅/变更再试）；
//   2. 变更（增/删/挂/卸）后 revalidate() 重新 GET，以服务端为准；
//   3. 挂载状态轮询：只要存在已配置连接或当前不可知，就每 8s 静默 GET 一次刷新 mounted 标志
//      （外部 umount / 网络断开导致的掉线也能被发现）。仅在主窗口订阅时轮询，避免多窗口重复请求。
import { useSyncExternalStore } from 'react';
import {
  mountsList,
  type MountCaps,
  type MountConnection,
  type MountInput,
} from './api';

let connections: MountConnection[] = [];
let caps: MountCaps | null = null;
let loaded = false;
let loading: Promise<void> | null = null;
let stateSeq = 0;
let subscriberCount = 0;
let pollTimer: ReturnType<typeof setInterval> | null = null;
const POLL_MS = 8000;
const listeners = new Set<() => void>();

function emit() {
  for (const fn of listeners) fn();
}

/** 拉取一次服务端状态；seq 校验避免并发请求旧结果覆盖新状态 */
async function fetchOnce(): Promise<void> {
  const seq = stateSeq;
  try {
    const r = await mountsList();
    if (seq === stateSeq) {
      connections = Array.isArray(r.connections) ? r.connections : [];
      caps = r.caps || null;
      loaded = true;
    }
  } catch {
    // 加载失败保持未加载；下次订阅/变更会重试，界面维持上次状态（stale-while-revalidate）
  }
}

function ensureLoaded(): Promise<void> {
  if (loaded) return Promise.resolve();
  if (!loading) {
    loading = fetchOnce().finally(() => {
      loading = null;
      emit();
    });
  }
  return loading;
}

/** 强制重新拉取（变更后调用；不阻塞调用方） */
export function revalidateMounts(): Promise<void> {
  stateSeq += 1;
  return fetchOnce().then(emit);
}

function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(() => {
    // 页面隐藏时不轮询，省流量；后台标签被浏览器限速也无所谓
    if (typeof document !== 'undefined' && document.hidden) return;
    void revalidateMounts();
  }, POLL_MS);
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  subscriberCount += 1;
  void ensureLoaded();
  startPolling();
  return () => {
    listeners.delete(onChange);
    subscriberCount -= 1;
    if (subscriberCount <= 0) stopPolling();
  };
}

function getConnections(): MountConnection[] {
  return connections;
}

function getCaps(): MountCaps | null {
  return caps;
}

/** 订阅连接列表（数组引用稳定，仅变更时替换） */
export function useMountConnections(): MountConnection[] {
  return useSyncExternalStore(subscribe, getConnections, getConnections);
}

/** 订阅能力矩阵 */
export function useMountCaps(): MountCaps | null {
  return useSyncExternalStore(subscribe, getCaps, getCaps);
}

/** 新增连接（乐观触发 revalidate；失败抛出由调用方提示） */
export async function addMount(input: MountInput): Promise<void> {
  const { mountsCreate } = await import('./api');
  await mountsCreate(input);
  await revalidateMounts();
}

/** 更新连接 */
export async function updateMount(id: string, input: MountInput): Promise<void> {
  const { mountsUpdate } = await import('./api');
  await mountsUpdate(id, input);
  await revalidateMounts();
}

/** 删除连接（服务端会先卸载） */
export async function removeMount(id: string): Promise<void> {
  const { mountsDelete } = await import('./api');
  await mountsDelete(id);
  await revalidateMounts();
}

/** 挂载连接 */
export async function mountConnection(id: string): Promise<void> {
  const { mountsMount } = await import('./api');
  await mountsMount(id);
  await revalidateMounts();
}

/** 卸载连接 */
export async function unmountConnection(id: string): Promise<void> {
  const { mountsUnmount } = await import('./api');
  await mountsUnmount(id);
  await revalidateMounts();
}
