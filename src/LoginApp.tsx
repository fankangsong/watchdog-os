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
  const [hostname, setHostname] = useState('');

  // 全局名称使用主机名替代：登录页标题栏 + 浏览器标签页
  useEffect(() => {
    fetchHealth()
      .then((h) => {
        setHostname(h.hostname);
        document.title = h.hostname;
      })
      .catch(() => {
        document.title = '系统监控';
      });
  }, []);

  const doLogin = async () => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await login(password);
      onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : '登录失败');
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
            <span className="sp-platinum-title-text">{hostname || '…'}</span>
          </div>
          <div className="sp-platinum-body">
            <div className="sp-login-field">
              <ClassicyInput
                id="sp-login-password"
                labelTitle="访问密码"
                labelPosition="left"
                labelSize="small"
                type="password"
                placeholder="请输入密码"
                prefillValue={password}
                onChangeFunc={(e) => setPassword(e.target.value)}
                onEnterFunc={doLogin}
              />
            </div>
            <p className="sp-login-err">{error && <span>{error}</span>}</p>
            <div className="sp-login-actions">
              <ClassicyButton buttonType="submit" disabled={busy}>
                {busy ? '登录中…' : '登录'}
              </ClassicyButton>
            </div>
          </div>
        </form>
      </ClassicyAppManagerProvider>
    </div>
  );
}
