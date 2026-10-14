# AGENTS.md — watchdog-os 项目指南

本文件为 AI 编码代理（以及新加入的开发者）提供本项目的关键上下文。修改代码前请先阅读本文件。

## 项目概述

**watchdog-os** 是一个系统探针监控应用（Classicy 桌面版），用于采集并展示服务器的 CPU / 内存 / 交换分区 / 硬件温度 / 磁盘使用率 / Docker 容器 / 进程列表等指标。

- 版本：2.0.0，许可证：MIT
- 前端：React 19 + TypeScript + Vite，UI 组件库为 `classicy`（仿 Mac OS 9 桌面风格）
- 后端：`server/index.js` —— **零依赖** Node.js 原生 HTTP 服务（无 Express 等框架）
- 部署：支持 basePath 子路径（如 `/tkp/`），可置于 Nginx 反向代理之后；Linux 下通过 systemd（`run.sh` 管理 `watchdog-os` 服务）

## 常用命令

```bash
npm run dev       # 启动 Vite 开发服务器（端口 5173，/api 代理到 127.0.0.1:3000）
npm run build     # 构建产物到 dist/
npm run preview   # 预览构建产物
npm start         # 启动生产后端（node server/index.js，默认端口 3000；需先配好 PASSWORD 与 JWT_SECRET）
node test/test-fs-api.js            # 文件管理 API 冒烟测试（自起自停 server 子进程）
node test/test-runner-api.js        # Runner API 冒烟测试（自起自停 server 子进程，无 bash 时跳过）
node test/test-chat-api.js          # Hermes 聊天代理 API 冒烟测试（自起 mock 上游）
node test/test-chat-sessions-api.js # Hermes 会话 API 冒烟测试
# 以下两个连接「已在运行的服务」，需带 PASSWORD 环境变量
$env:PASSWORD='<访问密码>'; node test/test-smoke.js       # 端到端冒烟（默认 BASE_HOST=http://localhost:3000）
$env:PASSWORD='<访问密码>'; node test/test-basepath.js    # basePath 子路径冒烟（默认 BASE_HOST=http://localhost:3001）
./run.sh start|restart|stop|status   # Linux 服务器上的 systemd 服务管理
```

> ⚠️ 测试脚本统一放在 `test/`，运维/同步类脚本放在 `scripts/`。自起服务的脚本会自行注入测试用 `JWT_SECRET`，连接既有服务的脚本需自行提供 `PASSWORD`。

### Windows 本地联调终端功能（mock ttyd）

服务器上需真实安装 ttyd；Windows 本地可用 `tools/` 下的 mock 模拟 ttyd（HTTP /token + WebSocket 帧回显）：

```powershell
# 1. 编译（一次即可；源码 tools/mock-ttyd.cs，使用系统自带 C# 编译器）
C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe /nologo /out:tools\ttyd.exe tools\mock-ttyd.cs

# 2. 启动服务（server/index.js 会自动把 tools\ttyd.exe 当作 ttyd 拉起，监听 127.0.0.1:7681）
$env:PASSWORD='test123'; $env:JWT_SECRET='dev-only-secret-0123456789abcdef0123456789'; $env:TERMINAL_ENABLED='true'
$env:TTYD_PATH='d:\fankangsong\srv-dashboard\tools\ttyd.exe'
node server/index.js
```

然后访问 Dashboard 打开 Terminal 窗口，输入字符会被 mock 回显（`mock-ttyd shell ready` 横幅）。

### Windows 本地联调终端功能（WSL 运行真实 ttyd）

比 mock 更接近生产：WSL 发行版（如 Ubuntu）内安装真实 ttyd，由 server/index.js 经 `wsl.exe` 拉起（`TTYD_WSL=1` / `terminal.wsl`，仅 Windows 生效，此时忽略 `TTYD_PATH`）。WSL2 会把 WSL 内监听的端口自动转发到 Windows 的 `127.0.0.1`，后端代理无需任何改动：

```powershell
# 1. WSL 内安装 ttyd（apt 或免 sudo 的静态二进制二选一）
wsl -e bash -lc 'sudo apt-get install -y ttyd'
# 或：
wsl -e bash -lc 'mkdir -p ~/.local/bin && curl -fsSL -o ~/.local/bin/ttyd https://github.com/tsl0922/ttyd/releases/download/1.7.7/ttyd.x86_64 && chmod +x ~/.local/bin/ttyd'

# 2. 启动服务（.env 加 TTYD_WSL=true，或临时设环境变量）
$env:PASSWORD='test123'; $env:JWT_SECRET='dev-only-secret-0123456789abcdef0123456789'; $env:TERMINAL_ENABLED='true'; $env:TTYD_WSL='true'
node server/index.js
```

