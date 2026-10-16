// 收藏夹外部 store：数据源为服务端 /api/fs/favorites（持久化在用户目录 ~/.watchdog-os/data.json），
// 主窗口、收藏夹列表窗口、收藏目标文件夹窗口（多个 FinderBrowser 实例）共享同一份数据。
// 用法：useFavorites() 订阅列表；addFavorites / removeFavorites / toggleFavorite 变更
// （乐观更新 → PUT 全量列表 → 以服务端规范化结果为准；失败回滚并抛出，由调用方弹 alert）。
import { useSyncExternalStore } from 'react';
import { fsGetFavorites, fsSetFavorites } from './api';

let favorites: string[] = [];
let loaded = false;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const fn of listeners) fn();
}

/** 惰性加载：首个订阅触发一次 GET；失败保持空列表（当次页面生命周期内不重试） */
function ensureLoaded(): Promise<void> {
  if (loaded) return Promise.resolve();
  if (!loading) {
    loading = fsGetFavorites()
      .then((r) => {
        favorites = Array.isArray(r.favorites) ? r.favorites : [];
      })
      .catch(() => {
        /* 加载失败（网络异常/未登录）：保持空列表 */
      })
      .finally(() => {
        loaded = true;
        loading = null;
        emit();
      });
  }
  return loading;
}

function subscribeFavorites(onChange: () => void): () => void {
  listeners.add(onChange);
  void ensureLoaded();
  return () => {
    listeners.delete(onChange);
  };
}

function getFavorites(): string[] {
  return favorites;
}

/** 订阅收藏夹路径列表（数组引用稳定，仅在变更时替换） */
export function useFavorites(): string[] {
  return useSyncExternalStore(subscribeFavorites, getFavorites, getFavorites);
}

export function isFavorite(path: string): boolean {
  return favorites.includes(path);
}

/** 写回服务端；失败回滚本地列表并抛出（调用方负责提示） */
async function commit(next: string[]): Promise<void> {
  const prev = favorites;
  favorites = next;
  emit();
  try {
    const r = await fsSetFavorites(next);
    favorites = r.favorites; // 服务端会去重/过滤越界路径/截断上限，以其结果为准
  } catch (e) {
    favorites = prev;
    throw e;
  } finally {
    emit();
  }
}

export async function addFavorites(paths: string[]): Promise<void> {
  const next = [...favorites];
  for (const p of paths) if (!next.includes(p)) next.push(p);
  await commit(next);
}

export async function removeFavorites(paths: string[]): Promise<void> {
  const drop = new Set(paths);
  await commit(favorites.filter((p) => !drop.has(p)));
}

/** 切换收藏态：已收藏移出，未收藏加入 */
export async function toggleFavorite(path: string): Promise<void> {
  if (isFavorite(path)) await removeFavorites([path]);
  else await addFavorites([path]);
}
