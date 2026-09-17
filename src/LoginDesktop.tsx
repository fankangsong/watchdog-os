import {
  ClassicyApp,
  ClassicyAppManagerProvider,
  ClassicyDesktop,
  ClassicyIcons,
  ClassicyWindow,
} from 'classicy';
import { LoginApp } from './LoginApp';

// 登录桌面：仅一个真实 Platinum 登录窗口（标准标题栏/控件）
export function LoginDesktop({ onSuccess }: { onSuccess: () => void }) {
  return (
    <ClassicyAppManagerProvider
      disableSimpleText
      disablePDFViewer
      disableMoviePlayer
      disablePictureViewer
      disableHyperCard
      disableWebViewer
      defaultMuted
    >
      <ClassicyDesktop startupScreen={false} startupLogo={ClassicyIcons.system.macosSvg} startupWordmark="系统探针">
        <ClassicyApp id="login.app" name="系统探针" icon={ClassicyIcons.applications.systemProfiler.app} defaultWindow="login-main">
          <ClassicyWindow
            id="login-main"
            appId="login.app"
            title="系统探针"
            icon={ClassicyIcons.applications.systemProfiler.app}
            initialSize={[360, 200]}
            initialPosition={['center', 'center']}
            closable={false}
            zoomable={false}
            resizable={false}
          >
            <LoginApp onSuccess={onSuccess} />
          </ClassicyWindow>
        </ClassicyApp>
      </ClassicyDesktop>
    </ClassicyAppManagerProvider>
  );
}
