import { useEffect, useState } from 'react';
import {
  ClassicyAppManagerProvider,
  ClassicyButton,
  ClassicyIcons,
  ClassicyInput,
} from 'classicy';
import { fetchHealth, login } from './api';

// 全屏登录页：登录整个系统。
// 包一层 ClassicyAppManagerProvider 以注入 classicy 的 CSS 变量，
// 使 label/输入框/按钮获得与桌面应用完全一致的 classicy 原生样式
// （不渲染 ClassicyWindow/ClassicyDesktop，因此不会出现桌面元素）。
export function LoginApp({ onSuccess }: { onSuccess: () => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  // 标题固定为通用名：/api/health 不再对未登录访客返回主机名（匿名信息收敛）。
  // 登录后 MonitorApp 会用已鉴权的 /api/metrics 里的 host.hostname 显示真实主机名。
  useEffect(() => {
    document.title = 'System Monitor';
    // 保留一次健康探测：后端不可达时提前暴露问题（真正的失败仍由登录请求给出）
    fetchHealth().catch(() => {});
  }, []);

  const doLogin = async () => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await login(password);
      onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed');
      setBusy(false);
    }
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    doLogin();
  };

  return (
    <div className="sp-login-screen">
      <ClassicyAppManagerProvider
        disableSimpleText
        disablePDFViewer
        disableMoviePlayer
        disablePictureViewer
        disableHyperCard
        disableWebViewer
        defaultMuted
      >
        <form className="sp-platinum-window" onSubmit={submit}>
          <div className="sp-platinum-title">
            <img
              className="sp-platinum-icon"
              src={ClassicyIcons.applications.systemProfiler.app}
              alt=""
            />
            <span className="sp-platinum-title-text">System Monitor</span>
          </div>
          <div className="sp-platinum-body">
            <div className="sp-login-field">
              <ClassicyInput
                id="sp-login-password"
                labelTitle="Access Password"
                labelPosition="left"
                labelSize="small"
                type="password"
                placeholder="Enter password"
                prefillValue={password}
                onChangeFunc={(e) => setPassword(e.target.value)}
                onEnterFunc={doLogin}
              />
            </div>
            <p className="sp-login-err">{error && <span>{error}</span>}</p>
            <div className="sp-login-actions">
              <ClassicyButton buttonType="submit" disabled={busy}>
                {busy ? 'Signing in…' : 'Sign In'}
              </ClassicyButton>
            </div>
          </div>
        </form>
      </ClassicyAppManagerProvider>
    </div>
  );
}
