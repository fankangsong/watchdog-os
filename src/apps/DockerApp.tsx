import { useEffect, useMemo } from 'react';
import { ClassicyApp, ClassicyControlGroup, ClassicyIcons, ClassicyWindow } from 'classicy';
import { fetchDocker, Unauthorized } from '../api';
import { usePolling } from '../hooks/usePolling';
import { DockerTable } from '../components/DockerTable';

const APP_ID = 'srv-docker.app';
const APP_NAME = 'Docker';

// 窗口2：Docker 容器列表（仅窗口打开时轮询）
export function DockerApp({ onLogout }: { onLogout?: () => void }) {
  const poll = usePolling(fetchDocker, 5000);

  useEffect(() => {
    if (poll.error instanceof Unauthorized) onLogout?.();
  }, [poll.error, onLogout]);

  const appMenu = useMemo(
    () => [
      {
        id: 'sys',
        title: 'System',
        menuChildren: [{ id: 'logout', title: 'Sign Out', onClickFunc: () => onLogout?.() }],
      },
    ],
    [onLogout]
  );

  return (
    <ClassicyApp id={APP_ID} name={APP_NAME} icon={ClassicyIcons.system.network.terminal} defaultWindow="docker-main">
      <ClassicyWindow
        id="docker-main"
        title={APP_NAME}
        icon={ClassicyIcons.system.network.terminal}
        appId={APP_ID}
        scrollable
        resizable
        zoomable
        collapsable
        closable
        initialSize={[860, 480]}
        initialPosition={['center', 'center']}
        minimumSize={[620, 360]}
        appMenu={appMenu}
      >
        <ClassicyControlGroup label={`Containers (${poll.data?.containers?.length ?? 0})`}>
          <DockerTable state={poll.data} />
        </ClassicyControlGroup>
      </ClassicyWindow>
    </ClassicyApp>
  );
}
