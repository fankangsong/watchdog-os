// Files（srv-finder.app）应用偏好外部 store：目前只有「收藏夹侧栏是否展开」一项。
// 落盘服务端 ~/.watchdog-os/data.json 的 finder 键（GET/PUT /api/prefs/finder），
// 跨浏览器 / 重部署生效（与 Editor 视图偏好走同一条偏好通道）。
//
// 语义要点：
//   1. 键缺失 = 展开。首次打开 Files 即呈现「盘符根列表 + Favorites 侧栏」，
//      且不为从未切换过的用户产生任何写盘（GET 不写、PUT 仅在差异时发）。
//   2. 惰性单次加载：首个订阅触发一次 GET，模块级缓存——多窗口实例 / 窗口重开不重复请求，
//      也不会每次打开都先闪一下「默认展开」再按服务端值收起（同一会话内）。
//   3. 竞态防护（参照 src/favoritesStore.ts 与 EditorApp 视图偏好的既有做法）：
//      · mutated：加载返回前用户已切换过 → 以本地为准，加载完成后把本地值推送上去；
//      · pushed：最近一次已知的服务端快照，与本地值相同则跳过 PUT（去重）；
//      · pushChain：推送串行执行，避免连点开关时 PUT 乱序落地。
//   4. 失败不惊动界面：GET 失败保持默认展开（下次订阅重试），PUT 失败仅告警不回滚
//      （偏好丢失优于界面错乱），下次切换自然重试。401 由 api.ts 的 request() 统一收尾。
import { useSyncExternalStore } from 'react';
import type { FinderServerPrefs } from './api';
import { prefsGetFinder, prefsSetFinder } from './api';

export interface FinderPrefs {
  /** 主窗口左侧 Favorites 侧栏是否展开（缺省 = 展开） */
  showFavoritesSidebar: boolean;
}

/** 未设置即展开：首次打开 Files 就要看到 Favorites 目录 */
const DEFAULT_PREFS: FinderPrefs = { showFavoritesSidebar: true };

let prefs: FinderPrefs = { ...DEFAULT_PREFS };
let loaded = false; // 已成功拿到服务端快照（失败不置位，由后续订阅 / 变更重试）
let loading: Promise<void> | null = null;
let mutated = false; // 加载返回前本地已变更（此时本地胜出，加载结果不再覆盖）
let pushed: FinderServerPrefs = {}; // 最近一次已知的服务端快照（推送去重）
let pushChain: Promise<unknown> = Promise.resolve(); // 推送串行链
const listeners = new Set<() => void>();

function emit() {
  for (const fn of listeners) fn();
}

/** 把本地值推给服务端（与服务端快照相同则跳过，避免无意义写盘） */
function pushPrefs(): void {
  if (pushed.showFavoritesSidebar === prefs.showFavoritesSidebar) return;
  pushChain = pushChain.then(async () => {
    // 队列内再比对一次：连点开关时前一次 PUT 可能已把服务端写成最新值
    if (pushed.showFavoritesSidebar === prefs.showFavoritesSidebar) return;
    try {
      const r = await prefsSetFinder({ showFavoritesSidebar: prefs.showFavoritesSidebar });
      pushed = r.finder || {};
    } catch (e) {
      // 不回滚 UI：失败后 pushed 保持旧值，下次切换会重试
      console.warn('[finderPrefs] save failed', e);
    }
  });
}

/** 惰性加载：首个订阅触发一次 GET；失败保持未加载（默认值继续生效） */
function ensureLoaded(): Promise<void> {
  if (loaded) return Promise.resolve();
  if (!loading) {
    loading = prefsGetFinder()
      .then((r) => {
        const s = r.finder || {};
        pushed = s;
        // 本地已变更（加载期间用户点过开关）则本地胜出，把本地值补推上去
        if (mutated) {
          pushPrefs();
        } else if (typeof s.showFavoritesSidebar === 'boolean') {
          if (prefs.showFavoritesSidebar !== s.showFavoritesSidebar) {
            prefs = { showFavoritesSidebar: s.showFavoritesSidebar };
            emit();
          }
        }
        loaded = true;
      })
      .catch((e) => {
        console.warn('[finderPrefs] load failed; keeping default', e);
      })
      .finally(() => {
        loading = null;
      });
  }
  return loading;
}

function subscribeFinderPrefs(onChange: () => void): () => void {
  listeners.add(onChange);
  void ensureLoaded();
  return () => {
    listeners.delete(onChange);
  };
}

function getFinderPrefs(): FinderPrefs {
  return prefs;
}

/** 订阅 Files 偏好（对象引用稳定，仅在变更时替换） */
export function useFinderPrefs(): FinderPrefs {
  return useSyncExternalStore(subscribeFinderPrefs, getFinderPrefs, getFinderPrefs);
}

/** 切换收藏夹侧栏显隐：乐观更新 + 通知订阅者，随后异步落盘（不抛错） */
export function setShowFavoritesSidebar(v: boolean): void {
  if (prefs.showFavoritesSidebar === v) return;
  mutated = true;
  prefs = { showFavoritesSidebar: v };
  emit();
  // 先确保已加载再推送：未加载就 PUT 虽为部分合并（不会冲掉其它键），
  // 但会让「加载返回后覆盖本地」的判定与推送顺序变得难以推理
  void ensureLoaded().then(() => pushPrefs());
}
