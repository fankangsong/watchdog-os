# AGENTS.md — srv-dashboard 项目指南

本文件为 AI 编码代理（以及新加入的开发者）提供本项目的关键上下文。修改代码前请先阅读本文件。

## 项目概述

**srv-dashboard** 是一个系统探针监控应用（Classicy 桌面版），用于采集并展示服务器的 CPU / 内存 / 交换分区 / 硬件温度 / 磁盘使用率 / Docker 容器 / 进程列表等指标。

- 版本：2.0.0，许可证：MIT
- 前端：React 19 + TypeScript + Vite，UI 组件库为 `classicy`（仿 Mac OS 9 桌面风格）
- 后端：`server.js` —— **零依赖** Node.js 原生 HTTP 服务（无 Express 等框架）
- 部署：支持 basePath 子路径（如 `/tkp/`），可置于 Nginx 反向代理之后；Linux 下通过 systemd（`run.sh` 管理 `srv-dashboard` 服务）

## 常用命令

```bash
npm run dev       # 启动 Vite 开发服务器（端口 5173，/api 代理到 127.0.0.1:3000）
npm run build     # 构建产物到 dist/
npm run preview   # 预览构建产物
npm start         # 启动生产后端（node server.js，默认端口 3000）
./run.sh start|restart|stop|status   # Linux 服务器上的 systemd 服务管理
```

注意：项目同时存在 `package-lock.json` 和 `pnpm-lock.yaml`，优先使用 **npm**。

## 后端配置

`server.js` 读取 `config.json`，可用环境变量 / `.env` 覆盖：

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `PORT` | 监听端口 | `3000` |
| `PASSWORD` | 访问密码（REST + 静态页面统一鉴权） | `config.json` 中的 `password` |
| `BASE_PATH` | 子路径前缀 | `/` |
| `diskMounts` | 监控的磁盘挂载点 | 按平台默认 |

其余可配置项：`collectInterval`（2000ms）、`dockerInterval`（5000ms）、`processInterval`（10000ms）、`processTopN`（50）。

## 目录结构与关键约定

```
server.js            # 零依赖后端：采集指标、鉴权、静态文件服务、SSE/轮询 API、终端代理
public/              # ⚠️ 旧版零依赖前端（server.js 回退用），不是 Vite 静态资源目录
src/                 # React 前端源码
  apps/              # 桌面应用窗口：MonitorApp（监控）、DockerApp（容器）、ImcolinApp、TerminalApp（终端）
  components/        # 展示组件：Gauge、HistoryChart、DockerTable、各信息面板
  hooks/             # usePolling —— 数据轮询 Hook
  api.ts             # 后端 API 封装（含 getTerminalToken）
  Desktop.tsx        # 桌面布局
  LoginApp.tsx       # 登录
  format.ts          # 格式化工具
vite.config.ts       # Vite 配置（见下方注意事项）
dist/                # 构建产物（勿手动修改）
```

### 终端模块（TerminalApp + ttyd）

- `server.js` 启动时按 `terminal` 配置节 spawn ttyd 子进程（仅监听 127.0.0.1），退出时 SIGTERM 清理；ttyd 不可用时自动禁用终端功能（主服务不受影响）
- 配置：`terminal.enabled`（默认 false，可用 `TERMINAL_ENABLED` 环境变量开启）、`ttydPath`、`ttydPort`（默认 7681）、`ttydArgs`
- 鉴权：`/api/terminal/token`（HTTP 转发 ttyd /token）与 `/api/terminal/ws`（upgrade 裸 TCP 管道转发到 ttyd /ws）均先走 `checkAuth` JWT 校验，再判启用状态（401 优先于 503）
- 前端 `src/apps/TerminalApp.tsx`：xterm.js（@xterm/xterm + @xterm/addon-fit）直连代理后的 WebSocket，实现 ttyd 1.7.x 二进制帧协议（服务端首字节 `0` 输出 / `1` 标题；客户端 `0` 输入 / `1` resize + 首条 JSON 认证消息）
- WS 代理为裸 TCP 管道（`net.connect` 改写请求行后双向 pipe），不实现 WS 帧编解码；修改升级逻辑时保持 Cookie 不外传、对端 socket 对称销毁

### 重要注意事项

1. **`vite.config.ts` 中 `publicDir: false`**：`public/` 是旧版零依赖前端的回退目录，绝不能被 Vite 拷入 `dist`（会与构建产物冲突）。新增静态资源请勿放进 `public/`。
2. **`base: './'`**：构建产物使用相对路径，SPA 可在任意 basePath 子路径下直接运行。改动 `vite.config.ts` 时保持此行为。
3. **`server.js` 零依赖**：只使用 Node.js 内置模块，不要引入第三方 npm 依赖。
4. **鉴权**：密码校验贯穿 REST API 与静态页面，改动路由或静态服务逻辑时注意保持鉴权一致。
5. **basePath**：后端与前端均需支持子路径部署，新增 API 路由时注意挂载在 `BASE` 前缀之下。
6. **Node 版本**：`engines` 要求 `>=18.15`。

## 编码风格

- 前端使用 TypeScript + React 函数组件 + Hooks；类型定义尽量内联在文件中。
- UI 遵循 `classicy` 组件库的风格（复古桌面隐喻）。
- 后端 `server.js` 为 CommonJS（`require`），保持单文件、零依赖风格，注释使用中文。
- 提交信息与代码注释均使用中文。

## 验证

改动后请至少验证：

- 前端：`npm run build` 确认无 TS / 构建错误。
- 后端：`npm start` 后用密码登录，确认指标接口正常返回。
