# 待解决 / 已解决问题

## 已解决（2026-10-21）

### 1. 轮询接口「APP 退出就不再轮询」

- **现象**：`tkp/api/metrics`、`tkp/api/processes`、`tkp/api/docker`、`tkp/api/printer` 这些轮询接口只在 APP 启动时才工作，APP 退出就不再轮询。
- **根因**：轮询挂在各 App 组件内（`usePolling`），生命周期受 classicy 窗口 / 应用开关影响；且 MonitorApp / DockerApp 的源码注释对「窗口关闭后是否续轮」各说不一，属于未验证的臆断。
- **修复**：轮询收敛为页面级共享 store（`src/sharedPoll.ts` 的 `createSharedPoll` + `src/polls.ts` 单例 `monitorPoll` / `dockerPoll` / `printerPoll`），与 `favoritesStore` 同一模式。订阅即启动并立即首拉；**最后一个订阅者退出不停止**（退出 App / 关闭窗口 / 组件卸载均不中断，重开即有最新数据）；401 时停止避免风暴，重新登录后自动重启；另含暂停 / 改间隔 / 慢接口防叠加。RunnerApp 的构建状态轮询保持组件级（手动触发型界面，退出即停无妨）。
- **验证**：`node test/test-shared-poll.mjs` 全部 PASS（16 项，含「零订阅者后轮询继续」核心回归）；`npx tsc --noEmit` 与 `npm run build` 通过。

### 2. 文件浏览器「添加到收藏夹覆盖上一次添加的目录」

- **现象**：添加收藏会覆盖上一次添加的目录；期望可以添加多个收藏夹。
- **复现（先验证，已确认）**：`node test/test-favorites-store.mjs` 对旧 store 稳定复现 4 类数据丢失——① 初始 GET 响应晚于首次提交时，后落地的旧列表冲掉新状态（即「添加 B 丢了 A」）；② 未等加载完成即添加，PUT 盲写丢旧条目；③ 并发添加在服务端乱序落地互相覆盖；④ 加载失败时盲写破坏服务端列表。正常顺序流（场景 5）不受影响，故问题呈间歇性。
- **根因**：服务端 `/api/fs/favorites` 是**全量替换**语义，而旧 store 的变更既不与首次加载互等、提交也不串行、过期 GET 响应还会后落地覆盖新状态。
- **修复**：`src/favoritesStore.ts` 所有变更先进串行队列，队列内 `await ensureLoaded()` 后基于最新状态计算 next（加载失败则原样报错，不做破坏性盲写）；加载响应带世代号，加载期间发生过提交则丢弃过期响应。
- **验证**：`node test/test-favorites-store.mjs` 全部 PASS（8 项，多收藏互不丢失）；`node test/test-fs-api.js`（30 项）与 `node test/test-prefs-api.js`（17 项）不回归。

## 附：待确认（非阻塞）

- 轮询在「已登录但所有 App 都退出」时持续进行（按需求预期）；若未来想加「闲置 N 分钟自动暂停」策略，应在 `sharedPoll.ts` 内实现，不要回到组件级轮询。