- 实际启动命令为 `bash -lc 'pkill -x ttyd 2>/dev/null; exec ttyd -W "$@"' -i 127.0.0.1 -p <port> <ttydArgs...>`：先清理 WSL 内残留的 ttyd（server 被强杀后会遗留占用端口，下次启动自愈），再以登录环境拉起（`~/.profile` 的 PATH 生效，`~/.local/bin/ttyd` 可见）；`-W` 必需（ttyd 1.7.x 起默认只读，不加则键盘输入无效），要求 WSL 内 ttyd ≥ 1.7.x
- 终端 shell 由 `ttydArgs` 决定（默认 `["bash"]`），工作目录为项目目录（wsl.exe 继承 Windows cwd）；建议 `["bash", "-l"]` 对齐 ssh 登录环境
- ⚠️ `pkill` 不分端口：同机同时运行多个「负责拉起 ttyd 的 server/index.js 实例」（含 WSL 内原生运行的）会互相清理对方 ttyd 形成乒乓重启，请只跑一个实例

注意：项目同时存在 `package-lock.json` 和 `pnpm-lock.yaml`，优先使用 **npm**。

## 后端配置

**配置的唯一来源是项目根目录的 `.env`**（由 `server/config.js` 的 `loadEnv()` 读入 `process.env`，同名真实环境变量优先）。`config.example.json` 是入库的字段总览模板（各 32 项，凭据留空），仅供查阅。解析规则：**未设置与空串一律视为「未设置」并回退默认值**，非法值打 `[warn]` 后回落。

配置项分组（完整清单见 `.env.example` / `config.example.json`）：

| 分组 | 变量 | 默认值 |
|---|---|---|
| **必配** | `PASSWORD`（访问密码）、`JWT_SECRET`（HS256 密钥，≥32 字节） | 无（缺失即拒绝启动） |
| 服务 | `PORT` / `HOST` / `BASE_PATH` | `3000` / `0.0.0.0` / `/` |
| 采样 | `DISK_MOUNTS`(JSON 数组) / `COLLECT_INTERVAL` / `DOCKER_INTERVAL` / `PROCESS_INTERVAL` / `PROCESS_TOP_N` | `[]` / `2000` / `5000` / `10000` / `50` |
| 会话 | `JWT_EXPIRES_IN`（收敛到 `300~2592000`）/ `COOKIE_SECURE`（`auto`/`always`/`never`）/ `PUBLIC_ORIGIN`（逗号分隔，留空=仅同源） | `86400` / `auto` / 空 |
| 文件管理 | `FS_ROOTS`（`path.delimiter` 分隔；**与 `DISK_MOUNTS` 语义不同**：前者是文件管理器权限白名单，后者是监控采样目标） | 按平台默认 |
| 终端 | `TERMINAL_ENABLED` / `TTYD_PATH` / `TTYD_PORT` / `TTYD_ARGS`(JSON 数组) / `TTYD_WSL` | `false` / `ttyd` / `7681` / `["bash"]` / `false` |
| Runner | `RUNNER_ENABLED` / `RUNNER_SCRIPT`（必配绝对路径）/ `RUNNER_SHELL` / `RUNNER_MAX_LOG_BYTES` | `false` / `''` / `bash` / `5242880` |
| 打印机 | `PRINTER_ENABLED` / `PRINTER_INTERVAL` / `PRINTER_HISTORY_LIMIT` | `true` / `10000` / `200` |
| Hermes | `HERMES_ENABLED` / `HERMES_BASE_URL` / `HERMES_API_KEY` / `HERMES_API_SERVER_KEY` / `HERMES_MODEL` / `HERMES_TIMEOUT_MS` | `false` / `http://192.168.100.20:8642` / `''` / `''` / `hermes-agent` / `300000` |

> `JWT_SECRET` 可用 `openssl rand -hex 32` 生成。**密钥与密码是两个独立秘密**：不要用密码派生密钥（旧实现下任意一个泄露的 token 都能离线反推密码），也不要复用同一字符串。换密钥等价于让所有人重新登录；改密码则不会影响已签发的 token。

