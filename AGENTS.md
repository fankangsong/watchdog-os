# AGENTS.md — watchdog-os 项目指南

本文件为 AI 编码代理（以及新加入的开发者）提供本项目的关键上下文。修改代码前请先阅读本文件。

## 项目概述

**watchdog-os** 是一个系统探针监控应用（Classicy 桌面版），用于采集并展示服务器的 CPU / 内存 / 交换分区 / 硬件温度 / 磁盘使用率 / Docker 容器 / 进程列表等指标。

- 版本：2.0.0，许可证：MIT
- 前端：React 19 + TypeScript + Vite，UI 组件库为 `classicy`（仿 Mac OS 9 桌面风格）
- 后端：`server.js` —— **零依赖** Node.js 原生 HTTP 服务（无 Express 等框架）
- 部署：支持 basePath 子路径（如 `/tkp/`），可置于 Nginx 反向代理之后；Linux 下通过 systemd（`run.sh` 管理 `watchdog-os` 服务）

## 常用命令

```bash
npm run dev       # 启动 Vite 开发服务器（端口 5173，/api 代理到 127.0.0.1:3000）
npm run build     # 构建产物到 dist/
npm run preview   # 预览构建产物
npm start         # 启动生产后端（node server.js，默认端口 3000）
node test-fs-api.js                  # 文件管理 API 冒烟测试（自起自停 server 子进程）
node test-runner-api.js              # Runner API 冒烟测试（自起自停 server 子进程，无 bash 时跳过）
./run.sh start|restart|stop|status   # Linux 服务器上的 systemd 服务管理
```

### Windows 本地联调终端功能（mock ttyd）

服务器上需真实安装 ttyd；Windows 本地可用 `tools/` 下的 mock 模拟 ttyd（HTTP /token + WebSocket 帧回显）：

```powershell
# 1. 编译（一次即可；源码 tools/mock-ttyd.cs，使用系统自带 C# 编译器）
C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe /nologo /out:tools\ttyd.exe tools\mock-ttyd.cs

# 2. 启动服务（server.js 会自动把 tools\ttyd.exe 当作 ttyd 拉起，监听 127.0.0.1:7681）
$env:PASSWORD='test123'; $env:TERMINAL_ENABLED='true'
$env:TTYD_PATH='d:\fankangsong\srv-dashboard\tools\ttyd.exe'
node server.js
```

然后访问 Dashboard 打开 Terminal 窗口，输入字符会被 mock 回显（`mock-ttyd shell ready` 横幅）。

### Windows 本地联调终端功能（WSL 运行真实 ttyd）

比 mock 更接近生产：WSL 发行版（如 Ubuntu）内安装真实 ttyd，由 server.js 经 `wsl.exe` 拉起（`TTYD_WSL=1` / `terminal.wsl`，仅 Windows 生效，此时忽略 `TTYD_PATH`）。WSL2 会把 WSL 内监听的端口自动转发到 Windows 的 `127.0.0.1`，server.js 代理无需任何改动：

```powershell
# 1. WSL 内安装 ttyd（apt 或免 sudo 的静态二进制二选一）
wsl -e bash -lc 'sudo apt-get install -y ttyd'
# 或：
wsl -e bash -lc 'mkdir -p ~/.local/bin && curl -fsSL -o ~/.local/bin/ttyd https://github.com/tsl0922/ttyd/releases/download/1.7.7/ttyd.x86_64 && chmod +x ~/.local/bin/ttyd'

# 2. 启动服务（.env 加 TTYD_WSL=true，或临时设环境变量）
$env:PASSWORD='test123'; $env:TERMINAL_ENABLED='true'; $env:TTYD_WSL='true'
node server.js
```

- 实际启动命令为 `bash -lc 'pkill -x ttyd 2>/dev/null; exec ttyd -W "$@"' -i 127.0.0.1 -p <port> <ttydArgs...>`：先清理 WSL 内残留的 ttyd（server 被强杀后会遗留占用端口，下次启动自愈），再以登录环境拉起（`~/.profile` 的 PATH 生效，`~/.local/bin/ttyd` 可见）；`-W` 必需（ttyd 1.7.x 起默认只读，不加则键盘输入无效），要求 WSL 内 ttyd ≥ 1.7.x
- 终端 shell 由 `ttydArgs` 决定（默认 `["bash"]`），工作目录为项目目录（wsl.exe 继承 Windows cwd）；建议 `["bash", "-l"]` 对齐 ssh 登录环境
- ⚠️ `pkill` 不分端口：同机同时运行多个「负责拉起 ttyd 的 server.js 实例」（含 WSL 内原生运行的）会互相清理对方 ttyd 形成乒乓重启，请只跑一个实例

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

