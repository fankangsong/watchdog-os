# 登录审计日志（Audit Log）需求与实现说明

> 状态：已实现。本文档描述记录范围、字段契约、存储与保留策略、统计口径、接口与安全约定，供后续维护与排障参考。

## 1. 背景与目标

面板只有「访问密码 + 会话 Cookie」一道门，但**谁在什么时候、从哪个 IP、用对还是用错口令**这些事实此前完全没有留痕：

- 撞库 / 暴力破解无法事后确认（只靠 600ms 防爆破延迟是被动防御）；
- 会话过期后前端轮询持续 401，也无从判断是「自己人刷新页面」还是「有人在扫接口」；
- 出问题时没有可回溯的证据链。

目标：把与登录相关的操作**落盘保留**，并在面板内提供**审查（逐条明细）**与**分析（趋势 / 来源 / 异常）**两个视角，同时支持导出做外部留存。

## 2. 记录范围

| 事件 | 触发点 | 说明 |
| --- | --- | --- |
| `login`（成功） | `POST /api/login` 口令正确 | `status=200`，`durationMs` 记录签发耗时 |
| `login`（失败） | 同上，口令错误 | `reason=bad-password`，`status=401`；**逐条记录，不做任何合并** |
| `login`（失败） | 请求体不是合法 JSON | `reason=bad-body`，`status=400` |
| `logout` | `POST /api/logout`（且已通过鉴权） | **只记用户主动退出**。接口本身幂等（无效会话也 200 + 清 Cookie），只有会话有效时才记审计——未授权的登出可能只是撞库噪声。前端保证「401 → 本地收尾」不触发该接口（否则审计会把过期事件误记成主动退出，见 AGENTS.md 安全约定） |
| `unauthorized` | 任一受保护接口鉴权失败 401 | 覆盖 printer / metrics / docker / processes / terminal / fs / prefs / runner / blog / chat / usage / audit |
| `unauthorized` | 终端 WS 升级鉴权失败（401） | 与 HTTP 路径同一套埋点 |

未记录（刻意）：登录页的 `/api/health`、静态资源（`/assets/*`、PWA 文件）、SSE 代理内部请求。

> 600ms 防爆破延迟计入失败记录的 `durationMs`（正常应 ≥ 600ms）。这是刻意保留的人工耗时：值异常小说明该分支被绕过，值稳定在 600ms 附近则是脚本化撞库的典型指纹。

## 3. 字段契约（JSONL 每行一条）

```json
{
  "t": 1761700000000,
  "type": "login",
  "ok": false,
  "reason": "bad-password",
  "ip": "203.0.113.9",
  "remoteIp": "10.0.0.2",
  "xff": "203.0.113.9, 10.0.0.2",
  "ua": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) …",
  "path": "/api/login",
  "status": 401,
  "durationMs": 612,
  "count": 1,
  "lastSeen": 1761700000000
}
```

| 字段 | 说明 |
| --- | --- |
| `t` | 事件时间（ms，本地时区写入日文件） |
| `type` | `login` / `logout` / `unauthorized` |
| `ok` | 成功与否（`logout` 恒 true） |
| `reason` | `ok` / `bad-password` / `bad-body` / `logout` / `unauthorized` |
| `ip` | 客户端 IP：`X-Forwarded-For` 首段优先，否则直连地址（IPv4-mapped 前缀已剥离） |
| `remoteIp` | 直连 socket 地址（反代部署时与 `ip` 不同，排障用） |
| `xff` | 原始 `X-Forwarded-For`（截断 200 字符） |
| `ua` | User-Agent（截断 256 字符） |
| `path` | 请求路径（去掉 query，截断 200） |
| `status` | 对应 HTTP 状态码 |
| `durationMs` | 登录事件才有；含 600ms 防爆破延迟 |
| `count` | 401 合并窗口内的累计次数（登录事件恒 1） |
| `lastSeen` | 合并窗口内最后一次出现时间 |

**脱敏**：不记录密码、密码哈希、Cookie、`Authorization`、请求体。字段在写入前剥掉全部控制字符（否则换行会把一条记录劈成两行、破坏 JSONL），再按上限截断。

## 4. 存储与保留

- 目录：`~/.watchdog-os/login-log/`（可用 `LOGIN_LOG_DIR` 覆盖，支持 `~` 前缀与绝对路径），与 `data.json` 同级，重部署 / 同步脚本不会丢。
- 文件：`YYYY-MM-DD.jsonl`（**本地日期**，用户按本地日期看日志）。
- 权限：`mkdir 0o700` + `appendFile 0o600`（POSIX 生效，Windows 忽略）。
- 保留：`LOGIN_LOG_RETENTION_DAYS`（默认 30 天）。清理时机为**启动时**与**跨天后的首次写入**（每小时最多一次），不做每次 append 都 `readdir`。
- 写入：串行队列 + 异步 `appendFile`（不 fsync）；失败只 `console.warn` 一次并把原因透出到面板状态栏，**绝不影响登录结果**。