> **生产部署**：配置只认 `.env`，systemd 建议加 `EnvironmentFile=/root/watchdog-os/.env`；`.env` 不在版本控制内，需手工维护。

> **新增配置项的规矩**：在 `server/config.js` 里用 `envStr` / `envInt` / `envBool` / `envJsonArray` 声明（不要裸写 `process.env.X`，否则空串与非法值会静默污染配置），并同步更新 `.env.example` 与 `config.example.json`（两者键名必须一致）。

Runner（脚本任务构建）：由 `RUNNER_ENABLED` / `RUNNER_SCRIPT` / `RUNNER_SHELL` / `RUNNER_MAX_LOG_BYTES` 控制，`RUNNER_SCRIPT` 为必配的脚本绝对路径且只接受服务端配置（客户端不可传路径）；日志写 `data/runner.log`（超过 `RUNNER_MAX_LOG_BYTES` 归档为 `.old`）。

## 会话鉴权安全约定

- **无默认口令**：`PASSWORD` 未配置时进程直接退出（内置默认口令会让「以为改了配置」的部署直接暴露在局域网）。
- **只认 Cookie**：`checkAuth` 仅从 HttpOnly 会话 Cookie 取令牌，**不接受** `Authorization: Bearer` / `x-auth-token`（令牌不应脱离浏览器使用）。脚本化调用请从 `/api/login` 的 `Set-Cookie` 取 `name=value` 段放到 `Cookie` 头。
- **令牌不回传**：`/api/login` 响应体只有 `{ ok, expiresIn }`，token 仅存在于 `Set-Cookie`；Cookie 属性为 `Path=BASE; HttpOnly; SameSite=Lax` + 按策略追加的 `Secure`。
- **WS 来源校验**：终端 WS 升级在鉴权之后额外校验 `Origin`（缺 `Origin` 放行以兼容 curl / 脚本；跨站来源一律拒绝）。反向代理或跨协议访问时显式配置 `PUBLIC_ORIGIN`。
- **签名校验固定 HS256**：`verifyJwt` 不读取 `header.alg`（`alg:none` 与 RS256→HS256 混淆攻击因此不成立），签名用 `timingSafeEqual` 常数时间比较，`exp` 必须为有限数字。
- **会话不可吊销**（已知取舍）：`/api/logout` 只清 Cookie，服务端无会话表，泄露的 token 在 `JWT_EXPIRES_IN` 内始终有效。缩短有效期是当前唯一的缓解手段。
- ✅ **终端端口的网络隔离（已评估，当前接受）**：ttyd 以 `-i 127.0.0.1` 启动，只监听回环地址（实测确认，不绑 `0.0.0.0`），且对外只暴露面板端口、经反向代理 /端口转发访问。**走面板的 WS 路径必须先过 JWT 校验**（实测：无 Cookie / 伪造 `Authorization` / 伪造 `x-auth-token` 一律被拒，正确 Cookie 才升级），因此互联网与局域网攻击者都无法触达终端。
- ⚠️ **已知风险（已评估为可接受，暂缓修复）**：ttyd 未配置 `-c` 凭据时，**直连 `127.0.0.1:<ttydPort>/ws` 连 token 都不需要**即可握手成功（ttyd 1.7.7 实测：无凭据 `GET /token` 返回 `{"token":""}`，`/ws` 直接 `101 Switching Protocols`）——即本机进程可绕过面板口令取得终端 shell。当前部署为**单机单用户**，无本机恶意进程、面板自身也不存在可利用的 SSRF（`/api/fs/*` 有允许根白名单、`/api/chat/*` 目标地址写死在服务端配置），故判定为可接受。
  - **结论失效的条件（出现任一即需修复）**：① 机器上运行其他不可信/多用户服务；② 出现可对 `127.0.0.1` 发请求的 SSRF 面；③ ttyd 改为监听非回环地址或被反向代理直接暴露 `/ws`；④ 部署从单机变为多用户或容器共享 host 网络。
  - 修法（两处）：`startTtyd()` 在 `-p` 后加 `-c <user:pass>`；`proxyTerminalToken()` 注入 `Authorization: Basic base64(user:pass)` 代换token（凭据仅存服务端配置，不下发浏览器）。注意 WSL 模式下 `-c` 会随 `"$@"` 展开进 `exec ttyd`，勿破坏位置参数。
  - 注：`101 Switching Protocols` 只是 WebSocket 协议升级成功信号，**不是认证结果**；认证发生在返回 101 之前。

