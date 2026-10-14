# watchdog-os

系统探针监控面板（Classicy 桌面风格）：CPU / 内存 / 交换分区 / 硬件温度 / 磁盘使用率 / Docker 容器 / 进程列表 / 打印机，另含网页终端、文件管理器、文本编辑器、脚本任务构建与 AI 聊天代理。

- **前端**：React 19 + TypeScript + Vite，UI 组件库 classicy（仿 Mac OS 9 桌面风格）
- **后端**：`server/index.js` —— **零第三方依赖**的 Node.js 原生 HTTP 服务
- **部署**：支持 `basePath` 子路径（如 `/tkp/`），可置于 Nginx 反向代理之后；Linux 下通过 systemd 常驻

## 环境要求

| 项 | 要求 |
|---|---|
| Node.js | `>=18.15`（开发环境 v22.x） |
| 包管理器 | npm（仓库同时存在 `package-lock.json` 与 `pnpm-lock.yaml`，**请用 npm**） |
| 操作系统 | Windows / Linux / macOS；Linux 下额外需 systemd（`run.sh`） |
| 可选 | `ttyd`（网页终端）、`bash`（Runner）、CUPS（打印机） |

## 必配项（不配置无法启动）

启动时会校验两项关键配置，缺失立即退出并打印 `[fatal]`，**不提供任何默认值**：

| 变量 | 说明 | 生成方式 |
|---|---|---|
| `PASSWORD` | 访问密码（REST API 与页面统一鉴权） | 自行设置 |
| `JWT_SECRET` | 会话令牌签名密钥，**至少 32 字节** | `openssl rand -hex 32` |

> 两者是**独立**的秘密，不要用密码派生密钥，也不要复用同一字符串。换 `JWT_SECRET` 等价于让所有人重新登录；改 `PASSWORD` 不会影响已签发的令牌。

## 快速开始

```bash
# 1. 安装依赖
npm install

# 2. 准备配置（唯一来源是 .env）
cp .env.example .env         # 按注释填写 PASSWORD 与 JWT_SECRET

# 3. 开发模式：先起后端（另开一个终端），再起前端热更新
npm start                    # 后端 3000 端口
npm run dev                  # 前端 5173 端口，/api 自动代理到后端

# 4. 生产模式
npm run build                # 构建前端到 dist/
npm start                    # 单进程同时提供 API 与页面
```

启动后访问 <http://localhost:3000>（开发模式为 <http://localhost:5173>），输入 `PASSWORD` 登录。

> PowerShell 下复制配置模板用 `Copy-Item .env.example .env`。

---

## 启动脚本

### npm scripts

| 命令 | 说明 |
|---|---|
| `npm run dev` | 启动 Vite 开发服务器（端口 5173，`/api` 代理到 `127.0.0.1:3000`，需另行运行 `npm start` 提供后端） |
| `npm run build` | 构建前端产物到 `dist/` |
| `npm run preview` | 本地预览构建产物 |
| `npm start` | 启动生产后端（`node server/index.js`） |

### `run.sh` —— Linux systemd 服务管理

```bash
./run.sh start     # 启动并设为开机自启
./run.sh restart   # 重启
./run.sh stop      # 停止
./run.sh status    # 查看状态
```

依赖名为 `watchdog-os` 的 systemd unit（内部执行 `systemctl enable --now watchdog-os`）。

### 测试脚本

位于 `test/`，零依赖，分两类：

```bash
# 自起 server 子进程（自动注入测试用 JWT_SECRET，无需额外准备）
node test/test-fs-api.js              # 文件管理 API（20 项）
node test/test-runner-api.js          # 脚本任务 API（22 项，无 bash 时跳过）
node test/test-chat-api.js            # 聊天代理 API（25 项）
node test/test-chat-sessions-api.js   # 会话 API（20 项）
```

```powershell
# 连接「已在运行的服务」，需提供访问密码
$env:PASSWORD='<访问密码>'; node test/test-smoke.js        # 端到端冒烟（31 项，默认 http://localhost:3000）
$env:PASSWORD='<访问密码>'; node test/test-basepath.js     # 子路径部署冒烟（默认 http://localhost:3001）
```

