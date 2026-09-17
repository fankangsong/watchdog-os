import { useState } from 'react';
import { ClassicyButton, ClassicyInput } from 'classicy';
import { login } from './api';

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
    <div className="sp-login">
      <form className="sp-login-card sp-login-form" onSubmit={submit}>
        <div>
          <h1>系统探针</h1>
          <p className="sp-login-sub">请输入访问密码</p>
        </div>
        <ClassicyInput
          id="sp-login-password"
          type="password"
          labelTitle="密码"
          labelSize="small"
          labelPosition="above"
          placeholder="密码"
          prefillValue={password}
          onChangeFunc={(e) => setPassword(e.target.value)}
          onEnterFunc={doLogin}
        />
        {error && <p className="sp-login-err">{error}</p>}
        <ClassicyButton isDefault buttonType="submit" disabled={busy}>
          {busy ? '登录中…' : '登录'}
        </ClassicyButton>
      </form>
    </div>
  );
}
