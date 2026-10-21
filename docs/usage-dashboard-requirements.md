# Chat 应用 · 大模型用量 Dashboard 需求文档

> 状态：需求规划（未实现）。本文档是 Chat 应用「Usage Dashboard」窗口的展示需求与数据来源盘点，作为后续实现的依据。

## 1. 背景与目标

Chat 应用当前经 watchdog 后端代理调用 hermes，用户对各**上游大模型平台**（DeepSeek、智谱 ZAI）的余额 / 配额 / 用量没有统一的查看入口，需要分别登录各平台网页查看。

目标：在 Chat 应用内新增一个 **Usage Dashboard 窗口**，聚合展示已配置平台的使用情况；首期支持 DeepSeek 与 ZAI（智谱 BigModel）两家，架构上预留多平台扩展。

## 2. 数据来源盘点（2026-10-20 调研结论）

### 2.1 DeepSeek（官方公开 API）

- **查询余额**：`GET https://api.deepseek.com/user/balance`，`Authorization: Bearer <DEEPSEEK_API_KEY>`。
- 响应：

```json
{
  "is_available": true,
  "balance_infos": [
    {
      "currency": "CNY",
      "total_balance": "110.00",
      "granted_balance": "10.00",
      "topped_up_balance": "100.00"
    }
  ]
}
```

- 字段：`is_available`（余额是否可供调用）；`balance_infos[]`：`currency`（CNY/USD）、`total_balance`（总可用余额=赠金+充值）、`granted_balance`（未过期赠金）、`topped_up_balance`（充值余额）。金额为 string。
- **限制**：用量明细（platform.deepseek.com/usage 页面的按天/按模型消费记录）**无公开 API**，页面为登录态网页，不做爬取。

### 2.2 ZAI / 智谱 BigModel

- **Coding 套餐配额**：`GET https://open.bigmodel.cn/api/monitor/usage/quota/limit`（国际站 `https://api.z.ai/api/monitor/usage/quota/limit`），`Authorization: Bearer <ZAI_API_KEY>`。该端点为智谱官方前端在用接口（第三方生态 cc-switch / pi-zai-usage 已广泛使用），**未出现在公开 API 文档中，存在变更风险，需容错处理**。响应：

```json
{
  "code": 200,
  "msg": "操作成功",
  "success": true,
  "data": {
    "level": "pro",
    "limits": [
      { "type": "TIME_LIMIT", "percentage": 7, "usage": 1000, "currentValue": 72, "remaining": 928 },
      { "type": "TOKENS_LIMIT", "percentage": 44 },
      { "type": "TOKENS_LIMIT", "percentage": 53 }
    ]
  }
}
```

- `limits[]` 语义（来自 z.ai 前端源码，需按 type + 出现顺序容错区分）：
  - `TOKENS_LIMIT` ×2：第一条为 **5 小时滚动 token 窗口**，第二条为 **周配额**（部分套餐/国际站才有）；
  - `TIME_LIMIT`：**月度工具/搜索类额度**，可带 `usage / currentValue / remaining / percentage`；
  - `level`：套餐档位（如 pro/max）。
- **标准按量付费 API**（open.bigmodel.cn/api/paas/v4）：**无公开余额/账单查询 API**；响应头 `X-RateLimit-Remaining-Tokens` 等仅为速率限制，非余额。首期不覆盖。
- API Key 管理分「个人套餐 / 团队套餐 / 模型标准 API」三类且互不通用——配置时需使用 Coding 套餐对应的 Key。

### 2.3 能力矩阵（首期覆盖范围）

| 平台 | 数据 | 端点 | 首期支持 |
| --- | --- | --- | --- |
| DeepSeek | 余额（总/赠金/充值、币种、可用性） | 官方 `/user/balance` | ✅ |
| DeepSeek | 按天/按模型用量明细 | 无公开 API | ❌（不做爬取） |
| ZAI | Coding 套餐配额（5h 窗口 / 周 / 月工具额度、档位） | `quota/limit`（半官方） | ✅ |
| ZAI | 按量付费余额 / 账单 | 无公开 API | ❌ |
| 通用 | 本地 token 消耗统计（Chat 流式响应自带 usage） | hermes 代理已有数据 | 延后（见 §8） |

