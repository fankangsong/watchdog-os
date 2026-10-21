import { useEffect, useMemo } from 'react';
import { ClassicyApp, ClassicyControlGroup, ClassicyWindow, useClassicyAboutMenu } from 'classicy';
import { Unauthorized } from '../api';
import { dockerPoll } from '../polls';
import { useSharedPoll } from '../sharedPoll';
import { DockerTable } from '../components/DockerTable';
import { quitMenuItem } from '../quitMenuItem';
// ⚠️ 必须用 ?no-inline（仅 ?url 不够，它不绕过 assetsInlineLimit）让 Vite 输出独立文件 URL，
// 否则 classicy 桌面图标遮罩会静默失效（见 docs/icon-pipeline.md §6.2）。
import dockerIcon from '../assets/icons/docker.svg?no-inline';

const APP_ID = 'srv-docker.app';
const APP_NAME = 'Docker';
/** 应用图标：自绘 SVG（蓝鲸驮集装箱），见 src/assets/icons/docker.svg */
const ICON = dockerIcon;

// 窗口2：Docker 容器列表（页面级共享轮询，退出应用不中断——docs/tasks.md）
export function DockerApp({ onLogout }: { onLogout?: () => void }) {
  const poll = useSharedPoll(dockerPoll);

  const { aboutMenuItem, aboutWindow } = useClassicyAboutMenu(APP_ID, APP_NAME, ICON);

  useEffect(() => {
    if (poll.error instanceof Unauthorized) onLogout?.();
  }, [poll.error, onLogout]);

  const appMenu = useMemo(
    () => [
      {
        id: 'docker-menu',
        title: APP_NAME,
        menuChildren: [
          aboutMenuItem,
          { id: 'spacer' },
          quitMenuItem(APP_ID, APP_NAME, ICON),
        ],
      },
    ],
    [aboutMenuItem]
  );

  return (
    <ClassicyApp id={APP_ID} name={APP_NAME} icon={ICON} defaultWindow="docker-main">
      <ClassicyWindow
        id="docker-main"
        title={APP_NAME}
        icon={ICON}
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
      {aboutWindow}
    </ClassicyApp>
  );
}
