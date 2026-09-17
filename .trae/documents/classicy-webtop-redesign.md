# 基于 Classicy 桌面框架重设计 srv-dashboard

## 摘要

将当前零依赖的原生 HTML/JS 监控页面，重构为基于 **Classicy**（npm 包 `classicy` v0.79.0，React 19 / MacOS Classic 8 Platinum 复古桌面框架）的 Webtop 应用：

- **一个窗口（MonitorApp）**：系统信息 + 资源使用率 + 系统进程
- **另一个窗口（DockerApp）**：Docker 容器列表（仅展示）

后端 Node.js 服务与全部 API 保持不变，仅调整静态资源托管方式；Docker 窗口为只读展示，不新增容器操作。

## 现状分析

- **后端** [server.js](file:///d:/fankangsong/srv-dashboard/server.js)：零依赖 Node，API 面 = `/api/login`(POST)、`/api/metrics`、`/api/processes`、`/api/docker`、`/api/logout`、`/api/health`；鉴权 = `sp_token` cookie；支持 `basePath` 前缀（当前远程为 `/tkp`），已带 302 斜杠重定向修复。`PUBLIC_DIR = public/`，`serveFile` 按已知文件名白名单提供静态资源。
- **前端** `public/index.html + app.js + style.css + login.html`：单页卡片布局，轮询刷新（2/5/10/30s）、暂停、倒计时、主题切换、进程搜索排序、canvas 历史曲线。所有资源/API 均用相对路径（`./api/...`），天然兼容 basePath。
- **布局现状**：系统信息卡 + 资源使用率卡 在左侧 340px 栅格，进程表卡与 Docker 表卡纵向排布 —— 正是本次要拆分重组的对象。
- **Classicy 结论**（已抓取官网与 npm registry）：React 框架，`<ClassicyDesktop>` 包 `<ClassicyApp>` 包业务组件；提供窗口、桌面图标、菜单、表单组件。npm latest = 0.79.0，React 19。

## 目标架构

```
浏览器
 └─ Classicy 桌面（复古 Platinum 风格）
     ├─ 桌面图标：系统监控 / Docker
     ├─ 窗口1 MonitorApp：系统信息 + 资源使用率 + 系统进程
     └─ 窗口2 DockerApp：Docker 容器列表
登录（未鉴权时显示登录窗口，鉴权仍走 server /api/login）
```

技术栈：**前端** React 19 + TypeScript + Vite + classicy；**后端** Node 零依赖不变。

## 变更内容

### 1. 前端工程化（新增构建链）

- `package.json`：新增依赖 `react@^19`、`react-dom@^19`、`classicy@^0.79.0`；devDependencies `vite`、`@vitejs/plugin-react`、`typescript`、`@types/react`、`@types/react-dom`。脚本：`dev` / `build`（vite build）/ `start`（保留 `node server.js`）。
- 新增 `vite.config.ts`：`base: './'`（关键 —— 构建产物用相对路径引用资源，使 SPA 在任意 basePath 子路径下可用）；`@vitejs/plugin-react`。
- 新增 `tsconfig.json`（标准 React 配置）。
- 新增 Vite 入口 `index.html`（根级，与 server 的 `dist` 输出对应）：挂载 `#root`，引用 `/src/main.tsx`。

### 2. 前端源码 `src/`

- `src/main.tsx`：ReactDOM 创建根节点，渲染 `<App/>`，引入全局样式与 classicy 样式。
- `src/api.ts`：`fetchMetrics/fetchProcesses/fetchDocker/login/logout`，均使用相对路径 `./api/...`；401 时抛 `Unauthorized`。
- `src/App.tsx`：启动时调 `fetchMetrics` 判定鉴权状态；未鉴权渲染 `<LoginApp/>`，已鉴权渲染 `<ClassicyDesktop>`（桌面 + 两个应用窗口）。提供退出登录与全局轮询状态。
- `src/LoginApp.tsx`：Classicy 风格登录窗口，调用 `/api/login`，成功后进入桌面。
- `src/Desktop.tsx`：`ClassicyDesktop` + 桌面图标（系统监控 / Docker），点击打开对应窗口（窗口可拖动、关闭）。
- `src/apps/MonitorApp.tsx`（窗口1，含三个面板，纵向排布）：
  - `SystemInfoPanel`：主机名/操作系统/CPU/运行时间/局域网 IP/公网 IP/硬件温度（沿用现有字段与「无温度显示 - + hover 提示」逻辑）。
  - `ResourcesPanel`：CPU/内存仪表盘（CPU 蓝、内存绿）、历史曲线（canvas，复用现有采样 history 与绘制思路）、核心负载、Swap、磁盘使用率。
  - `ProcessPanel`：进程表（搜索、按列排序、内存/CPU 迷你条），数据来自 `/api/processes` 独立轮询。
- `src/apps/DockerApp.tsx`（窗口2）：Docker 容器表（只读，右对齐数值列同现有规范），仅在窗口打开时轮询 `/api/docker`。
- `src/hooks/usePolling.ts`：统一轮询 hook，支持间隔（2/5/10/30s）、暂停/继续；Monitor 窗口内的刷新间隔选择与暂停按钮保留。
- `src/styles.css`：全局微调（表格/仪表盘/信息行沿用现有视觉约定，去掉自定义亮暗主题变量 —— 主题交给 Classicy 自带）。

> 实现时以 `node_modules/classicy` 的类型定义与 README 为准确定具体组件名/属性（官网示例确认了 `ClassicyDesktop`/`ClassicyApp` 包裹结构）。

### 3. 后端调整 `server.js`（最小改动）

- 静态托管：`PUBLIC_DIR` 优先取 `dist/`（构建产物），不存在时回退 `public/`（过渡期旧 UI 仍可跑）。
- 将静态资源白名单路由（`/style.css`、`/app.js`、`/favicon.svg`）替换为通用静态处理：`dist/` 下任意文件按扩展名 MIME 输出，`index.html` 兜底；保持 basePath 剥离与 302 斜杠重定向逻辑不变。
- `/login` 页面路由：改为返回 SPA 的 `index.html`（登录/仪表盘由前端按鉴权态决定），`/api/*` 全部保持原样。

### 4. 部署（tkp）

- 本地执行 `npm install` + `npm run build`，产出 `dist/`。
- 上传 `dist/`、`server.js`、`package.json`、`run.sh` 到 `/root/srv-dashboard`（**保留远程 `config.json` 不动**）。
- `./run.sh restart` 重启；服务端运行仍零依赖（`node server.js`），无需在服务器装 npm 依赖。

## 假设与决策

1. **完整采用 Classicy**（用户明示"基于这个框架"）：前端改为 React+Vite 构建链。
2. **Docker 窗口仅展示**：不加容器启停操作，后端 `/api/docker` 不变。
3. **主题**：移除自研亮/暗切换，采用 Classicy 自带 Platinum 主题（原顶栏倒计时/主题按钮并入 Monitor 窗口控制区或移除）。
4. **鉴权流程不变**：仍由 server cookie 鉴权，前端按 401 切换登录窗口。
5. **CPU 蓝 / 内存绿**的图表配色约定保留。
6. **删除旧前端**：`public/` 保留为回退，确认稳定后后续可清理（本次不动）。

## 验证步骤

1. `npm run build` 无报错，产出 `dist/`。
2. 本地起测试实例（`PORT=3100 BASE_PATH=/probe PASSWORD=admin123 node server.js`）：
   - `/probe/` → 200 且含 `#root`；`/probe/assets/*` → 200；
   - `/probe/api/metrics` 未带 Cookie → 401；带 Cookie → 200；
   - `/` 与 `/probe` → 302 到 `/probe/`；
   - 无 Cookie 打开页面显示登录窗口，登录后出现桌面与两个应用窗口（浏览器手动确认）。
3. 部署到 tkp 后 `ssh` curl 复验上述 200/302/401/登录链路，`./run.sh status` 确认 active。
4. 浏览器最终确认：Monitor 窗口含系统信息/资源使用率/进程三块，Docker 独立窗口正常刷新。
