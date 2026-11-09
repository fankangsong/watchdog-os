import { useEffect, useMemo } from 'react';
import { ClassicyApp, ClassicyControlGroup, ClassicyWindow, useClassicyAboutMenu } from 'classicy';
import { Unauthorized } from '../api';
import { monitorPoll } from '../polls';
import { useSharedPoll } from '../sharedPoll';
import { useAppOpen } from '../hooks/useAppOpen';
import { DiskPanel } from '../components/DiskPanel';
import { quitMenuItem } from '../quitMenuItem';
// ⚠️ 必须用 ?no-inline（仅 ?url 不够，它不绕过 assetsInlineLimit）让 Vite 输出独立文件 URL，
// 否则 classicy 桌面图标遮罩会静默失效（见 docs/icon-pipeline.md §6.2）。
import diskIcon from '../assets/icons/disk.svg?no-inline';

const APP_ID = 'srv-disk.app';
const APP_NAME = 'Disks';
/** 应用图标：自绘 SVG（窗口 + 硬盘盘片 + 容量条），见 src/assets/icons/disk.svg */
const ICON = diskIcon;

// 磁盘容量：复用 monitorPoll（/api/metrics 已含 state.disks，后端每 10s statfs 采样），
// 不新增接口、不新建 poll——与 MonitorApp 共享同一次轮询
export function DiskApp({ onLogout }: { onLogout?: () => void }) {
  const open = useAppOpen(APP_ID);
  const poll = useSharedPoll(monitorPoll, open);

  const { aboutMenuItem, aboutWindow } = useClassicyAboutMenu(APP_ID, APP_NAME, ICON);

  useEffect(() => {
    if (poll.error instanceof Unauthorized) onLogout?.();
  }, [poll.error, onLogout]);

  const appMenu = useMemo(
    () => [
      {
        id: 'disk-menu',
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

  const disks = poll.data?.metrics?.disks ?? null;

  return (
    <ClassicyApp id={APP_ID} name={APP_NAME} icon={ICON} defaultWindow="disk-main">
      <ClassicyWindow
        id="disk-main"
        title={APP_NAME}
        icon={ICON}
        appId={APP_ID}
        scrollable
        resizable
        zoomable
        collapsable
        closable
        initialSize={[520, 420]}
        initialPosition={['center', 'center']}
        minimumSize={[380, 260]}
        appMenu={appMenu}
      >
        <ClassicyControlGroup label={`Disk Usage (${disks?.length ?? 0})`}>
          <DiskPanel disks={disks} />
        </ClassicyControlGroup>
      </ClassicyWindow>
      {aboutWindow}
    </ClassicyApp>
  );
}