---

## 配置说明

**配置的唯一来源是项目根目录的 `.env`。** 服务启动时读取 `.env`（同名真实环境变量优先），再叠加代码内置默认值。

优先级（高 → 低）：

```
进程环境变量  >  项目根 .env 文件  >  代码内置默认值
```

- **未设置与空串一律视为「未设置」**并回退默认值——避免 `.env` 里写了空值就把配置清零
- 非法值（数字、JSON 数组等）在启动日志打印 `[warn]` 并回退默认值
- `.env` 已在 `.gitignore` 中，请勿提交；字段总览见 `config.example.json`（入库模板，**不参与配置**）

### `.env`

```bash
# ── 必配 ──────────────────────────────────────────────
PASSWORD=你的访问密码
JWT_SECRET=用 openssl rand -hex 32 生成的 64 位十六进制串

# ── 服务 ──────────────────────────────────────────────
PORT=3000                # 监听端口
HOST=0.0.0.0              # 监听地址（0.0.0.0 = 所有网卡）
BASE_PATH=/              # 子路径前缀，如 /tkp/（无需尾斜杠）

# ── 监控采样 ──────────────────────────────────────────
DISK_MOUNTS=[]           # 监控的磁盘挂载点，JSON 数组；留空按平台默认
                         # ⚠️ 与 FS_ROOTS 不同：这里是采样目标，FS_ROOTS 是文件管理器权限白名单
COLLECT_INTERVAL=2000    # CPU/内存采样间隔（ms）
DOCKER_INTERVAL=5000     # docker stats 刷新间隔（ms）
PROCESS_INTERVAL=10000   # 进程列表刷新间隔（ms）
PROCESS_TOP_N=50         # 进程列表返回条数（按 CPU 排序）

# ── 会话安全（可选，有合理默认值）────────────────────
JWT_EXPIRES_IN=86400     # 令牌有效期（秒），自动收敛到 300 ~ 2592000
COOKIE_SECURE=auto       # auto（默认，仅 HTTPS 请求附加 Secure）/ always / never
PUBLIC_ORIGIN=           # 终端 WS 的 Origin 白名单，逗号分隔；留空 = 仅同源

# ── 文件管理器（可选）────────────────────────────────
FS_ROOTS=                # 允许浏览的根目录，按系统分隔符（Windows 用 ;，Linux 用 :）
                         # 留空：Windows = 项目所在盘 + C:\，Linux = /
                         # 例：FS_ROOTS=/data:/home     例：FS_ROOTS=C:\;D:\

# ── 终端 ttyd（可选）────────────────────────────────
TERMINAL_ENABLED=false  # true / 1 / yes / on 开启
TTYD_PATH=ttyd           # ttyd 可执行文件路径
TTYD_PORT=7681           # 仅监听 127.0.0.1
TTYD_ARGS=["bash"]       # 要运行的 shell 及参数，JSON 数组
TTYD_WSL=false           # Windows 下经 WSL 运行 Linux 版 ttyd（此时忽略 TTYD_PATH）

# ── 脚本任务 Runner（可选）──────────────────────────
RUNNER_ENABLED=false     # 开启后可在面板触发服务端配置的脚本
RUNNER_SCRIPT=           # 脚本绝对路径（必配，仅服务端可设，客户端不可传）
RUNNER_SHELL=bash        # 执行所用 shell
RUNNER_MAX_LOG_BYTES=5242880  # 日志超过此值归档为 .old

# ── 打印机 CUPS（可选）──────────────────────────────
PRINTER_ENABLED=true     # 关闭后 /api/printer 返回 503
PRINTER_INTERVAL=10000   # 采集间隔（ms）
PRINTER_HISTORY_LIMIT=200  # 历史条数上限

# ── AI 聊天代理 Hermes（可选）───────────────────────
HERMES_ENABLED=false
HERMES_BASE_URL=http://192.168.100.20:8642
HERMES_API_KEY=          # 上游 Bearer（可选）
HERMES_API_SERVER_KEY=   # Sessions API 专用 Bearer，为空则回退 HERMES_API_KEY
HERMES_MODEL=hermes-agent
HERMES_TIMEOUT_MS=300000
```