## 3. 展示需求

### 3.1 窗口形态

- Chat 应用内新增独立窗口 `chat-usage`（ClassicyWindow，标题 `Usage`），经菜单打开（Chat 菜单组新增 `Usage Dashboard…`）。
- 按 AGENTS.md 注意事项 11，隐藏次窗一律**条件渲染**（`{open && <ClassicyWindow … onCloseFunc={() => setOpen(false)}>`，对齐 TerminalApp 快捷键窗模式）。
- 窗口内容按 provider 分**卡片**纵向排列（首期两张：DeepSeek、ZAI），每张卡片自含加载/错误/正常三态。

### 3.2 DeepSeek 卡片

| 元素 | 说明 |
| --- | --- |
| 状态灯 | `is_available`：绿=可用，红=余额不足；接口失败=灰 + 错误文案 |
| 余额列表 | 每个 `balance_infos[]` 条目一行：`CNY ¥110.00`（total 加粗大字） |
| 余额构成 | 同币种下小字两行：`赠金 ¥10.00` / `充值 ¥100.00` |
| 刷新时间 | 卡片底部小字「更新于 HH:mm:ss」 |

- 多币种各自成行（CNY/USD 同时存在时并列展示，不做汇率折算）。
- 金额直接展示服务端返回的 string，不做精度换算。

### 3.3 ZAI 卡片

| 元素 | 说明 |
| --- | --- |
| 套餐档位 | `level` 徽标（pro / max / …，缺失则隐藏） |
| 5h 滚动窗口 | `TOKENS_LIMIT[0].percentage` 进度条 + 百分比数字；≥80% 黄色、≥95% 红色预警色 |
| 周配额 | `TOKENS_LIMIT[1].percentage` 进度条 + 百分比（该条目缺失则整行隐藏） |
| 月度工具额度 | `TIME_LIMIT`：进度条 + `currentValue / (usage 或 currentValue+remaining)`（有数值时显示明细，无则只显百分比） |
| 刷新时间 | 同 DeepSeek 卡片 |

- `limits[]` 解析容错：按 type 分组 + 组内顺序取值，字段缺失降级为只显示可得的 percentage；`success !== true` 或 `code !== 200` 视为错误态。
- 端点域名（国内 open.bigmodel.cn / 国际 api.z.ai）由服务端配置决定，前端不感知。

### 3.4 交互

- **手动刷新**：窗口顶部 Refresh 按钮，点击并发刷新两张卡片。
- **自动轮询**：窗口可见时每 5 分钟静默刷新（不可见/窗口关闭时暂停，避免无谓请求）。
- **三态**：Loading（首次拉取）/ Error（错误文案 + Retry 按钮）/ 正常。卡片间互不影响（一张失败不拖垮另一张）。
- 时间统一本地时区显示。

## 4. 架构与安全约定（实现期必须遵守）

- **后端代理转发**，前端不直连第三方（同 hermes 代理模式）：
  - `GET /api/usage/deepseek` → `https://api.deepseek.com/user/balance`
  - `GET /api/usage/zai` → `{zaiBaseUrl}/api/monitor/usage/quota/limit`
  - 路由挂 BASE 前缀下、统一 `checkAuth`（401 优先），未配置对应 key 时返回 503（语义对齐 `503 Terminal disabled`）。
