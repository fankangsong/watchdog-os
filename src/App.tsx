import { useEffect, useRef, useState } from 'react';
import { probeAuth } from './api';
import { consumeSignedOutFlag, endSession } from './session';
import { LoginApp } from './LoginApp';
import { Desktop } from './Desktop';

// 鉴权状态机：checking → authed | unauthed
export function App() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  // 只判定一次：StrictMode 下 effect 会跑两遍，「刚退出」标记被第一遍消费后，
  // 第二遍的探测会把用户又弹回桌面（探测在服务不可达时按已登录处理）
  const settled = useRef(false);

  useEffect(() => {
    if (settled.current) return;
    settled.current = true;
    // 刚退出（主动 Sign Out 或 401 收尾）：直接落登录页，不再探测——
    // 探测在网络异常时按「已登录」处理，会把用户又弹回桌面。
    if (consumeSignedOutFlag()) {
      setAuthed(false);
      return;
    }
    // 静默探测：401 表示「未登录」而非「会话失效」，因此不会触发全局登出（否则会 401↔重载死循环）
    probeAuth().then(setAuthed);
  }, []);

  if (authed === null) {
    return (
      <div className="sp-boot">
        <div className="sp-boot-inner">Starting…</div>
      </div>
    );
  }
  // 退出（主动 Sign Out 或任一接口 401）统一走 endSession：清本地会话存储 + 整页重载回登录页
  if (authed) return <Desktop onLogout={endSession} />;
  return <LoginApp onSuccess={() => setAuthed(true)} />;
}