Runner（脚本任务构建）：config.json 的 `runner` 节 / 环境变量 `RUNNER_ENABLED` / `RUNNER_SCRIPT` / `RUNNER_SHELL`（默认 `bash`）控制，`scriptPath` 为必配的脚本绝对路径且只接受服务端配置；日志写 `data/runner.log`（超过 `maxLogBytes` 归档为 `.old`）。

## 目录结构与关键约定

```
server.js            # 零依赖后端：采集指标、鉴权、静态文件服务、SSE/轮询 API、终端代理、文件管理 API
public/              # ⚠️ 旧版零依赖前端（server.js 回退用），不是 Vite 静态资源目录
src/                 # React 前端源码
  apps/              # 桌面应用窗口：MonitorApp（监控）、DockerApp（容器）、ImcolinApp、TerminalApp（终端）、FileManagerApp（文件管理器）、EditorApp（文本编辑器）、RunnerApp（脚本任务构建）
  components/        # 展示组件：Gauge、HistoryChart、DockerTable、CodeEditor（CodeMirror 6 封装）、MarkdownPreview、各信息面板
  hooks/             # usePolling —— 数据轮询 Hook
  api.ts             # 后端 API 封装（含 getTerminalToken、/api/fs/* 文件管理）
  editorBridge.ts    # 文件管理器 → 文本编辑器 跨应用打开文件的联动桥
  Desktop.tsx        # 桌面布局
  LoginApp.tsx       # 登录
  format.ts          # 格式化工具
vite.config.ts       # Vite 配置（见下方注意事项）
dist/                # 构建产物（勿手动修改）
```

### 终端模块（TerminalApp + ttyd）

- `server.js` 启动时按 `terminal` 配置节 spawn ttyd 子进程（仅监听 127.0.0.1），收到 SIGTERM/SIGINT 时先 SIGTERM 清理子进程；ttyd 启动失败（未安装 / 端口被占用等）不会禁用终端，而是透传其 stderr 诊断信息并按 5s→60s 退避自动重试（主服务不受影响）
- 配置：`terminal.enabled`（默认 false，可用 `TERMINAL_ENABLED` 环境变量开启）、`ttydPath`、`ttydPort`（默认 7681）、`ttydArgs`、`wsl`（Windows 下经 WSL 运行 Linux 版 ttyd，见上文 Windows 联调章节）。⚠️ 端口不可与其他 ttyd 实例（如发行版自带的 `ttyd.service`）冲突，否则终端不可用
- `terminal.ttydArgs`：传给 ttyd 的要运行 shell 及参数，默认 `["bash"]`。⚠️ **坑**：ttyd 继承的是 systemd 的最小 PATH 且 `bash` 非登录 shell 不加载用户 profile，导致用户自行安装的命令（如 mise 管理的 `pi`、`~/.local/bin` 等）在 Dashboard 终端里「command not found」。服务器（tkp）上已改为 `["zsh", "-l"]`（在远端 `config.json` 配置，同步脚本不上传 config.json，不会回退），使终端与 ssh 登录环境一致（交互式登录 zsh 会加载 `~/.zshrc`，含 `eval "$(mise activate zsh)"`）
- 鉴权：`/api/terminal/token`（HTTP 转发 ttyd /token）与 `/api/terminal/ws`（upgrade 裸 TCP 管道转发到 ttyd /ws）均先走 `checkAuth` JWT 校验，再判启用状态（401 优先于 503）；`503 Terminal disabled` 表示配置未启用，`503 Terminal unavailable` 表示 ttyd 进程未就绪（前端会显示浮层并每 5s 自动重连）
- 前端 `src/apps/TerminalApp.tsx`：xterm.js（@xterm/xterm + @xterm/addon-fit）直连代理后的 WebSocket，实现 ttyd 二进制帧协议（服务端首字节 `0` 输出 / `1` 标题；客户端 `0` 输入 / `1` resize + 首条 JSON 认证消息）。握手必须声明子协议 `tty`（`new WebSocket(url, 'tty')`），1.6.x / 1.7.x 均要求，否则连接会被立即关闭（黑屏无输出）
- WS 代理为裸 TCP 管道（`net.connect` 改写请求行后双向 pipe），不实现 WS 帧编解码；修改升级逻辑时保持 Cookie 不外传、对端 socket 对称销毁

### Runner（脚本任务构建，RunnerApp + `/api/runner/*`）

