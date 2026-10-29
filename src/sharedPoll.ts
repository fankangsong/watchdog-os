import { useSyncExternalStore } from 'react';
import { Unauthorized } from './api';

/**
 * 页面级共享轮询（与 app 窗口开闭解耦）——docs/tasks.md：
 * metrics / processes / docker / printer 的轮询曾挂在 App 组件内（usePolling），
 * 生命周期受 classicy 窗口 / 应用开关影响（「APP 退出就不再轮询」）。本 store 把轮询
 * 收敛为模块级单例，生命周期等同页面：登录后首个订阅即启动，退出应用 / 关闭窗口
 * 不再停止；仅会话失效（401）时停止，重新登录后由新订阅自动重启。
 *
 * 与 favoritesStore 同一模式：模块状态 + useSyncExternalStore 订阅。
 */
export interface SharedPollState<T> {
  data: T | null;
  error: Error | null;
  /** 用户暂停：定时器停转、保留数据，Resume 恢复（刷新控件在暂停中为 no-op） */
  paused: boolean;
  /** 当前轮询间隔（ms） */
  intervalMs: number;
}

export interface SharedPoll<T> {
  subscribe: (onStoreChange: () => void) => () => void;
  getSnapshot: () => SharedPollState<T>;
  setPaused: (paused: boolean) => void;
  setIntervalMs: (ms: number) => void;
  /** 立即刷新一次（暂停 / 已停止时为 no-op，对齐旧 usePolling 行为） */
  reload: () => void;
}

export function createSharedPoll<T>(
  fetcher: () => Promise<T>,
  options: { intervalMs: number }
): SharedPoll<T> {
  let state: SharedPollState<T> = {
    data: null,
    error: null,
    paused: false,
    intervalMs: Math.max(200, options.intervalMs),
  };
  let timer: ReturnType<typeof setInterval> | null = null;
  let stopped = false; // 会话失效（401）后停止，待重新订阅（重登）重启
  let inFlight = false; // 慢接口保护：上一次未返回则跳过本轮，不叠加请求
  const listeners = new Set<() => void>();

  const emit = () => {
    for (const fn of listeners) fn();
  };
  const patch = (p: Partial<SharedPollState<T>>) => {
    state = { ...state, ...p };
    emit();
  };

  async function tick() {
    if (inFlight || stopped) return;
    inFlight = true;
    try {
      const d = await fetcher();
      patch({ data: d, error: null });
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      patch({ error: err });
      if (err instanceof Unauthorized) {
        // 会话失效：停止轮询避免 401 风暴；重新登录后新订阅会重置并重启
        stopped = true;
        if (timer != null) {
          clearInterval(timer);
          timer = null;
        }
      }
    } finally {
      inFlight = false;
    }
  }

  /** 启动 / 恢复轮询：暂停或已停止时不动定时器；启动时立即拉一次，不必等一个间隔 */
  function ensureRunning() {
    if (stopped || state.paused || timer != null) return;
    timer = setInterval(tick, state.intervalMs);
    void tick();
  }

  return {
    subscribe(onStoreChange) {
      listeners.add(onStoreChange);
      stopped = false; // 新订阅（如重新登录后的桌面重建）重置停止标记
      // 新订阅 = 新会话：清掉上一会话遗留的 401。
      // 否则组件挂载时读到旧的 Unauthorized 会立刻触发「登出」副作用
      // （表现为「刚登录就被踢出 / 登录后自动调一次 logout」）。
      // 这里直接改状态而不 emit：订阅者紧接着就会 getSnapshot 读到新值，
      // 在 subscribe 期间通知监听器反而会引发重入渲染。
      if (state.error) state = { ...state, error: null };
      ensureRunning();
      return () => {
        listeners.delete(onStoreChange);
        // 注意：不因「最后一个订阅者退出」而停止——轮询生命周期等同页面，
        // 退出 app / 关闭窗口不得中断（这正是本 store 的存在理由）。
      };
    },
    getSnapshot: () => state,
    setPaused(paused) {
      if (state.paused === paused) return;
      patch({ paused });
      if (paused) {
        if (timer != null) {
          clearInterval(timer);
          timer = null;
        }
      } else {
        ensureRunning();
      }
    },
    setIntervalMs(intervalMs) {
      const ms = Math.max(200, intervalMs);
      if (state.intervalMs === ms) return;
      patch({ intervalMs: ms });
      if (timer != null) {
        clearInterval(timer); // 新间隔立即生效（重启定时器并立刻拉一次）
        timer = null;
      }
      ensureRunning();
    },
    reload() {
      if (!stopped && !state.paused) void tick();
    },
  };
}

/** 订阅页面级共享轮询（退出 app / 关闭窗口不中断轮询，重开即有最新数据） */
export function useSharedPoll<T>(poll: SharedPoll<T>): SharedPollState<T> {
  return useSyncExternalStore(poll.subscribe, poll.getSnapshot, poll.getSnapshot);
}