## 目录结构与关键约定

```
```
server/              # 零依赖后端（CommonJS，只用 Node 内置模块）
  index.js           # 入口：组装各模块与生命周期（采集定时器、退出时清理 ttyd/runner）
  config.js          # 配置加载（.env，唯一来源）+ basePath 规范化
  router.js          # API 路由分发与 WS 升级处理
  static.js          # 静态资源服务（dist/ 优先，回退 public/）
  lib/               # http.js 基础工具 / auth.js JWT 鉴权
  api/               # metrics / printer / terminal / runner / chat / fs
public/              # ⚠️ 旧版零依赖前端（server/index.js 回退用），不是 Vite 静态资源目录
src/                 # React 前端源码
  apps/              # 桌面应用窗口：MonitorApp（监控）、DockerApp（容器）、ImcolinApp、TerminalApp（终端）、FinderApp（Finder，文件管理器）、EditorApp（文本编辑器）、RunnerApp（脚本任务构建）
  components/        # 展示组件：Gauge、HistoryChart、DockerTable、CodeEditor（CodeMirror 6 封装）、MarkdownPreview、各信息面板
  hooks/             # usePolling —— 数据轮询 Hook
  api.ts             # 后端 API 封装（含 getTerminalToken、/api/fs/* 文件管理）
  editorBridge.ts    # Finder → 文本编辑器 跨应用打开文件的联动桥
  Desktop.tsx        # 桌面布局
  LoginApp.tsx       # 登录（标题固定 WatchDog OS：未登录不展示主机名；登录后由 MonitorApp 把文档标题同步为「WatchDog OS · 主机名」）
  format.ts          # 格式化工具
