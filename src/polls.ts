import { fetchDocker, fetchMetrics, fetchPrinter, fetchProcesses } from './api';
import { createSharedPoll } from './sharedPoll';

/**
 * 四个轮询数据源的页面级共享 store（模块单例，登录后首个订阅即启动）：
 *  - monitorPoll：系统指标 + 进程列表（MonitorApp 同一节奏，合并为一次轮询内的顺序两个请求）
 *  - dockerPoll：Docker 容器列表（DockerApp）
 *  - printerPoll：CUPS 打印机 / 队列 / 历史（PrinterApp）
 * 轮询与 app 窗口开闭解耦：退出应用后仍在轮询，重开即有最新数据（docs/tasks.md）。
 * RunnerApp 的构建状态轮询保持组件级 usePolling（手动触发型界面，退出即停无妨）。
 */
export const monitorPoll = createSharedPoll(
  async () => ({
    metrics: await fetchMetrics(),
    processes: await fetchProcesses(),
  }),
  { intervalMs: 5000 }
);

export const dockerPoll = createSharedPoll(fetchDocker, { intervalMs: 5000 });

export const printerPoll = createSharedPoll(fetchPrinter, { intervalMs: 5000 });