## 5. 配置项

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `LOGIN_LOG_ENABLED` | `true` | 总开关；关闭后不记录，`GET` 返回 `enabled:false` |
| `LOGIN_LOG_DIR` | 空 | 留空 = `~/.watchdog-os/login-log` |
| `LOGIN_LOG_RETENTION_DAYS` | `30` | 收敛到 1~3650 |
| `LOGIN_LOG_MAX_ENTRIES` | `20000` | 单次读取解析条数上限，收敛到 100~200000 |
| `LOGIN_LOG_BRUTE_THRESHOLD` | `5` | 疑似暴力破解的窗口内失败次数，收敛到 2~100 |
| `LOGIN_LOG_BRUTE_WINDOW_MIN` | `10` | 暴力破解判定窗口（分钟），收敛到 1~1440 |
| `LOGIN_LOG_401_DEDUPE_SEC` | `60` | 同 IP + 同路径 401 合并窗口，收敛到 0~3600（0 = 关闭去重） |

## 6. 接口

`/api/audit/*` 均需登录会话（`checkAuth` 只认 HttpOnly Cookie），401 优先于其它状态。

> 例外是 `/api/logout`：它**不鉴权**且恒返回 `200 + 清 Cookie`（`Max-Age=0`）。会话已过期 / Cookie 已失效时也必须能清掉，否则失效 Cookie 会一直粘在浏览器里，前端每次轮询都 401，用户被卡在「桌面 ↔ 401」。前端与之配套的行为见 `src/session.ts`：清本地会话存储 → 置 `wd-signed-out` 一次性标记 → 整页重载回登录页。

### `GET /api/audit/login-log`

查询参数（全部可选，非法值收敛）：

| 参数 | 默认 | 取值 |
| --- | --- | --- |
| `days` | `7` | `1` / `7` / `30` / `0`（0 = 全部保留期）；上限为 `LOGIN_LOG_RETENTION_DAYS` |
| `type` | `all` | `all` / `login` / `logout` / `unauthorized` |
| `ok` | `all` | `all` / `success` / `failure` |
| `ip` | 空 | 子串匹配（`ip` 或 `remoteIp`） |
| `limit` | `200` | 明细条数，收敛到 1~2000 |

响应：

```ts
{
  enabled: boolean;
  error?: string;            // 目录不可写等写入异常（enabled 仍可能为 true）
  entries: AuditEvent[];     // 按时间倒序，≤ limit
  stats: {
    total: number; success: number; failures: number; failureRate: number;
    unauthorized: number; sources: number;
    byDay: { day: string; success: number; failures: number }[];
    byHour: { hour: number; success: number; failures: number }[];   // 固定 24 项
    topSources: { ip: string; total: number; failures: number; firstSeen: number; lastSeen: number }[];
    recentFailures: AuditEvent[];   // 最近 20 条失败
    anomalies: {
      bruteForce: { ip: string; count: number; firstSeen: number; lastSeen: number }[];
      newSources: { ip: string; firstSeen: number }[];
    };
  };
  meta: {
    retentionDays: number; days: number; limit: number; truncated: boolean;
    dir: string; generatedAt: number;
    bruteWindowMinutes: number; bruteThreshold: number;
  };
}
```

- 未启用时返回 `200 + enabled:false`（信息性状态，便于前端区分「未开启」与「服务异常」）。
- 统计基于**筛选后**的全量集合；`entries` 只受 `limit` 限制，两者口径不同。
- `truncated: true` 表示命中解析条数上限，更早的数据被丢弃（读文件时从最新文件往前读，被截断的一定是最旧的部分）。

### `GET /api/audit/login-log.csv`

参数与上面完全一致，返回 `text/csv; charset=utf-8` + `Content-Disposition: attachment`，**不受 `limit` 限制**（导出当前筛选的全部结果）。

- 前缀 UTF-8 BOM，Excel 打开中文不乱码；行分隔用 CRLF。
- 单元格转义 `"`、逗号、换行；以 `= + - @` 开头的值加 `'` 前缀（防 Excel 公式注入）。
- 前端用 `fetch` + `Blob` 下载（携带 HttpOnly Cookie），不用无鉴权直链。

## 7. 统计与异常判定口径

