import {
  ClassicyAppManagerProvider,
  ClassicyDesktop,
  ClassicyIcons,
} from 'classicy';
import { MonitorApp } from './apps/MonitorApp';
import { DockerApp } from './apps/DockerApp';

// 桌面：系统监控 与 Docker 两个应用窗口
export function Desktop({ onLogout }: { onLogout: () => void }) {
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
        <MonitorApp onLogout={onLogout} />
        <DockerApp />
      </ClassicyDesktop>
    </ClassicyAppManagerProvider>
  );
}
