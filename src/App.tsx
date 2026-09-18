import { useEffect, useState } from 'react';
import { fetchMetrics, Unauthorized } from './api';
import { LoginApp } from './LoginApp';
import { Desktop } from './Desktop';

// 鉴权状态机：checking → authed | unauthed
export function App() {
  const [authed, setAuthed] = useState<boolean | null>(null);

  useEffect(() => {
    fetchMetrics()
      .then(() => setAuthed(true))
      .catch((e) => setAuthed(!(e instanceof Unauthorized)));
  }, []);

  if (authed === null) {
    return (
      <div className="sp-boot">
        <div className="sp-boot-inner">正在启动…</div>
      </div>
    );
  }
  if (authed) return <Desktop onLogout={() => setAuthed(false)} />;
  return <LoginApp onSuccess={() => setAuthed(true)} />;
}