- **API Key 只存服务端**（`.env` 或 hermes 配置），不下发前端、不进任何响应体；上游失败按 §chat 代理同规则处理（上游 401/403 映射 502，避免前端误登出）。
- **Key 解析顺序（已实现）**：本地配置 `DEEPSEEK_API_KEY` / `ZAI_API_KEY` 优先；留空时经 SSH 读取 Mac 上 `~/.hermes/.env`（`USAGE_SSH_CMD` 默认 `ssh -o BatchMode=yes … mac "grep -E '…' ~/.hermes/.env"`（双引号包远端命令，单引号留给远端））并缓存（成功 5min / 失败 30s），仍无 → 503。
- **hermes 配置文件所需字段**：`DEEPSEEK_API_KEY`（DeepSeek key）、`DEEPSEEK_BASE_URL`（本地留空时优先采用）、`GLM_API_KEY` 或 `ZAI_API_KEY`（智谱 key，二选一）；服务端只按上述键名 grep，不整文件读入内存、不落盘。
- 新增配置项按 AGENTS.md 规矩用 `envStr` 声明于 `server/config.js`，并同步 `.env.example` 与 `config.example.json`：
  - `USAGE_ENABLED`（总开关，默认 false）
  - `DEEPSEEK_API_KEY`、`DEEPSEEK_BASE_URL`（默认 `https://api.deepseek.com`）
  - `ZAI_API_KEY`、`ZAI_BASE_URL`（默认 `https://open.bigmodel.cn`，国际站改 `https://api.z.ai`）
  - `USAGE_TIMEOUT_MS`（建议默认 15000，对齐 sessions 快操作）
- 后端保持零依赖（Node 内置 fetch ≥18 可用），超时与错误都返回结构化 JSON，不在后端做字段裁剪以外的主观加工（解析放前端，保持代理薄）。

## 5. 界面文案与视觉

- 窗口与按钮文案英文（Title Case，对齐菜单规范）：`Usage`、`+ New Chat` 风格统一；卡片内数据标签英文（`Balance` / `Granted` / `Topped up` / `5h window` / `Weekly` / `Monthly tools`）。
- 视觉对齐 classicy 复古风格：进度条用内凹方角样式（参考 `.sp-chat-thinking` 内凹块），状态灯为小方灯而非圆点。

## 6. 验收标准（实现期）

1. `USAGE_ENABLED=false` 或未配置某家 key：对应卡片显示「未配置」态，窗口其余部分正常。
2. 正确配置后：两张卡片能展示 §3.2 / §3.3 全部字段；拔掉上游（断网/错 key）时卡片降级为 Error + Retry，不白屏、不影响 Chat 主功能。
3. `npx tsc --noEmit`、`npm run build` 通过；`node test/test-chat-api.js` 等既有测试不回归。
4. 新增 `node test/test-usage-api.js` 冒烟：401 / 503（未配置）/ 200 转发与字段透传 / 上游 401→502。
5. 前端 key 泄漏审计：任何响应体与前端代码中不出现 `DEEPSEEK_API_KEY` / `ZAI_API_KEY` 明文。

## 7. 风险与限制（需产品侧知晓）

- ZAI `quota/limit` 为未文档化接口，可能随前端改版变更——字段解析全部容错，接口失效时卡片显示 Error 而非崩溃。
- DeepSeek 用量明细、ZAI 按量付费账单均无公开 API，首期 dashboard 是「余额/配额」视角而非「消费记录」视角；页面上的用量图表无法复刻。
- 轮询对上游配额的消耗可忽略（余额/配额查询不计费），但仍按 5 分钟节流。

## 8. 后续扩展（非首期）

1. **本地 token 统计**：hermes 流式响应的最后一个 chunk 通常携带 `usage`（prompt/completion tokens）；可在 ChatApp 流式收尾时按会话/按天累积到 `~/.watchdog-os/data.json`（经 userdata 合并写），Dashboard 增加本地消耗趋势卡片——这是唯一能做出「用量明细」的可行路径。
2. 多平台扩展：Kimi（`/usages`）、MiniMax、火山方舟等已有社区验证端点，按 §3 卡片模式接入。
3. 告警：5h 窗口 ≥95% 时桌面通知（PushNotification 思路）。

## 9. 待确认问题

1. ZAI 只用 Coding 套餐，还是也需要覆盖团队/标准付费 Key？（无公开 API，标准付费首期只能不覆盖）
2. ZAI 是否需要同时支持国际站（api.z.ai）？由配置项区分已可覆盖，确认默认值即可。
3. 轮询间隔 5 分钟是否符合预期？
4. 窗口入口：仅菜单打开，还是需要在桌面/Chat 主窗口加常驻入口？