> `TTYD_ARGS` 默认 `["bash"]`。若 shell 非登录 shell 不会加载用户 profile，导致 `~/.local/bin`、mise 管理的命令等「command not found」，建议改为 `TTYD_ARGS=["bash","-l"]` 或 `TTYD_ARGS=["zsh","-l"]` 对齐 ssh 登录环境。

---

## 可选功能依赖

| 功能 | 依赖 | 未安装 / 未启用时 |
|---|---|---|
| 网页终端 | `ttyd` ≥ 1.7 | `/api/terminal/token` 返回 503，终端窗口显示提示并自动重连 |
| 脚本任务 | `bash` + 可执行脚本 | Runner 窗口显示未启用或启动失败 |
| 打印机 | CUPS（`lpinfo` / `ipptool`） | `/api/printer` 返回 `available: false` |
| Docker 面板 | `docker` CLI 在 PATH 中 | 显示不可用及错误原因 |
| 文件管理器 | 无 | — |

**Windows 本地联调终端**：可用 `tools/mock-ttyd.cs`（模拟 ttyd 的 HTTP `/token` + WebSocket 帧回显）：

```powershell
C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe /nologo /out:tools\ttyd.exe tools\mock-ttyd.cs
# 再设置 TTYD_PATH 指向该 exe、TERMINAL_ENABLED=true 启动服务
```

更接近生产的做法是经 WSL 运行真实 ttyd（`TTYD_WSL=true`），详见 `AGENTS.md`。

---

## 目录结构

```
server/              # 零依赖后端
  index.js           # 入口（瘦入口，组装模块与生命周期）
  config.js          # 配置加载（.env，唯一来源）
  router.js          # 路由分发与 WS 升级
  static.js          # 静态资源服务
  lib/               # HTTP 工具 / JWT 鉴权
  api/               # 各功能 API 模块
src/                 # React 前端源码
public/              # 旧版零依赖前端（仅 dist/ 不存在时回退使用，勿放新资源）
dist/                # 前端构建产物
test/                # 冒烟测试脚本
tools/               # 开发工具（mock-ttyd 源码与产物）
data/                # 运行时数据（收藏夹、任务日志等，自动生成）
run.sh               # Linux systemd 服务管理
```

## 常见问题

**启动报 `[fatal] 未配置访问密码` / `[fatal] JWT 签名密钥未配置或过短`**
在项目根目录 `.env` 中补齐 `PASSWORD` 与 `JWT_SECRET`（后者需 ≥32 字节，可用 `openssl rand -hex 32` 生成）。

**生产部署（systemd）**
把 `.env` 放在服务目录，并在 unit 文件中声明，即可自动加载：
```ini
[Service]
EnvironmentFile=/root/watchdog-os/.env
ExecStart=/usr/bin/node /root/watchdog-os/server/index.js
```

**配置改了不生效**
`.env` 只在进程启动时读取，改完必须重启进程。

**登录成功但页面立刻要求重新登录**
若部署在纯 HTTP 下且设置了 `COOKIE_SECURE=always`，浏览器不会发送 `Secure` Cookie。改回 `auto`（默认）即可。

**改了密码，已登录用户没有被踢下线**
预期行为：`PASSWORD` 与 `JWT_SECRET` 已解耦，换密钥才会使旧令牌失效。

**终端提示「ttyd 未运行 / Terminal unavailable」**
服务会按 5s → 60s 退避自动重试。检查 ttyd 是否安装、端口是否被其它 ttyd 实例占用（同一台机器只能有一个 ttyd 监听同一端口）。

## 开发规范

编码约定、架构细节、安全约定与菜单设计规范见 [`AGENTS.md`](./AGENTS.md)。