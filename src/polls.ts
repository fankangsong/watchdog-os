import { fetchDocker, fetchMetrics, fetchPrinter, fetchProcesses } from './api';
import { createSharedPoll } from './sharedPoll';

/**
 * 轮询数据源的应用级共享 store（模块单例）：
 *  - monitorPoll：系统指标 + 进程列表（MonitorApp / DiskApp 共用，合并为一次轮询内的顺序两个请求）
 *  - dockerPoll：Docker 容器列表（DockerApp）
 *  - printerPoll：CUPS 打印机 / 队列 / 历史（PrinterApp）
 * 各 App 用 useAppOpen 门控订阅：未启动时不发请求，启动即首拉并续轮，Quit 后停转。
 * RunnerApp / BlogApp / AuditApp 的组件级 usePolling 同样按应用启动状态门控。
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
