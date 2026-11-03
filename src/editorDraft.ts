/**
 * 编辑器自动草稿的写入调度器（纯 TS，不依赖 React / DOM，可直接单测）。
 *
 * 为什么单独抽出来：草稿的时序（防抖、长按不饿死、单飞合并、保存后删除与在途写的顺序）
 * 是最容易写错、也最难用手点浏览器验证的部分。这里只负责「什么时候发什么请求」，
 * 存储格式与鉴权在服务端 / api.ts。
 *
 * 关键约束：
 *  - 单飞：同时最多 1 个写请求在途；在途期间的新变化只记最新快照，不在每次按键都排队。
 *  - 不饿死：持续打字时 debounce 永远不到点，故用 maxWaitMs 兜底强制落盘。
 *  - 先写后删：保存成功后的 discard 不能抢在在途写之前，否则删完又被写回来。
 *  - 失败不自动重试：失败后暂停，等下一次内容变化或 flush() 再试（离线时不能打点风暴）。
 */
export interface DraftPayload {
  path: string;
  content: string;
  baseMtime: number | null;
}

export interface DraftAutosaveDeps {
  /** 写入草稿（生产环境 = draftsPut） */
  write: (p: DraftPayload) => Promise<unknown>;
  /** 删除草稿（生产环境 = draftsDeleteByPath，幂等） */
  remove: (path: string) => Promise<unknown>;
  /** 业务失败回调：仅在「成功 → 失败」与「失败 → 成功」两个跳变点各触发一次，避免刷屏。
   *  401 不在这里处理——api.ts 会走全局 notifyUnauthorized，异常原样上抛。 */
  onError?: (err: unknown) => void;
  debounceMs?: number;
  maxWaitMs?: number;
}

export interface DraftAutosave {
  /** 内容变化：合并为最新快照并重置防抖计时 */
  schedule: (p: DraftPayload) => void;
  /** 该文档已无未保存改动（保存成功 / undo 回基线 / 用户丢弃）→ 删远端草稿 */
  discard: (path: string) => void;
  /** 立即落盘并等待队列排空（隐藏 / 卸载 / 切文件 / 关窗） */
  flush: () => Promise<void>;
  pending: () => boolean;
  dispose: () => void;
}

const DEFAULT_DEBOUNCE = 2000;
const DEFAULT_MAX_WAIT = 15000;
const MAX_CARRY = 4; // 极端情况下连续切多个文件，只保留最近几份，避免无界增长

export function createDraftAutosave(deps: DraftAutosaveDeps): DraftAutosave {
  const debounceMs = deps.debounceMs ?? DEFAULT_DEBOUNCE;
  const maxWaitMs = deps.maxWaitMs ?? DEFAULT_MAX_WAIT;

  let latest: DraftPayload | null = null;
  /** 切文件时被顶下来的旧文档快照：必须先写它，否则旧草稿永远停在更早的版本 */
  const carry: DraftPayload[] = [];
  /** 待删除的路径（保存成功 / 显式丢弃）；写在它之前的 pending 落完后执行 */
  const dead = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let firstAt = 0;
  let running = false;
  let disposed = false;
  let blocked = false; // 上次写失败后暂停自动重试
  let erroring = false;
  let lastWritten: { path: string; content: string } | null = null;
  let waiters: Array<() => void> = [];

  const clearTimer = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const hasWork = () => latest !== null || carry.length > 0 || dead.size > 0;

  const settleIfIdle = () => {
    if (running || hasWork()) return;
    firstAt = 0;
    const ws = waiters;
    waiters = [];
    ws.forEach((w) => w());
  };

  const notifyError = (err: unknown | null) => {
    if (err === null) {
      if (erroring) {
        erroring = false;
        deps.onError?.(null);
      }
      return;
    }
    if (!erroring) {
      erroring = true;
      deps.onError?.(err);
    }
  };

  /** 取下一个要执行的动作：先写旧文档（carry），再写最新快照，最后删已废弃的草稿 */
  const nextTask = (): { kind: 'write'; payload: DraftPayload } | { kind: 'remove'; path: string } | null => {
    if (carry.length > 0) return { kind: 'write', payload: carry.shift() as DraftPayload };
    if (latest) {
      const p = latest;
      latest = null;
      return { kind: 'write', payload: p };
    }
    const first = dead.values().next();
    if (!first.done) {
      dead.delete(first.value);
      return { kind: 'remove', path: first.value };
    }
    return null;
  };

  const pump = async (): Promise<void> => {
    if (disposed || running || blocked) {
      settleIfIdle();
      return;
    }
    const task = nextTask();
    if (!task) {
      settleIfIdle();
      return;
    }
    running = true;
    try {
      if (task.kind === 'write') {
        const p = task.payload;
        const same = lastWritten && lastWritten.path === p.path && lastWritten.content === p.content;
        if (!same) {
          await deps.write(p);
          lastWritten = { path: p.path, content: p.content };
        }
      } else {
        await deps.remove(task.path);
        if (lastWritten && lastWritten.path === task.path) lastWritten = null;
      }
      notifyError(null);
    } catch (e) {
      // 失败：把本次快照放回队首（若期间已有同路径的更新快照则以更新的为准），并暂停自动重试
      if (task.kind === 'write') {
        if (!latest || latest.path !== task.payload.path) {
          if (latest) carry.unshift(latest);
          latest = task.payload;
        }
      }
      blocked = true;
      notifyError(e);
    } finally {
      running = false;
    }
    if (!blocked) {
      await pump();
      return;
    }
    /* 失败后暂停：把等待中的 flush 放行（失败已通过 onError 上报），内容留在 latest 里等下次触发 */
    firstAt = 0;
    const ws = waiters;
    waiters = [];
    ws.forEach((w) => w());
  };

  const kick = () => {
    void pump();
  };

  const arm = () => {
    clearTimer();
    const now = Date.now();
    if (!firstAt) firstAt = now;
    const sinceFirst = now - firstAt;
    if (sinceFirst >= maxWaitMs) {
      kick();
      return;
    }
    // 防抖与 maxWait 取较小者：持续打字时也能在 maxWait 到点强制落盘
    const delay = Math.max(0, Math.min(debounceMs, maxWaitMs - sinceFirst));
    timer = setTimeout(() => {
      timer = null;
      kick();
    }, delay);
  };

  return {
    schedule(p: DraftPayload) {
      if (disposed) return;
      blocked = false;
      if (latest && latest.path !== p.path) {
        carry.push(latest);
        while (carry.length > MAX_CARRY) carry.shift();
      }
      latest = p;
      arm();
    },

    discard(path: string) {
      if (disposed) return;
      blocked = false;
      if (latest && latest.path === path) latest = null;
      for (let i = carry.length - 1; i >= 0; i -= 1) {
        if (carry[i].path === path) carry.splice(i, 1);
      }
      dead.add(path);
      kick();
    },

    flush() {
      if (disposed) return Promise.resolve();
      blocked = false;
      clearTimer();
      if (!hasWork() && !running) return Promise.resolve();
      const done = new Promise<void>((resolve) => waiters.push(resolve));
      kick();
      return done;
    },

    pending() {
      return hasWork() || running;
    },

    dispose() {
      disposed = true;
      clearTimer();
      const ws = waiters;
      waiters = [];
      ws.forEach((w) => w());
    },
  };
}
