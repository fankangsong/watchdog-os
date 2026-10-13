---
name: serverjs-modularize
overview: 将 1700 行的零依赖单文件 server.js 按功能域拆分为 server/ 目录下的 CommonJS 模块，server.js 保留为瘦入口（启动、定时器、shutdown），保持零依赖、鉴权一致、basePath 兼容，并用现有测试脚本验证。
todos:
  - id: extract-config-lib
    content: 创建 server/config.js、server/lib/http.js、server/lib/auth.js，承载配置加载、HTTP 工具与 JWT 鉴权
    status: completed
  - id: extract-collectors-static
    content: 抽离指标采集 state/collectCore 到 server/collectors.js，MIME/serveFile 到 server/static.js，导出定时器启动函数
    status: completed
  - id: extract-feature-modules
    content: 抽离 server/terminal.js（ttyd 与 WS/HTTP 代理）、server/runner.js、server/printer.js、server/chat.js、server/fsapi.js 五个功能模块
    status: completed
  - id: extract-router
    content: 创建 server/router.js 承载 API 路由分发、upgrade 处理与静态回退，保持鉴权顺序与 basePath 语义不变
    status: completed
  - id: rewrite-entry
    content: 重写 server.js 为瘦入口：串联模块、启动服务与定时器、汇总 shutdown 清理逻辑
    status: completed
  - id: verify-regression
    content: 使用 [skill:verification-before-completion] 验证：node test-fs-api.js 全 PASS、node test-runner-api.js 全 PASS、npm start 后 /api/health 与登录鉴权正常；如有回归用 [skill:systematic-debugging] 定位修复
    status: completed
---

## 需求概述
将 watchdog-os 的后端单文件 `server.js`（1691 行，零依赖 Node.js 原生 HTTP 服务）按功能域拆分为模块化结构，接口行为保持完全不变，便于后续按模块维护。

## 用户补充约束
- **涉及到 app（前端应用）的接口模块，统一放在 `server/api/xxx.js`**（metrics、terminal、runner、printer、chat、fs 等）。
- 基础设施（config、http/auth 工具、静态服务、路由）放在 `server/` 及 `server/lib/`。

## 拆分目标
- 单文件入口保留：`node server.js` 启动方式不变（package.json `start` 脚本与现有测试脚本依赖此入口）。
- 按功能域拆出独立模块：配置、HTTP 基础设施、JWT 鉴权、指标采集、静态服务、Terminal（ttyd 代理）、Runner、Printer（IPP）、Hermes 聊天代理、文件管理（/api/fs）、路由分发。
- 保持既有硬约束：零依赖（仅 Node 内置模块）、CommonJS、鉴权贯穿所有 API、basePath 子路径兼容、中文注释。

## 边界与验收
- 纯等价重构：不新增功能、不修改任何 API 的请求/响应格式与状态码语义。
- 验收标准：`node test-fs-api.js` 20 项全 PASS、`node test-runner-api.js` 22 项全 PASS、`npm start` 后 `/api/health` 正常返回、登录与鉴权行为不变。


## 技术方案

### 技术栈
- 保持现有：Node.js（>=18.15）+ CommonJS + 零第三方依赖，仅使用 `http/https/fs/os/path/crypto/net` 等内置模块。
- 拆分后目录：新增 `server/` 与 `server/api/`、`server/lib/` 目录，`server.js` 保留为瘦入口（package.json 不需要改动）。

### 拆分设计（按功能域，app 接口在 server/api/ 下）
| 模块 | 承载内容（源 server.js 行号） |
| --- | --- |
| `server/config.js` | loadEnv、cfg 合并逻辑、BASE、JWT 常量（COOKIE_NAME/JWT_SECRET/JWT_EXPIRES）、DIST/PUBLIC 目录常量（30-163） |
| `server/lib/http.js` | send/redirect/parseCookies/safeEqual/readBody/runCmd（166-267） |
| `server/lib/auth.js` | b64url/signJwt/verifyJwt/checkAuth（200-244），依赖 config |
| `server/api/metrics.js` | state 共享状态、CPU/内存/温度/磁盘/Docker/进程采集、getLanIps/fetchWanIp/collectCore，并导出 `startCollectTimers()`（268-635） |
| `server/api/printer.js` | IPP 测试、parseIppTool、readPrinter，导出 `startPrinterTimer()`（889-1044） |
| `server/api/terminal.js` | ttyd 启动/退避重试/killWslTtyd、proxyTerminalToken、proxyTerminalWs，导出 `startTerminal()`/`stopTerminal()` 供 shutdown 调用（667-743、1077-1124） |
| `server/api/runner.js` | job 单槽锁、start/stop/日志/statusPayload（745-887） |
| `server/api/chat.js` | proxyHermesChat（1126-1219） |
| `server/api/fs.js` | FS_ROOTS、路径校验、list/read/raw/write/upload/mkdir/delete/rename/favorites（1221-1610） |
| `server/static.js` | MIME 表与 serveFile（637-665） |
| `server/router.js` | 主 HTTP 请求分发、upgrade 处理、静态回退（1611-末尾） |
| `server.js` | 瘦入口：require 各模块、启动 http server、注册采集/printer 定时器、shutdown 汇总清理 ttyd 与 runner 子进程（1046-1075） |

### 关键决策
- **目录语义**：`server/api/` 只放与前端应用对应的接口模块（一个前端 App 一类接口一个文件），`server/lib/` 放可复用的基础设施，`server/` 根放 config/static/router。
- **依赖方向单向**：config → lib → server/api/* → router → 入口，api 模块之间互不依赖，消除单文件内的隐式顺序耦合。
- **shutdown 聚合**：terminal 与 runner 各自导出 `stop()` 清理函数，入口统一在 SIGINT/SIGTERM/exit 注册，行为与现状逐项对齐（先清 ttyd 重试定时器、SIGTERM ttyd、WSL 下 killWslTtyd、runner 子进程 SIGTERM）。
- **不做抽象过度设计**：不引入路由框架/依赖注入，仅做函数级搬家 + `module.exports`，保证 diff 可审查、行为零漂移。
- **性能无变化**：采集定时器、SSE/轮询、WS 裸 TCP 管道转发逻辑原样保留，无新增运行时开销；require 开销可忽略。

### 风险控制
- 逐模块搬家时保持函数体不动，仅调整 require/exports；每次搬家后可独立用测试脚本回归。
- 鉴权调用链（checkAuth 在 401 优先于 503 的顺序）在 router 中原样保留。
- basePath 处理（BASE 前缀剥离与重定向）留在 router，不改语义。
