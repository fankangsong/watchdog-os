import { dispatch, useAppManager } from 'classicy';
import homeIcon from '../assets/icons/home.svg?no-inline';
import { closeAllActions, isHomeVisible } from './shellModel';

/**
 * 手机端「返回首页」悬浮键。
 *
 * 关闭策略：逐个派发 `ClassicyWindowClose`（而不是 `ClassicyAppClose`）——
 * 前者只把窗口标记为 closed，app 仍处于已加载状态，再次从首页进入时窗口立即恢复，
 * 不会重新走一遍注册；且对已关闭窗口幂等，重复点击无副作用。
 * 刻意不去改窗口的 size/position：那会被 classicy 持久化进 localStorage，
 * 回到桌面端时用户的多窗口布局就毁了。
 */
export function MobileHomeBar() {
  const apps = useAppManager((s) => s.System.Manager.Applications.apps);

  if (isHomeVisible(apps)) return null;

  const goHome = () => {
    for (const target of closeAllActions(apps)) {
      dispatch({ type: 'ClassicyWindowClose', app: { id: target.appId }, window: { id: target.windowId } });
    }
  };

  return (
    <button type="button" className="sp-m-homebar" onClick={goHome} aria-label="Back to Home">
      <img src={homeIcon} alt="" />
    </button>
  );
}
