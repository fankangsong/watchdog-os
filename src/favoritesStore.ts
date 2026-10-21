// 收藏夹外部 store：数据源为服务端 /api/fs/favorites（持久化在用户目录 ~/.watchdog-os/data.json），
// 主窗口、收藏夹列表窗口、收藏目标文件夹窗口（多个 FinderBrowser 实例）共享同一份数据。
// 用法：useFavorites() 订阅列表；addFavorites / removeFavorites / toggleFavorite 变更
// （乐观更新 → PUT 全量列表 → 以服务端规范化结果为准；失败回滚并抛出，由调用方弹 alert）。
//
// 竞态防护（曾出现「添加 B 覆盖了刚添加的 A」，见 docs/tasks.md 与 test/test-favorites-store.mjs）：
//   1. 变更先 await ensureLoaded()——服务端 favorites 是全量替换语义，未加载就 PUT 等于盲写覆盖；
//   2. 变更进串行队列、next 列表在队列内基于最新状态计算——并发添加互不丢失、PUT 不交错；
//   3. 加载响应带世代号：加载期间发生过提交则丢弃过期响应，避免后落地的旧列表覆盖新状态；
//   4. 加载失败时变更原样报错（调用方已有 alert 提示），不做破坏性写入。
import { useSyncExternalStore } from 'react';
import { fsGetFavorites, fsSetFavorites } from './api';

let favorites: string[] = [];
let loaded = false; // 已成功加载（失败不置位，由后续订阅 / 变更重试）
let loading: Promise<void> | null = null;
let loadError: Error | null = null; // 最近一次加载失败原因（变更入口据此报错）
let stateSeq = 0; // favorites 每次被改写即 +1；用于丢弃加载期间的过期 GET 响应
let queue: Promise<unknown> = Promise.resolve(); // 变更串行队列
const listeners = new Set<() => void>();

function emit() {
  for (const fn of listeners) fn();
}

/** 惰性加载：首个订阅触发一次 GET；失败保持未加载（当次调用链内不重试，下次订阅 / 变更时再试） */
function ensureLoaded(): Promise<void> {
  if (loaded) return Promise.resolve();
  if (!loading) {
    const seq = stateSeq;
    loading = fsGetFavorites()
      .then((r) => {
        // 加载期间若已发生提交（提交已按服务端返回同步），丢弃本次过期响应，避免覆盖新状态
        if (stateSeq === seq) favorites = Array.isArray(r.favorites) ? r.favorites : [];
        loaded = true;
        loadError = null;
      })
      .catch((e) => {
        loadError = e instanceof Error ? e : new Error(String(e));
      })
      .finally(() => {
        loading = null;
        emit();
      });
  }
  return loading;
}

function subscribeFavorites(onChange: () => void): () => void {
  listeners.add(onChange);
  void ensureLoaded(); // 订阅路径静默：加载失败保持空列表，下次订阅 / 变更时重试
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
  stateSeq += 1;
  emit();
  try {
    const r = await fsSetFavorites(next);
    favorites = r.favorites; // 服务端会去重/过滤越界路径/截断上限，以其结果为准
    stateSeq += 1;
  } catch (e) {
    favorites = prev;
    stateSeq += 1;
    throw e;
  } finally {
    emit();
  }
}

/** 变更入口：串行执行 + 先确保已加载（加载失败则本次变更报错，不做破坏性盲写） */
function mutate<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(async () => {
    await ensureLoaded();
    if (!loaded) throw loadError ?? new Error('Favorites not loaded');
    return fn();
  });
  // 队列继续向下传递；单次变更失败不影响后续变更（失败由调用方的 promise 感知）
  queue = run.then(
    () => {},
    () => {}
  );
  return run;
}

export function addFavorites(paths: string[]): Promise<void> {
  return mutate(async () => {
    const next = [...favorites];
    for (const p of paths) if (!next.includes(p)) next.push(p);
    await commit(next);
  });
}

export function removeFavorites(paths: string[]): Promise<void> {
  return mutate(async () => {
    const drop = new Set(paths);
    await commit(favorites.filter((p) => !drop.has(p)));
  });
}

/** 切换收藏态：已收藏移出，未收藏加入（判定放在队列内，避免竞态下切反） */
export function toggleFavorite(path: string): Promise<void> {
  return mutate(() =>
    commit(favorites.includes(path) ? favorites.filter((p) => p !== path) : [...favorites, path])
  );
}