vite.config.ts       # Vite 配置（见下方注意事项）
dist/                # 构建产物（勿手动修改）
test/                # 零依赖冒烟测试脚本（自起 server 子进程或连接既有服务）
docs/                # design/ 交互设计参考图（外部范本）；design-spec.md 全套交互与设计规范
run.sh               # Linux systemd 服务管理入口（保持项目根，不在 scripts/ 内）
```

### 终端模块（TerminalApp + ttyd）

- `server/index.js` 启动时按 `terminal` 配置节 spawn ttyd 子进程（仅监听 127.0.0.1），收到 SIGTERM/SIGINT 时先 SIGTERM 清理子进程；ttyd 启动失败（未安装 / 端口被占用等）不会禁用终端，而是透传其 stderr 诊断信息并按 5s→60s 退避自动重试（主服务不受影响）
- 配置：`terminal.enabled`（默认 false，可用 `TERMINAL_ENABLED` 环境变量开启）、`ttydPath`、`ttydPort`（默认 7681）、`ttydArgs`、`wsl`（Windows 下经 WSL 运行 Linux 版 ttyd，见上文 Windows 联调章节）。⚠️ 端口不可与其他 ttyd 实例（如发行版自带的 `ttyd.service`）冲突，否则终端不可用
- `terminal.ttydArgs`：传给 ttyd 的要运行 shell 及参数，默认 `["bash"]`。⚠️ **坑**：ttyd 继承的是 systemd 的最小 PATH 且 `bash` 非登录 shell 不加载用户 profile，导致用户自行安装的命令（如 mise 管理的 `pi`、`~/.local/bin` 等）在 Dashboard 终端里「command not found」。服务器（tkp）上已改为 `TTYD_ARGS=["zsh","-l"]`（在远端 `.env` 配置，同步脚本不上传 `.env`，不会回退），使终端与 ssh 登录环境一致（交互式登录 zsh 会加载 `~/.zshrc`，含 `eval "$(mise activate zsh)"`）
- 鉴权：`/api/terminal/token`（HTTP 转发 ttyd /token）与 `/api/terminal/ws`（upgrade 裸 TCP 管道转发到 ttyd /ws）均先走 `checkAuth` JWT 校验（只认 Cookie），再判启用状态（401 优先于 503）；WS 升级在鉴权之后额外校验 `Origin`（见「会话鉴权安全约定」）。`503 Terminal disabled` 表示配置未启用，`503 Terminal unavailable` 表示 ttyd 进程未就绪（前端会显示浮层并每 5s 自动重连）
- 前端 `src/apps/TerminalApp.tsx`：xterm.js（@xterm/xterm + @xterm/addon-fit）直连代理后的 WebSocket，实现 ttyd 二进制帧协议（服务端首字节 `0` 输出 / `1` 标题；客户端 `0` 输入 / `1` resize + 首条 JSON 认证消息）。握手必须声明子协议 `tty`（`new WebSocket(url, 'tty')`），1.6.x / 1.7.x 均要求，否则连接会被立即关闭（黑屏无输出）
- WS 代理为裸 TCP 管道（`net.connect` 改写请求行后双向 pipe），不实现 WS 帧编解码；修改升级逻辑时保持 Cookie / `Authorization` / `x-auth-token` 均不外传给 ttyd、对端 socket 对称销毁

### Runner（脚本任务构建，RunnerApp + `/api/runner/*`）

- 后端 `server/index.js` 以 `spawn(shell, [脚本名])`（cwd 为脚本所在目录；用相对名 + cwd 而非绝对路径，兼容 Windows Git Bash 的 POSIX 路径限制）执行服务端配置的脚本（生产为 running_page 的 `build.sh`），stdout/stderr 合并落盘 `data/runner.log`，构建开始写分隔头、结束写 `[exit code N]`；同时只允许一个任务（内存单槽锁，重复触发 409），`SIGINT/SIGTERM/exit` 时对运行中任务 SIGTERM
- API（统一 `checkAuth`，401 优先）：`POST /api/runner/start`（立即返回不阻塞；未启用 503 `Runner disabled`、重复 409、脚本不存在 400）、`GET /api/runner/status?lines=N`（信息性接口，未启用也 200 返回 `enabled:false`；含 running/job/last 摘要与日志尾部，lines 上限 2000）、`POST /api/runner/stop`（SIGTERM 中断，空闲 409）
- 安全约定：脚本路径只来自服务端配置（`.env` 的 `RUNNER_SCRIPT`），客户端不可传路径；能触发 = 能登录（与终端/文件管理同级鉴权）
- 前端 `RunnerApp`：状态区（Idle/Running/上次结果）+ Build/Stop 按钮 + 等宽日志区；轮询间隔运行中 2s、空闲 10s，新日志自动滚底
- ⚠️ `build.sh` 含 `git push` 与 COS 上传等真实发布动作，Windows 本机验证 UI 时不要点击 Build

### Finder（文件管理器）/ 文本编辑器（FinderApp / EditorApp + `/api/fs/*`）

- 后端 `server/api/fs.js` 的 `/api/fs/*` 全部零依赖实现且统一走 `checkAuth`：`list`（列目录，不传 path 返回允许根列表）、`read`（文本读取，2MB 上限 + NUL 字节二进制嗅探）、`raw`（原始流：仅图片内联供 `<img>` 预览，其余一律 `attachment` 下载防内联 XSS）、`write`（PUT 文本保存；`?create=1` 为新建语义，已存在返回 409）、`upload`（POST raw body 流式上传，50MB 上限，`?overwrite=1` 覆盖）、`mkdir` / `delete`（递归）/ `rename`、`favorites`（GET/PUT，持久化到 `data/favorites.json`，临时文件 + rename 原子写）
- 安全约定：所有路径经 `path.resolve` 规范化并校验在允许根内（`FS_ROOTS` 环境变量可覆盖，默认 Windows 为项目盘符 + C 盘、POSIX 为 `/`）；根目录禁止删除/重命名；文件名清洗只取 basename
- ⚠️ **Windows ReFS/Dev Drive 坑**：刚写入文件的 `stat.size` 可能是预分配值（元数据延迟），`raw` 接口因此**不设 Content-Length**（chunked 读到 EOF）；`list` 的大小列在 Dev Drive 上刚写入时也可能短暂虚高，生产 Linux 无此问题
- 前端 `FinderApp`：SplitView 左（收藏夹 + ClassicyTree 目录树懒加载）/ 右（ClassicyTable 多选文件列表：名称/大小/修改时间/权限），工具栏 + 右键菜单（打开/编辑/下载/重命名（可改扩展名）/删除/收藏/新建文件夹/新建文本文件），上传用 XHR 出进度条，预览为独立 ClassicyWindow（图片内联 / Markdown 渲染可切源码 / 文本只读高亮）
- 前端 `EditorApp`：CodeMirror 6（`@codemirror/lang-*` 按扩展名动态 import，社区主题 `@uiw/codemirror-theme-*`：Dracula / GitHub Dark / GitHub Light / VSCode Dark），保存（Ctrl/Cmd+S）/撤销/重做/查找（Mod-F），Markdown 分栏预览（marked + DOMPurify），主题/字号/字体偏好存 localStorage，未保存关闭有 `onBeforeClose` veto 确认
- 跨应用联动：`src/editorBridge.ts` 的 `openInEditor(path)` —— 记录 pendingPath + dispatch `ClassicyAppOpen`/`ClassicyWindowOpen` + DOM 事件双通道（挂载消费 pending、已挂载走事件），避免竞态

### Chat（ChatApp + `/api/chat/*`：聊天代理 + hermes Sessions 转发）

- 后端 `server/api/chat.js` 两个转发函数，路由在 `server/router.js` 的 chat 块（先 watchdog JWT `checkAuth` 401，再 `hermes.enabled` 503）：
  - `proxyHermesChat`：`POST /api/chat/completions` → 上游 `POST {baseUrl}/v1/chat/completions`（流式 SSE 逐块 pipe 透传，非流式收集回传）。**双向透传 `X-Hermes-Session-Id` 头**：客户端请求头（白名单正则校验后）转发上游，让 hermes 把多轮记入同一 transcript；上游 2xx 响应头回显给前端（前端据此把新会话关联到服务端 transcript）
  - `proxyHermesSessions`：`/api/chat/sessions`（列表，转发 query）· `/api/chat/sessions/{id}`（元数据 / DELETE）· `/api/chat/sessions/{id}/messages`（历史，带 `inline_images=false`）→ 上游 `/api/sessions*`。超时 15s（快操作，区别于 chat 的 300s）
  - **上游 401/403 必须映射 502**：前端 `request()` 把 watchdog 自身 401 当登出信号（Unauthorized），而 Sessions API 的 401 表示服务端 `hermes.apiServerKey` 配错，透传会导致误登出
- 鉴权：上游 Bearer 优先 `hermes.apiServerKey`（API_SERVER_KEY），为空回退 `hermes.apiKey`；两者均仅服务端持有，不回传任何响应
- 前端 `ChatApp.tsx`（混合模式）：**发送**走 completions（无状态协议，全量重传 messages，`streamChat` 带 `sessionId` 请求头 / `onSessionId` 消费响应头——首次发送后关联 `currentId`）；**会话列表/历史**以服务端为准（`fetchChatSessions` / `fetchChatSessionMessages` + 容错适配器，hermes 响应字段官方未详述，按候选键宽松提取，仅保留 user/assistant 消息）。`currentId=null` 表示未关联的新会话；切换会话每次都重新拉取服务端历史（`loadSeqRef` 序号防乱序）；本地**不做持久化**（挂载时一次性清理旧版 `watchdog-chat-history` / `watchdog-chat-sessions` / `watchdog-chat-session:*` key）
- 会话列表窗口 `chat-sessions`：常驻渲染树 + dispatch Open/Focus 显隐；四态（Loading / error+Retry / empty / ClassicyTable）；Refresh / Delete… 工具栏（删除走 ClassicyAlert caution 确认，删除当前会话回空会话）；单击行切换、双击/Enter 切换并关窗
- ⚠️ 带会话请求头理论上可能造成 hermes 上下文重复（transcript 注入 + 全量重传）：若实测发现重复，回退方式为前端 `streamChat` 不传 `sessionId`（代理双向透传保留，无需改后端）

### 重要注意事项

1. **`vite.config.ts` 中 `publicDir: false`**：`public/` 是旧版零依赖前端的回退目录，绝不能被 Vite 拷入 `dist`（会与构建产物冲突）。新增静态资源请勿放进 `public/`。
2. **`base: './'`**：构建产物使用相对路径，SPA 可在任意 basePath 子路径下直接运行。改动 `vite.config.ts` 时保持此行为。
3. **`server/index.js` 零依赖**：只使用 Node.js 内置模块，不要引入第三方 npm 依赖。
4. **鉴权**：会话校验（`checkAuth`，只认 HttpOnly Cookie）贯穿 REST API、WS 升级与静态页面，改动路由或静态服务逻辑时注意保持鉴权一致；新增需要鉴权的接口时用 `checkAuth` 而非自建校验。
5. **basePath**：后端与前端均需支持子路径部署，新增 API 路由时注意挂载在 `BASE` 前缀之下。
6. **Node 版本**：`engines` 要求 `>=18.15`。
7. **不新增鉴权旁路**：不要引入 `Authorization` / `x-auth-token` 之类的头鉴权、CORS 头或第三方 auth 中间件；会话只经 Cookie 传递（详见「会话鉴权安全约定」）。

## 菜单设计规范（macOS / classicy）

> 参照 classicy 内置 Finder（Macintosh HD）示例应用的菜单与 macOS HIG 制定。所有应用（新增或改造）的菜单栏必须遵循本节规范；界面文案统一使用英文（代码注释仍用中文）。

### 菜单栏结构

菜单栏由 `ClassicyDesktop` 自动渲染，**应用只负责提供 `appMenu`**，不要自己拼装整条菜单栏。最终结构（从左到右）：

```
[Apple 菜单] [应用名菜单] [File] [Edit] [View] [应用特有菜单…] [Help] [应用切换器] [小组件]
```

- **Apple 菜单**：系统渲染。`About {AppName}` 自动从 appMenu 中 id 以 `_about` 结尾（或 title 为 `About`）的项提升而来；其后是 `systemMenu` 注入项。本项目已在 `src/Desktop.tsx` 统一注入 `Sign Out`——**各 app 不得再自建 System/Sign Out 菜单**。
- **Help 菜单**：系统渲染（含 About Balloon Help… / Show|Hide Balloons ⌥H）。应用需要增加帮助项时，用 `useClassicyHelpMenu(appId, items)` 注册（`items` 必须用 `useMemo` 保持引用稳定），**不要在 appMenu 里自建 Help 菜单**。
- **应用名菜单**：appMenu 的第一组，title 为应用名，只放应用级命令，不放具体功能。

### 各菜单组的标准内容（新功能按类别归位）

| 菜单组               | 应放入                                                                                                                                                                                                                  | 参考示例（Finder）                                              |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| 应用名菜单（第一组） | `About X`（`useClassicyAboutMenu` 的 `aboutMenuItem`，自动提升进 Apple 菜单）、spacer、`Preferences…`、spacer、`Quit`（`quitMenuItem`）                                                                                 | About Finder / Quit                                             |
| File                 | 文档与对象生命周期：New / Open… / Save / Close / Rename… / 上传下载等                                                                                                                                                   | Close Window、Close All Windows                                 |
| Edit                 | 文本与选择：Undo / Redo / Cut / Copy / Paste / Select All / Find。**有文本输入的 app 直接用 `useClassicyEditMenu(idPrefix)`**（作用于最后聚焦的文本框）；仅当操作对象不是文本框（如 Finder 的文件选择）才自建并内联实现 | Select All ⌘A（仅列表视图可用时 enabled）、spacer、Preferences… |
| View                 | 显示方式：视图切换（View as Icons / View as List）、显示/隐藏元素（Show Hidden Files）、排序、Refresh、缩放。视图切换组内互斥项用 `checked` 标记当前项                                                                  | View as Icons / View as List                                    |
| 应用特有菜单         | 仅当上述分组都不合适（如 Terminal 的 Font Size / Font Family、Chat 的会话管理），放在 View 之后、Help 之前                                                                                                              | —                                                               |
| Help（系统渲染）     | 经 `useClassicyHelpMenu` 注册：帮助文档、快捷键说明等                                                                                                                                                                   | Show/Hide Balloon Help                                          |

- 关键 Hook / 工具（均从 `classicy` 导入）：`useClassicyAboutMenu`（返回 `{ aboutMenuItem, aboutWindow }`，`aboutWindow` 需渲染进组件树）、`useClassicyEditMenu`、`useClassicyHelpMenu`、`useClassicyWindowClose`；项目封装 `src/quitMenuItem.ts`（Quit 项，走 `ClassicyAppClose`）。菜单关闭窗口用 `closeWindowMenuItemHelper` / `closeAllWindowsMenuItemHelper`。

### 菜单项书写规则

1. **数据结构** `ClassicyMenuItem`：`id`（必填）、`title`、`disabled`、`checked`、`keyboardShortcut`、`event`+`eventData`（声明式派发 store action）或 `onClickFunc`（本地处理）、`menuChildren`（子菜单）、`balloon`。
2. **id 命名**：`<app前缀>-m-<命令>`（如 `fm-m-newdir`、`ed-m-save`），全局唯一；分隔线固定 `{ id: 'spacer' }`，不要出现在组首/组尾/连续（渲染器会清理，但源数据也要干净）。
3. **文案**：英文 Title Case，动词开头；直接执行的命令不加标点（`Save`、`Refresh`），**会再弹出对话框的命令以 `…` 结尾**（`New Folder…`、`Open…`、`Preferences…`）；破坏性命令（`Delete…`）同样加 `…` 且执行前必须确认弹窗。
4. **切换项**：二选一——要么固定标题 + `checked` 表达状态（`Show Hidden Files` checked），要么双态标题（`Show Balloon Help` / `Hide Balloon Help`）。**禁止手动拼 `✓ ` 前缀**，一律用 `checked` 字段。
5. **快捷键**：符号字形风格 `⌘S`、`⇧⌘Z`、`⌥H`（⌘ Cmd、⇧ Shift、⌥ Option、⌃ Control），**禁止 `Cmd+S` 写法**；浏览器已占用的组合不要绑定。
6. **可用性**：命令暂不可执行时保留菜单项并置 `disabled`（如 Finder 的 Select All 在图标视图置灰），不要按状态隐藏菜单项。
7. **性能**：`appMenu` 一律 `useMemo` 记忆化（classicy 的 Help 注册与菜单渲染依赖引用稳定）。

### 新增应用菜单的最小模板

```tsx
const { aboutMenuItem, aboutWindow } = useClassicyAboutMenu(
  APP_ID,
  APP_NAME,
  ICON,
);

const appMenu: ClassicyMenuItem[] = useMemo(
  () => [
    {
      id: "x-menu", // 1. 应用名菜单
      title: APP_NAME,
      menuChildren: [
        aboutMenuItem, // 自动提升进 Apple 菜单
        { id: "spacer" },
        quitMenuItem(APP_ID, APP_NAME, ICON),
      ],
    },
    {
      id: "x-file", // 2. File：按需
      title: "File",
      menuChildren: [
        /* … */
      ],
    },
    // 3. Edit（有文本输入则用 hook）：useClassicyEditMenu('x') 返回的项
    // 4. View / 应用特有菜单：按需
  ],
  [
    /* 依赖 */
  ],
);

