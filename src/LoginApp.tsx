import { useState } from 'react';
import { ClassicyButton, ClassicyControlGroup, ClassicyInput } from 'classicy';
import { login } from './api';

// 登录表单：classicy Platinum 控件（分组框 + 密码输入 + 默认按钮）
export function LoginApp({ onSuccess }: { onSuccess: () => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

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
    <form className="sp-login-form" onSubmit={submit}>
      <ClassicyControlGroup label="访问密码">
        <ClassicyInput
          id="sp-login-password"
          type="password"
          placeholder="请输入密码"
          prefillValue={password}
          onChangeFunc={(e) => setPassword(e.target.value)}
          onEnterFunc={doLogin}
        />
      </ClassicyControlGroup>
      {error && <p className="sp-login-err">{error}</p>}
      <div className="sp-login-actions">
        <ClassicyButton isDefault buttonType="submit" disabled={busy}>
          {busy ? '登录中…' : '登录'}
        </ClassicyButton>
      </div>
    </form>
  );
}
