import { useSyncExternalStore } from 'react';
import { Unauthorized } from './api';

/**
 * 应用级共享轮询（按启用中的订阅者启停）：
 * 各 App 用 useAppOpen(APP_ID) 判断是否已启动，只在启动期间以 enabled=true 订阅；
 * 没有任何启用中的订阅者（应用未启动 / 已 Quit）时定时器停转、不发请求，
 * 数据保留在 store 中，应用重新打开时新订阅会立即首拉一次并续轮。
 *
 * 401（会话失效）时停止避免风暴，重新登录后由新订阅自动重启；
 * 另含暂停 / 改间隔 / 慢接口防叠加。与 favoritesStore 同一模式：
 * 模块状态 + useSyncExternalStore 订阅。
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
  /** 立即刷新一次（暂停 / 无订阅者 / 已停止时为 no-op，对齐旧 usePolling 行为） */
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

  /** 启动 / 恢复轮询：无启用订阅者、暂停或已停止时不动定时器；启动时立即拉一次，不必等一个间隔 */
  function ensureRunning() {
    if (listeners.size === 0 || stopped || state.paused || timer != null) return;
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
        // 最后一个启用中的订阅者退出（应用 Quit / 未启动）→ 停转定时器，不发请求。
        // 数据保留：应用重新打开时新订阅会立即首拉并续轮。
        if (listeners.size === 0 && timer != null) {
          clearInterval(timer);
          timer = null;
        }
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
      if (listeners.size === 0 || stopped || state.paused) return;
      void tick();
    },
  };
}

/** 未启用时的空订阅：保持 subscribe 引用稳定，避免 enabled 不变时 useSyncExternalStore 反复重订阅 */
const NOOP_SUBSCRIBE = () => () => {};

/**
 * 订阅共享轮询：enabled 由所属应用的启动状态决定（见 useAppOpen）。
 * enabled=false 时不注册订阅者，即不触发任何请求；切换时 React 会自动重订阅。
 */
export function useSharedPoll<T>(poll: SharedPoll<T>, enabled = true): SharedPollState<T> {
  return useSyncExternalStore(enabled ? poll.subscribe : NOOP_SUBSCRIBE, poll.getSnapshot, poll.getSnapshot);
}