- 后端 `server.js` 以 `spawn(shell, [脚本名])`（cwd 为脚本所在目录；用相对名 + cwd 而非绝对路径，兼容 Windows Git Bash 的 POSIX 路径限制）执行服务端配置的脚本（生产为 running_page 的 `build.sh`），stdout/stderr 合并落盘 `data/runner.log`，构建开始写分隔头、结束写 `[exit code N]`；同时只允许一个任务（内存单槽锁，重复触发 409），`SIGINT/SIGTERM/exit` 时对运行中任务 SIGTERM
- API（统一 `checkAuth`，401 优先）：`POST /api/runner/start`（立即返回不阻塞；未启用 503 `Runner disabled`、重复 409、脚本不存在 400）、`GET /api/runner/status?lines=N`（信息性接口，未启用也 200 返回 `enabled:false`；含 running/job/last 摘要与日志尾部，lines 上限 2000）、`POST /api/runner/stop`（SIGTERM 中断，空闲 409）
- 安全约定：脚本路径只来自服务端 `config.json`（`runner.scriptPath`）或 `RUNNER_SCRIPT` 环境变量，客户端不可传路径；能触发 = 能登录（与终端/文件管理同级鉴权）
- 前端 `RunnerApp`：状态区（Idle/Running/上次结果）+ Build/Stop 按钮 + 等宽日志区；轮询间隔运行中 2s、空闲 10s，新日志自动滚底
- ⚠️ `build.sh` 含 `git push` 与 COS 上传等真实发布动作，Windows 本机验证 UI 时不要点击 Build

### 文件管理器 / 文本编辑器（FileManagerApp / EditorApp + `/api/fs/*`）

- 后端 `server.js` 的 `/api/fs/*` 全部零依赖实现且统一走 `checkAuth`：`list`（列目录，不传 path 返回允许根列表）、`read`（文本读取，2MB 上限 + NUL 字节二进制嗅探）、`raw`（原始流：仅图片内联供 `<img>` 预览，其余一律 `attachment` 下载防内联 XSS）、`write`（PUT 文本保存）、`upload`（POST raw body 流式上传，50MB 上限，`?overwrite=1` 覆盖）、`mkdir` / `delete`（递归）/ `rename`、`favorites`（GET/PUT，持久化到 `data/favorites.json`，临时文件 + rename 原子写）
- 安全约定：所有路径经 `path.resolve` 规范化并校验在允许根内（`FS_ROOTS` 环境变量可覆盖，默认 Windows 为项目盘符 + C 盘、POSIX 为 `/`）；根目录禁止删除/重命名；文件名清洗只取 basename
- ⚠️ **Windows ReFS/Dev Drive 坑**：刚写入文件的 `stat.size` 可能是预分配值（元数据延迟），`raw` 接口因此**不设 Content-Length**（chunked 读到 EOF）；`list` 的大小列在 Dev Drive 上刚写入时也可能短暂虚高，生产 Linux 无此问题
- 前端 `FileManagerApp`：SplitView 左（收藏夹 + ClassicyTree 目录树懒加载）/ 右（ClassicyTable 多选文件列表：名称/大小/修改时间/权限），工具栏 + 右键菜单（打开/编辑/下载/重命名/删除/收藏），上传用 XHR 出进度条，预览为独立 ClassicyWindow（图片内联 / Markdown 渲染可切源码 / 文本只读高亮）
- 前端 `EditorApp`：CodeMirror 6（`@codemirror/lang-*` 按扩展名动态 import，社区主题 `@uiw/codemirror-theme-*`：Dracula / GitHub Dark / GitHub Light / VSCode Dark），保存（Ctrl/Cmd+S）/撤销/重做/查找（Mod-F），Markdown 分栏预览（marked + DOMPurify），主题/字号/字体偏好存 localStorage，未保存关闭有 `onBeforeClose` veto 确认
- 跨应用联动：`src/editorBridge.ts` 的 `openInEditor(path)` —— 记录 pendingPath + dispatch `ClassicyAppOpen`/`ClassicyWindowOpen` + DOM 事件双通道（挂载消费 pending、已挂载走事件），避免竞态

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

- 前端：`npm run build` 确认无 TS / 构建错误（可用 `npx tsc --noEmit` 做全量类型检查）。
- 后端：`npm start` 后用密码登录，确认指标接口正常返回。
- 文件管理 API：`node test-fs-api.js` 全部 PASS（鉴权/列表/读写/上传/收藏/越权防护等 17 项）。
- Runner API：`node test-runner-api.js` 全部 PASS（成功/失败/stop/409/401/400/503 等 22 项；无 bash 环境显示 SKIP 属正常）。
