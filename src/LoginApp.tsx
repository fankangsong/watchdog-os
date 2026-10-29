import { useEffect, useRef, useState } from 'react';
import {
  ClassicyAppManagerProvider,
  ClassicyButton,
  ClassicyIcons,
  ClassicyInput,
} from 'classicy';
import { fetchHealth, login } from './api';

/** 状态栏的后端连通性（健康探测结果），仅用于展示，不拦截登录 */
type ServerState = 'checking' | 'online' | 'offline';

const SERVER_LABEL: Record<ServerState, string> = {
  checking: 'Checking Server…',
  online: 'Server Online',
  offline: 'Server Unreachable',
};

// 状态栏时钟：独立组件 + 自身定时器，避免秒级刷新连带整个表单重渲染
function StatusClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  return <span className="sp-login-status-clock">{now.toTimeString().slice(0, 8)}</span>;
}

// 全屏登录页：登录整个系统。
// 包一层 ClassicyAppManagerProvider 以注入 classicy 的 CSS 变量，
// 使 label/输入框/按钮获得与桌面应用完全一致的 classicy 原生样式
// （不渲染 ClassicyWindow/ClassicyDesktop，因此不会出现桌面元素）。
export function LoginApp({ onSuccess }: { onSuccess: () => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  // 每次失败自增，作为错误行的 key：重放抖动动画（同一条错误信息连续两次也能触发）
  const [attempt, setAttempt] = useState(0);
  const [server, setServer] = useState<ServerState>('checking');
  const passwordRef = useRef<HTMLInputElement>(null);

  // 标题固定为产品名：/api/health 不再对未登录访客返回主机名（匿名信息收敛），
  // 未登录阶段不暴露主机名。登录后 MonitorApp 会用已鉴权的 /api/metrics 里的
  // host.hostname 把文档标题升级为「WatchDog OS · <主机名>」。
  useEffect(() => {
    document.title = 'WatchDog OS';
    // 保留一次健康探测：后端不可达时提前暴露问题（真正的失败仍由登录请求给出），
    // 结果同时驱动底部状态栏的指示灯
    fetchHealth()
      .then(() => setServer('online'))
      .catch(() => setServer('offline'));
  }, []);

  // 首屏自动聚焦口令框：打开页面即可直接键入，无需先点一下输入框
  useEffect(() => {
    passwordRef.current?.focus();
  }, []);

  const doLogin = async () => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await login(password);
      onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed. Retry.');
      setAttempt((n) => n + 1);
      setBusy(false);
      passwordRef.current?.focus();
    }
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    doLogin();
  };

  return (
    <div className="sp-login-screen">
      <div className="sp-login-stage">
        <ClassicyAppManagerProvider
          disableSimpleText
          disablePDFViewer
          disableMoviePlayer
          disablePictureViewer
          disableHyperCard
          disableWebViewer
          defaultMuted
        >
          <div className="sp-login-brand">
            <img
              className="sp-login-brand-icon"
              src={ClassicyIcons.applications.systemProfiler.app}
              alt=""
            />
            <div className="sp-login-brand-text">
              <h1 className="sp-login-brand-name">WatchDog OS</h1>
              <p className="sp-login-brand-tag">Secure System Console</p>
            </div>
          </div>

          <form className="sp-platinum-window" onSubmit={submit} aria-busy={busy}>
            <div className="sp-platinum-title">
              <span className="sp-platinum-title-text">Login</span>
            </div>
            <div className="sp-platinum-body">
              {/* 提示行兼错误行：占同一位置，出错时整行替换说明文字（表单高度不跳动），
                  key 变化触发抖动动画 */}
              <p
                className={error ? 'sp-login-hint sp-login-hint-err' : 'sp-login-hint'}
                key={attempt}
                role={error ? 'alert' : undefined}
              >
                {error ? (
                  <>
                    <img className="sp-login-hint-icon" src={ClassicyIcons.system.warn} alt="" />
                    <span>{error}</span>
                  </>
                ) : (
                  'Enter the access password, then press Return.'
                )}
              </p>
              <div className="sp-login-field">
                <ClassicyInput
                  ref={passwordRef}
                  id="sp-login-password"
                  labelPosition="above"
                  labelSize="small"
                  type="password"
                  placeholder="Enter password"
                  prefillValue={password}
                  disabled={busy}
                  isDefault
                  onChangeFunc={(e) => {
                    setPassword(e.target.value);
                    if (error) setError('');
                  }}
                  onEnterFunc={doLogin}
                />
              </div>
              <div className="sp-login-actions">
                <ClassicyButton buttonType="submit" isDefault disabled={busy}>
                  {busy ? 'Signing In…' : 'Sign In'}
                </ClassicyButton>
              </div>
            </div>
            <div className="sp-login-status">
              <span className={`sp-login-led sp-login-led-${server}`} aria-hidden="true" />
              <span className="sp-login-status-text">{SERVER_LABEL[server]}</span>
              <StatusClock />
            </div>
          </form>
        </ClassicyAppManagerProvider>
      </div>
    </div>
  );
}
