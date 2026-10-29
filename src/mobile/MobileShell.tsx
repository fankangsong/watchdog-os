import { useEffect } from 'react';
import { useViewport } from '../responsive';
import { MobileHome } from './MobileHome';
import { MobileHomeBar } from './MobileHomeBar';

/** 找不到菜单栏时的重试次数（约 10 帧）：classicy 首帧后才把菜单栏挂进 #classicyDesktop */
const MENU_PROBE_TRIES = 10;

/**
 * 手机端菜单栏高度 → `--wd-m-menu-h`。
 *
 * 全屏窗口必须从菜单栏下沿开始（菜单栏 z-index 500 在窗口之上，压住会连标题栏都点不到），
 * 而菜单栏高度随字号、安全区、动态字体变化，硬编码必然错位；这里量一次并在
 * 尺寸变化时同步（横竖屏切换、iPad 分屏拖动都会改菜单栏高度）。
 */
function useMenuBarHeight(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    const root = document.documentElement;
    let observer: ResizeObserver | null = null;
    let frame = 0;
    let disposed = false;

    const attach = (tries: number) => {
      if (disposed) return;
      const el = document.querySelector<HTMLElement>('.classicyDesktopMenuBar');
      if (!el) {
        if (tries < MENU_PROBE_TRIES) frame = window.requestAnimationFrame(() => attach(tries + 1));
        return;
      }
      const apply = () => {
        root.style.setProperty('--wd-m-menu-h', `${el.getBoundingClientRect().height}px`);
      };
      apply();
      observer = new ResizeObserver(apply);
      observer.observe(el);
    };

    attach(0);
    return () => {
      disposed = true;
      if (frame) window.cancelAnimationFrame(frame);
      observer?.disconnect();
      root.style.removeProperty('--wd-m-menu-h');
    };
  }, [enabled]);
}

/**
 * 移动外壳：仅在手机断点挂载（平板与桌面不渲染任何东西，保持原多窗口体验）。
 * 首页与悬浮键都以 position:fixed 叠在 classicy 桌面之上，不参与其布局。
 */
export function MobileShell() {
  const { layout } = useViewport();
  const mobile = layout === 'mobile';
  useMenuBarHeight(mobile);
  if (!mobile) return null;
  return (
    <>
      <MobileHome />
      <MobileHomeBar />
    </>
  );
}