- **失败率** `failureRate = failures / total`（百分比，一位小数，四舍五入）。
- **计数口径**：`total / success / failures / unauthorized / byDay / byHour / topSources` 全部按 `count` 累加——401 被合并成一条时，次数仍如实反映探测强度。`entries` 是记录行数（合并后行数会小于次数）。
- **`byDay`**：只包含有事件的日期（不补零），按日期升序。
- **`byHour`**：固定 24 项（0~23，本地时区），无事件的小时为 0，便于画「全天活动分布」。
- **`topSources`**：按总次数降序取前 10；`firstSeen / lastSeen` 取所选范围内的时间。
- **`recentFailures`**：按时间倒序取最近 20 条失败记录（含 `unauthorized`）。
- **疑似暴力破解 `bruteForce`**：对每个 IP 的**登录失败**时间序列做滑动窗口（默认 5 次 / 10 分钟）；取该 IP 命中次数最多的窗口作为代表条目（`count` = 该窗口内失败次数，`firstSeen/lastSeen` = 窗口边界）。窗口只在所查询范围内滑动，因此缩小时间范围可能让同一次攻击「看起来不成立」。
- **陌生来源 `newSources`**：在所选范围内首次出现时间落在**最近 24 小时**内的来源（最多 10 条，按首次出现倒序）。语义是「最近才出现的来源」；要看历史上所有 IP 请用 `topSources`。

## 8. 401 去重（为什么必须做）

登录后前端有页面级共享轮询（`monitorPoll` / `dockerPoll` / `printerPoll`，5s 一轮）。会话失效后这些轮询会持续 401，若逐条落盘：

- 磁盘被无意义记录打爆（一天可产生数十万行）；
- 真实的撞库 / 扫描信号被自己的轮询噪声淹没，`topSources` 与异常判定全部失真。

实现：同 `ip + path` 在 `LOGIN_LOG_401_DEDUPE_SEC`（默认 60s）窗口内**只落一条**，重复次数累加在内存里，窗口结束时（或读取前、进程退出前）以 `count / lastSeen` 一次性写出。

- 代价：进程被强杀（`SIGKILL`）时，最多丢掉「当前窗口内尚未 flush 的合并记录」。正常 `SIGTERM` / `SIGINT` 退出会在 `process.on('exit')` 里同步 flush。
- 登录失败**不参与去重**——每次尝试都必须是一条独立事实（也是暴力破解判定的数据基础）。
- 设 `LOGIN_LOG_401_DEDUPE_SEC=0` 可关闭去重，回到逐条记录（仅建议在单用户、无页面轮询的环境使用）。

## 9. 前端（Audit Log 应用）

入口：桌面图标 `Audit Log`（`srv-audit.app`），窗口三段式：

- **按钮带**：`Range`（Today / 7 Days / 30 Days / All）、`Event`、`Result` 三个下拉 + `Refresh` + `Export CSV`，右端显示保留天数。
- **内容区**（唯一滚动容器）：`Overview`（成功率/失败率等指标卡）→ `Sign-ins by Day`（双色柱状图）→ `Activity by Hour`（24 小时分布）→ `Top Sources`（表格）→ `Anomalies`（疑似暴力破解 / 陌生来源）→ `Events`（明细表 + 来源 IP 筛选）。
- **状态栏**：左区当前条目数 / 错误原因（红字，保留上次数据），右区最后更新时间。

轮询 15s（登录是低频事件，无需更快）；筛选变更与 `Refresh` 立即重拉；401 一律触发登出（与其它应用一致）。

## 10. 验证

```bash
node test/test-audit-log-api.js
```

覆盖 28 项：登录失败/坏 body/成功/登出的落盘、日志不含任何凭据、401 去重合并（3 次 → 1 条 `count=3`）、审计接口未鉴权 401、登出幂等（无会话也 200 + 清 Cookie 且不写审计）、统计聚合与筛选、CSV 的 BOM/表头/不受 `limit` 限制、疑似暴力破解命中、保留期清理（启动时删除过期日文件）、服务重启后日志仍可读。

前端退出收尾另有独立回归：

```bash
node test/test-session-store.mjs   # 11 项：存储清理范围 / 单次导航 / 一次性标记 / 401 同路径 / 存储被禁仍收尾
```

## 11. 已知取舍

- **不做会话吊销**：`/api/logout` 只清 Cookie，服务端无会话表；审计日志记录的是「谁点了退出」，而不是令牌失效（见 AGENTS.md「会话不可吊销」）。
- **不记录请求体与密码**：即使记录可帮助识别撞库字典，凭据旁路风险远大于收益，一律不记。
- **IP 可信度**：`ip` 取 `X-Forwarded-For` 首段，反代未清洗时该值可被伪造。审计以「直连 + 转发」双字段并存的方式提供线索，不做真实性断言。
- **保留期内的日志不做压缩/归档**：单机单用户量级下（每天几百行）没有必要，需要长期留存请定期导出 CSV。
