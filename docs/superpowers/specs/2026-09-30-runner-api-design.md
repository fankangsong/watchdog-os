# Runner API 设计：远程触发 running_page 构建

日期：2026-09-30
状态：已确认（用户批准）

## 背景与目标

`running_page` 项目的 `build.sh` 是一个分钟级长任务（git pull → Python 数据同步 → pnpm build → git push → coscli 上传 COS → notify）。目前只能登服务器手动执行。

本设计在 watchdog-os 的 `server.js` 中新增 Runner API，实现：

- 通过 HTTP 接口（含独立 curl/脚本调用）远程触发 `build.sh`
- 查询任务状态与日志尾部
- 桌面端新增 Runner App（触发按钮 + 状态显示 + 日志查看）

目标环境：Linux 服务器（tkp，systemd 部署），bash/pnpm/coscli 均可用。

## 非目标

- 多任务管理（当前只有 build.sh 一个任务，YAGNI）
- 独立鉴权体系（复用现有 JWT，能触发 = 能登录）
- CORS 支持（无浏览器跨域调用需求）
- 构建产物部署（脚本自带 coscli）、通知（脚本自带 notify）
- 任务历史列表（只保留"最近一次"元信息）

## 后端设计（server.js）

### 配置节 `runner`

模式与 `terminal` 配置节一致：config.json 的 `runner` 节整体覆盖默认值，环境变量可覆盖。

```json
{
  "runner": {
    "enabled": false,
    "scriptPath": "/home/fanks/running_page/build.sh",
    "shell": "bash",
    "maxLogBytes": 5242880
  }
}
```

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `false` | 是否启用 Runner |
| `scriptPath` | `''`（必配） | 要执行的脚本绝对路径 |
| `shell` | `'bash'` | 执行 shell |
| `maxLogBytes` | `5242880` | 日志文件轮转阈值 |

环境变量覆盖：`RUNNER_ENABLED`、`RUNNER_SCRIPT`、`RUNNER_SHELL`（真值判断与 `TERMINAL_ENABLED` 相同）。

### API（统一 JWT 鉴权，401 优先于 503，模式与 terminal 一致）

**POST `/api/runner/start`**

按序校验：401（未登录）→ 503 `{error:'Runner disabled'}`（未启用或 scriptPath 未配置）→ 409 `{error:'Job already running', job}` → 400 `{error:'Script not found'}`（脚本不存在或不是文件）→ 200。

成功返回：

```json
{ "ok": true, "jobId": "20260930-121533-a1b2", "startedAt": 1759212933000, "script": "/home/fanks/running_page/build.sh" }
```

**GET `/api/runner/status?lines=300`**

```json
{
  "enabled": true,
  "script": "/home/fanks/running_page/build.sh",
  "running": false,
  "job": { "id": "20260930-121533-a1b2", "startedAt": 1759212933000, "exitCode": 0, "finishedAt": 1759213365000 },
  "last": { "id": "20260930-121533-a1b2", "exitCode": 0, "failed": false, "durationMs": 432000, "finishedAt": 1759213365000 },
  "log": "……日志尾部文本……"
}
```

- `lines` 默认 300，上限 2000（超出截断，取尾部）
- `job`：当前运行中的 job；空闲时为 `null`
- `log`：`data/runner.log` 尾部；文件不存在时为 `''`
- `last`：最近一次结束的 job 摘要（exitCode / failed = exitCode !== 0 / 时长）

**POST `/api/runner/stop`**

- 运行中 → SIGTERM 子进程，返回 `{ok:true, job}`
- 空闲 → 409 `{error:'No job running'}`

### 进程管理与日志

- 启动：`spawn(cfg.runner.shell, [scriptAbsPath], { cwd: path.dirname(scriptAbsPath), env: process.env, stdio: ['ignore','pipe','pipe'], windowsHide: true })`
- stdout/stderr 合并追加写入 `data/runner.log`；每次构建开始时先写分隔头（时间 + jobId + 命令行）；exit 时追加 `[exit code N]` 行
- 日志轮转：构建开始前若 `data/runner.log` 超过 `maxLogBytes`，先 rename 为 `.old`（覆盖旧 .old）
- job id：`YYYYMMDD-HHmmss-` + 4 位随机 hex
- 并发锁：内存单槽 state（`{ proc, job }`），同时只允许一个 job
- 退出清理：在现有 `shutdown()`（SIGINT/SIGTERM/exit）中对运行中 job `kill('SIGTERM')`

### 安全

- 脚本路径只来自服务端配置，客户端不可传路径（杜绝任意命令执行面）
- 启动前 `fs.statSync` 校验为已存在的文件
- 鉴权与 terminal / fs API 同级：统一 `checkAuth`，401 优先于 503

## 前端设计

### `src/api.ts` 新增

- `RunnerStatus` 类型 + `fetchRunnerStatus(lines?)` / `startRunnerBuild()` / `stopRunnerBuild()`
- 复用现有 `request<T>` 封装与 401 处理

### `src/apps/RunnerApp.tsx`（新文件，模式参照 DockerApp）

- `APP_ID = 'srv-runner.app'`，name `Runner`，注册进 `Desktop.tsx`
- 窗口内容（自上而下）：
  1. 状态区（`ClassicyControlGroup`）：运行中/空闲、脚本路径、上次结果（exitCode、failed 高亮、耗时、结束时间）
  2. 工具栏（`ClassicyButtonToolbar`）：`Build` 按钮（运行中禁用）、`Stop` 按钮（空闲禁用）
  3. 日志区：等宽 `<pre>`，自动滚动到底部（有新内容时）
- 轮询：`usePolling`，运行中 2s、空闲 10s（interval 作为 state 随 running 切换）
- 触发/停止成功后立即 `reload()` 刷新状态

## 测试

新增 `test-runner-api.js`（仿 `test-fs-api.js`：自起自停 server 子进程）：

- 写临时目录假脚本（`echo` + `sleep`）+ 临时 config（启用 runner）
- 覆盖：start 成功 → status running → 等待结束 → status 含 exitCode 0 与日志内容；重复 start → 409；stop → 200 且进程终止；未启用 → 503；无 token → 401；脚本不存在 → 400
- 系统无 bash 时打印 skip（Linux CI 必跑）

前端无既有测试先例，不新增前端测试；本地以 `npm run build` + 手动验证为准。

## 错误处理摘要

| 场景 | 行为 |
| --- | --- |
| 未登录 | 401 |
| 未启用 / 未配 scriptPath | 503 `Runner disabled` |
| 重复触发 | 409 `Job already running` |
| 脚本不存在 | 400 `Script not found` |
| 构建失败（exitCode != 0） | status.last.failed = true，日志可见原因 |
| server 重启 | 内存 state 清空，日志文件保留；构建随子进程终止 |
| systemd stop / Ctrl-C | shutdown 钩子 SIGTERM 运行中 job |

## 交付物

1. `server.js`：配置节 + runner 状态管理 + 3 个路由 + shutdown 清理
2. `src/api.ts`：3 个 API 封装
3. `src/apps/RunnerApp.tsx`：新 App
4. `src/Desktop.tsx`：注册 RunnerApp
5. `test-runner-api.js`：后端冒烟测试
6. `AGENTS.md`：目录结构与命令说明补充
