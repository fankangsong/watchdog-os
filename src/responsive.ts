/**
 * 断点层：手机 / 平板 / 桌面三档布局。
 *
 * 设计约束（详见 docs/mobile-adaptation.md）：
 * - **纯函数 + 单例订阅**：判定逻辑 `layoutForWidth` 不依赖 DOM，可直接在 Node 里测；
 *   浏览器侧只用一份 `matchMedia` / `resize` 监听，避免每个组件各挂一个监听器。
 * - **副作用写在 `<html>` 上**：布局档位落到 `data-wd-layout`，动态视口高度落到 `--wd-vv-h`，
 *   样式层因此只需按属性作用域覆盖，不必给每个组件传 layout。
 * - **服务端 / 无 matchMedia 环境安全回退 desktop**：登录页与桌面均按原样渲染。
 */
import { useSyncExternalStore } from 'react';

export type WdLayout = 'mobile' | 'tablet' | 'desktop';

export interface Viewport {
  /** 布局档位：mobile <768、tablet 768~1024、desktop >1024 */
  layout: WdLayout;
  width: number;
  height: number;
  /** 粗指针（手机 / 平板），用于放大触控目标与输入框字号 */
  isTouch: boolean;
}

/** 手机上限（不含）：767 及以下算 mobile，768 起算 tablet（对齐 CSS 的 min-width:768px） */
export const MOBILE_MAX_WIDTH = 767;
/** 平板上限（含）：1024 及以下算 tablet */
export const TABLET_MAX_WIDTH = 1024;

const DESKTOP_FALLBACK: Viewport = { layout: 'desktop', width: 1280, height: 800, isTouch: false };

/**
 * 宽度 → 布局档位。iPad 分屏（320 ~ 507px）与竖屏 iPhone 全部落入 mobile，
 * 平板横屏（1024×768）留在 tablet，桌面端（≥1025）保持不变。
 */
export function layoutForWidth(width: number): WdLayout {
  if (!Number.isFinite(width) || width <= 0) return 'desktop';
  if (width <= MOBILE_MAX_WIDTH) return 'mobile';
  if (width <= TABLET_MAX_WIDTH) return 'tablet';
  return 'desktop';
}

function hasWindow(): boolean {
  return typeof window !== 'undefined' && typeof document !== 'undefined';
}

function readIsTouch(): boolean {
  if (!hasWindow() || typeof window.matchMedia !== 'function') return false;
  // 同时匹配 hover:none / pointer:coarse 任一：部分安卓平板只报其一
  return (
    window.matchMedia('(hover: none)').matches ||
    window.matchMedia('(pointer: coarse)').matches
  );
}

function readViewport(): Viewport {
  if (!hasWindow()) return DESKTOP_FALLBACK;
  const width = window.innerWidth || document.documentElement.clientWidth;
  const height = window.innerHeight || document.documentElement.clientHeight;
  return { layout: layoutForWidth(width), width, height, isTouch: readIsTouch() };
}

let snapshot: Viewport = readViewport();
const listeners = new Set<() => void>();
let listening = false;
let rafId = 0;

/** 把布局档位与动态视口高度写到 <html>，供 CSS 作用域选择器与固定定位使用 */
function applyToDocument(vp: Viewport): void {
  if (!hasWindow()) return;
  const root = document.documentElement;
  if (root.dataset.wdLayout !== vp.layout) root.dataset.wdLayout = vp.layout;
  if (root.dataset.wdTouch !== (vp.isTouch ? '1' : '0')) {
    root.dataset.wdTouch = vp.isTouch ? '1' : '0';
  }
  // iOS Safari 地址栏收起/展开时 innerHeight 与可视区不一致，固定定位的窗口用它兜底
  root.style.setProperty('--wd-vv-h', `${vp.height}px`);
}

function sameViewport(a: Viewport, b: Viewport): boolean {
  return a.layout === b.layout && a.width === b.width && a.height === b.height && a.isTouch === b.isTouch;
}

function commit(): void {
  const next = readViewport();
  if (sameViewport(snapshot, next)) return;
  snapshot = next;
  applyToDocument(next);
  listeners.forEach((fn) => fn());
}

function scheduleCommit(): void {
  if (rafId) return;
  const run = () => {
    rafId = 0;
    commit();
  };
  // rAF 在后台标签页可能被冻结，超时兜底保证旋转/分屏切换后仍能收口
  rafId = window.requestAnimationFrame(run);
  window.setTimeout(() => {
    if (rafId) {
      window.cancelAnimationFrame(rafId);
      rafId = 0;
      commit();
    }
  }, 120);
}

function ensureListening(): void {
  if (listening || !hasWindow()) return;
  listening = true;
  window.addEventListener('resize', scheduleCommit, { passive: true });
  window.addEventListener('orientationchange', scheduleCommit, { passive: true });
  // iOS 地址栏变化只触发 visualViewport 的 resize，不触发 window.resize
  window.visualViewport?.addEventListener('resize', scheduleCommit, { passive: true });
  if (typeof window.matchMedia === 'function') {
    // 触控能力变化（如 iPad 接上鼠标）需要重算 isTouch
    window.matchMedia('(pointer: coarse)').addEventListener?.('change', scheduleCommit);
    window.matchMedia('(hover: none)').addEventListener?.('change', scheduleCommit);
  }
}

function subscribe(fn: () => void): () => void {
  ensureListening();
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function getSnapshot(): Viewport {
  return snapshot;
}

/**
 * 在 React 渲染前调用一次：把首帧布局档位写进 `<html>`。
 * 否则窄屏首帧会先按桌面布局画一次再切到移动外壳（肉眼可见的闪动）。
 */
export function initViewport(): Viewport {
  ensureListening();
  applyToDocument(snapshot);
  return snapshot;
}

/** 订阅当前视口信息；仅在跨断点 / 尺寸变化时触发重渲染 */
export function useViewport(): Viewport {
  return useSyncExternalStore(subscribe, getSnapshot, () => DESKTOP_FALLBACK);
}

/** 便捷断言：当前是否处于手机布局（首页 + 单 app 全屏） */
export function useIsMobileLayout(): boolean {
  return useViewport().layout === 'mobile';
}

if (hasWindow()) initViewport();