// 组件树内渲染 {aboutWindow}；帮助项经 useClassicyHelpMenu 注册
```

反例（禁止）：在 appMenu 里自建 `System > Sign Out`（Apple 菜单已有）；手动 `✓ ` 前缀；`Cmd+S` 快捷键写法；中文菜单文案；把具体功能命令塞进应用名菜单。

### 交互与设计规范（全套）

除菜单外，窗口、控件、布局、列表、反馈、视觉、文案、快捷键、数据交互的全套标准见 **[docs/design-spec.md](docs/design-spec.md)**（设计北极星为 `docs/design/` 参考图）。**设计、改造任何应用前必须通读该规范并逐项通过其「新应用创建清单」**；规范与既有实现冲突时，以规范为准修正实现。

## 编码风格

- 前端使用 TypeScript + React 函数组件 + Hooks；类型定义尽量内联在文件中。
- UI 遵循 `classicy` 组件库的风格（复古桌面隐喻）。
- 后端 `server/index.js` 为 CommonJS（`require`），保持模块化、零依赖风格，注释使用中文。
- 提交信息与代码注释均使用中文。

## 验证

改动后请至少验证：

- 前端：`npm run build` 确认无 TS / 构建错误（可用 `npx tsc --noEmit` 做全量类型检查）。
- 后端：`npm start` 后用密码登录，确认指标接口正常返回（未配 `PASSWORD` / `JWT_SECRET` 时进程应拒绝启动并打印 `[fatal]`）。
- 文件管理 API：`node test/test-fs-api.js` 全部 PASS（鉴权/列表/读写/新建文件/上传/收藏/越权防护等 20 项）。
- Runner API：`node test/test-runner-api.js` 全部 PASS（成功/失败/stop/409/401/400/503 等 22 项；无 bash 环境显示 SKIP 属正常）。
- 会话鉴权：`$env:PASSWORD='<密码>'; node test/test-smoke.js` 全部 PASS（31 项，含 Cookie 属性、`Secure` 的 auto 策略、响应体不含 token、请求头不通鉴权、畸形 Cookie 返回 401）。
