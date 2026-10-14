---
name: harden-session-auth
overview: 加固 watchdog-os 服务端会话鉴权：JWT 密钥与密码解耦并强制显式配置、ttyd 加凭据堵住本地绕过、WS 升级校验 Origin、移除 Header 鉴权与登录响应体 token、收紧校验与匿名信息泄露，并移除默认密码改为 fail-fast。
todos:
  - id: config-secret-lifetime
    content: 改造 config.js：移除默认密码、JWT_SECRET 必配校验、JWT_EXPIRES_IN 上下界、新增 PUBLIC_ORIGIN 与 TTYD_CREDENTIAL
    status: pending
  - id: auth-cookie-only
    content: 收窄 checkAuth 为仅 Cookie，verifyJwt 严格校验 exp，parseCookies 异常容错
    status: pending
  - id: terminal-credential
    content: terminal.js 注入 ttyd -c 凭据、token 接口注入 Basic、WS 代理剥离敏感头
    status: pending
    dependencies:
      - config-secret-lifetime
      - auth-cookie-only
  - id: router-anon-and-origin
    content: router.js：health 去 hostname、login 去 token、WS 升级加 Origin 白名单、终端补503 提示
    status: pending
    dependencies:
      - auth-cookie-only
  - id: frontend-health-login
    content: 前端联动：api.ts HealthInfo 去 hostname、LoginApp 标题固定
    status: pending
    dependencies:
      - router-anon-and-origin
  - id: test-scripts-cookie
    content: 改造全部冒烟脚本为 Cookie 鉴权、env 密码、补 JWT_SECRET，新增 Bearer 头 401 负向断言
    status: pending
    dependencies:
      - router-anon-and-origin
      - terminal-credential
  - id: cleanup-docs
    content: 删除 login.yaml 并加 gitignore，更新 AGENTS.md 配置表与安全约定，提示部署与口令轮换
    status: pending
    dependencies:
      - config-secret-lifetime
      - terminal-credential
      - router-anon-and-origin
---

## 用户需求

对 watchdog-os 服务端会话鉴权进行加固，修复首轮安全分析中确认的 8 项风险，并调整配置策略。

## 修复范围

1. **JWT 密钥与密码解耦**：签名密钥不再由访问密码确定性派生；改为必须显式配置（`.env` / 环境变量 / `config.json`），未配置则拒绝启动。
2. **移除默认密码**：配置中删除内置默认口令，检测不到密码配置时禁止服务启动（fail-fast）。
3. **token 有效期可配置**：支持在 `.env` 中配置签发有效期，并加合理上下界防止误配。
4. **终端凭据**：ttyd 进程启用凭据保护，后端代为向 ttyd 换取访问令牌，凭据不下发到浏览器；本机进程无法再绕过面板口令直取终端。
5. **WebSocket 来源校验**：终端 WS 升级增加来源白名单校验（跨站来源拒绝，同源与无来源的非浏览器客户端放行）。
6. **收紧会话校验**：畸形 Cookie 不再触发服务端异常（返回 401 而非 500）；令牌过期字段做严格类型与数值校验。
7. **WS 代理头清理**：转发到 ttyd 前剥离会话相关请求头。
8. **匿名信息收敛**：公开的健康检查接口不再返回主机名；登录响应体不再回传令牌。
9. **鉴权通路收敛**：会话校验只认 HttpOnly Cookie，不再接受 `x-auth-token` / `Authorization` 请求头。

## 配套改动

- 删除被版本控制跟踪、含明文口令的历史快照文件 `login.yaml`，并加入忽略规则；提示该口令需轮换（不做仓库历史重写）。
- 同步改造冒烟测试脚本：改用 Cookie 鉴权、密码改为从环境变量读取、自起服务时补齐新的必配密钥变量。
- 更新项目文档：新增配置项说明与安全约定。

## 明确不在本次范围

登录限流与审计、会话吊销、Cookie `Secure` 标志、权限模型拆分。


## 技术栈

沿用现有栈，不引入任何新依赖：

- 后端：Node.js 原生（零第三方依赖），`server/` 下分层为 `config.js` / `lib/` / `api/` / `router.js` / `static.js`
- 前端：React 19 + TypeScript + classicy（仅两处类型/文案联动，无 UI 改版）
- 测试：`test-*.js` 零依赖冒烟脚本（自起 server 子进程）
- 配置：沿用「config.json 配置节 + 环境变量覆盖」既有模式，`.env` 由 `server/config.js:16-27` 的 `loadEnv()` 解析，新增变量自动生效## 实施策略

**总原则**：所有改动收敛在既有分层内，只做"删通路 / 加校验 / 换密钥来源"，不重构路由结构、不改 basePath 语义、不动401 优先于 503 的既有约定。改动集中在 4 个后端文件 + 2 个前端文件 + 测试脚本与文档。

### 1. 密钥与配置（`server/config.js`）

**密码 fail-fast**：`cfg` 默认值对象中删除 `password: 'admin123'`（第 40 行）。`server/config.js:125-128` 已存在 `if (!cfg.password) { console.error(...); process.exit(1); }`，删除默认值后该分支自然生效，仅需把提示文案补充完整（同时点名 `config.json` 的 `password`、`.env` 的 `PASSWORD`、进程环境变量 `PASSWORD` 三个来源）。这是本次唯一"删除即生效"的改动，其余为新增。

**JWT_SECRET 必配**：新增解析顺序 `process.env.JWT_SECRET` → `fileCfg.jwtSecret` → 缺失则 `[fatal]`退出。密钥以 UTF-8 字符串参与 HMAC，无需 hex/base64 解码，但要求长度 ≥ 32 字节（不足则 fatal，提示"过短易被离线暴力猜解"），把弱密钥在启动阶段挡掉。彻底移除 `sha256('sysprobe::jwt::' + cfg.password)` 派生逻辑（`config.js:142-146`）。

> 副作用（预期且需告知）：改密码不再导致全员登出（密钥与密码解耦的代价），换密钥才会。这是安全与运维便利的显式取舍。

**token 有效期**：`JWT_EXPIRES_IN`（秒）保留，改名不动以免破坏现有 `.env`；加 clamp `Math.min(Math.max(v, 300), 2592000)`（5 分钟 ~ 30 天），非法值回退 86400 并 `console.warn`。签发时仍写 `exp = iat + JWT_EXPIRES`（`router.js:50-54` 不变），Cookie `Max-Age` 与之同源，无需改动。

**Origin 白名单**：新增 `PUBLIC_ORIGIN`（`.env` / `config.json` / 环境变量，逗号分隔多值），默认空 = 仅同源。

**ttyd 凭据**：新增 `terminal.credential`（格式 `user:pass`）+ `TTYD_CREDENTIAL` 覆盖，与既有 `terminal.*` 配置风格一致。

### 2. 鉴权通路收敛（`server/lib/auth.js`、`server/lib/http.js`）

**`checkAuth` 只认 Cookie**：删除 `x-auth-token` 与 `Authorization: Bearer` 两条分支，仅保留 `parseCookies(req)[COOKIE_NAME]`。函数签名与返回类型不变，`router.js` 的 6 处调用点与 `handleUpgrade` 的 1 处调用点零改动。副作用：所有脚本化调用必须走 Cookie，这是"彻底移除"的既定决策。

**`verifyJwt` 收紧**：
- 保留"固定用 HS256 重算 + `timingSafeEqual` + 先比长度"的安全写法（`alg:none` / 算法混淆攻击本就不成立，**不得改坏**）。
- `exp` 校验改为严格形式：`typeof payload.exp !== 'number' || !Number.isFinite(payload.exp) || payload.exp <= Math.floor(Date.now()/1000)` → `null`。修复 `exp:"abc"` 时比较结果为 NaN 被判为"未过期"的漏洞。

**`parseCookies` 容错**：逐个 cookie value 的 `decodeURIComponent` 包 try/catch，失败则跳过该 pair（保留其余 cookie），函数**永不抛异常**。修复畸形 Cookie（如 `sp_token=%`）导致 500 的问题，使其稳定落到 401。`safeEqual`、`send` 等其余工具不动。

### 3. 终端凭据与来源校验（`server/api/terminal.js`、`server/router.js`）

**ttyd `-c` 注入**：在 `startTtyd()` 的 args 构造中，把 `-c <credential>` 紧跟 `-p <port>` 之后（即仍在 `ttydArgs` 之前）。这一位置同时满足两件事：ttyd 的 getopt 解析选项在前；WSL 分支 `['-e','bash','-lc', WSL_TTYD_CMD, 'bash', ...args]` 会让 `-c` 随 `"$@"` 展开到 `exec ttyd -W <args...>` 中，**不破坏 `$@` 位置参数机制**。

**`proxyTerminalToken` 注入 Basic**：ttyd 启用 `-c` 后 `/token` 需要认证。后端在 `http.request` 中加 `Authorization: Basic base64(<credential>)`，ttyd 签发的短期令牌仍只发给已通过 watchdog Cookie 鉴权的浏览器，凭据本身不下发。ttyd 返回 401/403 时统一映射为 502 `ttyd token rejected`（不把上游细节与凭据回传前端）。

**WS 代理头清理**：`proxyTerminalWs` 在已有 `delete h.cookie` 之后补 `delete h.authorization` / `delete h['x-auth-token']`，做纵深防御（即使未来有客户端误发也不外泄给本机 ttyd）。

**⚠️ 决策点（用户待确认）——凭据缺失时的行为**

| | 方案 A（推荐，安全默认） | 方案 B（兼容） |
|---|---|---|
| 行为 | `terminal.enabled=true` 但 `credential` 为空 → **不 spawn ttyd**，`/api/terminal/token` 返回 `503 { error:'Terminal credential missing', detail:'请在 config.json 的 terminal.credential 或 .env 的 TTYD_CREDENTIAL 配置 user:pass' }` | 不配置就维持现状（不加 `-c`），仍只靠 JWT + loopback 保护 |
| 代码差异 | `startTtyd()` 开头增加一次早退 + `router.js` 终端块的 503 分支增加一个前置判断 | 仅在 `credential` 非空时插入 `-c` |
| 影响 | 现有 tkp 部署**必须先补配置**才能用终端（一次性），之后本机绕过面关闭 | 不打断现有部署，但风险 4 未真正关闭 |
| 前端 | 现有 `TerminalApp` 已把非 `Terminal disabled` 的 503 归为 `TerminalUnavailable(detail)` 并浮层展示，无需改 UI | 无变化 |

下方 todolist 按**方案 A** 编排；若确认选 B，只需删掉 `startTtyd` 的早退判断与 router 的 503 前置分支，其余改动完全复用。

**WS Origin 校验（`handleUpgrade`）**：新增模块内私有函数 `originAllowed(req)`，插入到 `checkAuth` 之前，判定通过后原有 `enabled/ttydReady/checkAuth` 顺序与语义完全不变（失败路径统一 `socket.destroy()`，不回 HTTP 响应，与现状一致）。规则：
1. `Origin` 头缺失 → 放行（curl、测试脚本等非浏览器客户端必须能用）
2. `PUBLIC_ORIGIN` 非空 → origin 在白名单内（大小写不敏感、忽略尾部 `/`）则放行
3. 否则按同源推导：与 `http://<Host>` 或 `https://<Host>` 之一相等即放行（覆盖 Nginx 终结 TLS 的部署；跨协议来源场景建议显式配 `PUBLIC_ORIGIN`）

**匿名面收敛**：`/api/health` 去掉 `os.hostname()`（`router.js:32`），保留 `{ ok, basePath }`——`test-*.js` 的 `waitHealth()` 仍可用。`/api/login` 响应体去掉 `token` 字段，保留 `{ ok: true, expiresIn }`（`router.js:62`）。二者均不破坏前端：`src/api.ts:128-136` 的 `login()` 只看状态码。

### 4. 前端联动（最小改动）

- `src/api.ts`：`HealthInfo` 去掉 `hostname` 字段。
- `src/LoginApp.tsx`：移除 `hostname` state 与标题绑定，标题固定为 `System Monitor`（与既有 catch 分支文案一致）；`fetchHealth()` 保留调用（探测后端可达），不再消费 hostname。
- **不动** `src/apps/MonitorApp.tsx:62` 与 `src/components/SystemInfoPanel.tsx:8`——它们的 `host.hostname` 来自**已鉴权的** `/api/metrics`，与本次匿名面收敛无关，避免误改扩大范围。
- `src/apps/TerminalApp.tsx` 无需改动：新的503 文案会被现有 `getTerminalToken` 归类为 `TerminalUnavailable(detail)` 并浮层展示。

### 5. 测试脚本改造（6 个 + 1 个临时脚本）

统一为「Cookie 鉴权 + 环境变量密码 + 自起服务必带 `JWT_SECRET`」三件套：

```js
const PASSWORD = process.env.PASSWORD || 'test123';
// 登录：返回 Set-Cookie 的第一段（name=value），后续请求 headers: { Cookie: cookie }
```

- 需要从 Bearer 改为 Cookie：`test-fs-api.js`（`login()` 在49-57 行）、`test-runner-api.js`（72-79 行）、`test-chat-api.js`（50-58 行）、`test-chat-sessions-api.js`（136-140 行）、`.tmp-runner-build.js`（`http.request` 需自行收集 `set-cookie` 再改用 Cookie 头）
- 硬编码 `admin123` 改为读 `process.env.PASSWORD`（`test-smoke.js:32`、`test-basepath.js:25`），缺省时报错提示，避免默认密码移除后静默 401
- **所有自起 server 子进程的脚本必须在 spawn env 里补 `JWT_SECRET`**（`test-fs-api.js:39`、`test-runner-api.js` 的 `startServer`、`test-chat-api.js:45`、`test-chat-sessions-api.js` 同类位置）——否则新规则会直接启动失败
- `test-smoke.js:34` 的 `返回 token` 断言改为「响应体不含 `token` 字段」+「`Set-Cookie` 含 `sp_token=`」，并**新增**一条负向断言：伪造 `Authorization: Bearer <任意串>` 访问 `/api/metrics` 应 401（验证请求头通路确已移除）

## 影响面与兼容性

- **部署影响必须提示**：本次改动全部在 `server/` 目录内，而 `sync-tkp.ps1:19-20` 只上传 `server.js` / `package.json` / `run.sh` / `dist/*`，**不含 `server/`**。用户已选择不改该脚本，因此需在交付说明中明确：同步到 tkp 不会生效，需手动 `scp -r server tkp:/root/watchdog-os/`（或另行处理）。
- **启动前置条件变更**：远端 `config.json` / `.env` 需补 `jwtSecret`（或 `JWT_SECRET`），否则进程 fail-fast 退出——这是用户明确选择的 fail-fast 语义。
- `public/` 旧版零依赖前端只依赖 Cookie 与登录状态码，不受影响。
- 性能：所有新增校验均为 O(1) 字符串比较，无循环、无额外 I/O（`parseCookies` 的 try/catch 仅在畸形输入时触发）；不引入任何缓存或状态存储。

## 目录结构

本次改动共 6 个后端/前端源码文件 + 7 个测试脚本 + 2 个工程文件。

```
watchdog-os/
├── server/
│   ├── config.js            # [MODIFY] ① 删除第 40 行 password 默认值（使 125-128 的 fail-fast 生效，提示文案补全三个来源）
│   │                        #          ② JWT_SECRET 必配（env → config.json jwtSecret → 缺失/长度<32B 则 fatal 退出），移除密码派生
│   │                        #          ③ JWT_EXPIRES_IN 加 clamp 300~2592000，非法值回退 86400 + warn
│   │                        #          ④ 新增 PUBLIC_ORIGIN（逗号分隔白名单）⑤ terminal.credential + TTYD_CREDENTIAL 覆盖
│   │                        #          ⑥ module.exports 增补 PUBLIC_ORIGIN、ORIGIN_ALLOW_LIST（规范化后）
│   ├── lib/
│   │   ├── auth.js          # [MODIFY] checkAuth 仅保留 Cookie 通路（删 x-auth-token / Authorization）；
│   │   │                    #          verifyJwt 保持固定 HS256 + timingSafeEqual，exp 改为严格类型与数值校验
│   │   └── http.js          # [MODIFY] parseCookies 单个 value 的 decodeURIComponent 包 try/catch，函数不再抛异常
│   ├── router.js            # [MODIFY] /api/health 去掉 hostname；/api/login 响应体去掉 token；
│   │                        #          handleUpgrade 新增 originAllowed 校验（置于 checkAuth 前，缺失 Origin 放行）
│   │                        #          终端块新增503 Terminal credential missing 分支（方案 A）
│   └── api/
│       └── terminal.js      # [MODIFY] startTtyd 在 -p 后注入 -c（credential 非空时）；credential 缺失时早退不 spawn（方案 A）；
│                            #          proxyTerminalToken 注入 Authorization: Basic，上游 401/403 → 502；
│                            #          proxyTerminalWs 额外剥离 authorization / x-auth-token
├── src/
│   ├── api.ts               # [MODIFY] HealthInfo 去掉 hostname 字段（其余类型不动）
│   └── LoginApp.tsx         # [MODIFY] 移除 hostname state 与标题绑定，标题固定 System Monitor；保留 fetchHealth 可达性探测
├── test-smoke.js            # [MODIFY] 密码读 env；token 断言改为「响应体无 token + Set-Cookie 含 sp_token」；新增 Bearer 头应 401 的负向断言
├── test-basepath.js         # [MODIFY] 硬编码 admin123 → process.env.PASSWORD（缺省报错）
├── test-fs-api.js           # [MODIFY] login改 Cookie鉴权；spawn env 补 JWT_SECRET；password 读 env
├── test-runner-api.js       # [MODIFY] 同上（startServer 统一注入 JWT_SECRET）
├── test-chat-api.js         # [MODIFY] 同上
├── test-chat-sessions-api.js # [MODIFY] 同上
├── .tmp-runner-build.js     # [MODIFY] http.request 收集 set-cookie 改用 Cookie 头（临时脚本，非核心文件）
├── .gitignore               # [MODIFY] 新增 login.yaml 忽略规则（防回归）
├── login.yaml               # [DELETE] 含明文口令的历史快照；删除不等于清除 git 历史，需提示轮换该口令
└── AGENTS.md                # [MODIFY] 后端配置变量表新增 JWT_SECRET(必配) / JWT_EXPIRES_IN / TTYD_CREDENTIAL / PUBLIC_ORIGIN；
                             #          移除「默认密码」表述，补充安全约定：鉴权仅认 Cookie、WS 校验 Origin、登录不回传 token、ttyd 凭据要求
```

## 关键代码结构

```js
// server/config.js —— 新增/变更的导出（其余保持不变）
/** JWT 签名密钥：env JWT_SECRET → config.json jwtSecret → 缺失则 exit(1)；要求 ≥32 字节 */
const JWT_SECRET = resolveJwtSecret();      // string
/** token 有效期（秒），来源 .env 的 JWT_EXPIRES_IN，已 clamp 到 [300, 2592000]，默认 86400 */
const JWT_EXPIRES = clampExpires(process.env.JWT_EXPIRES_IN);
/** WebSocket Origin 白名单：cfg.publicOrigin 按逗号切分并小写规范化；为空表示仅同源 */
const ORIGIN_ALLOW_LIST = parseOriginList(process.env.PUBLIC_ORIGIN || cfg.publicOrigin);

// server/lib/auth.js —— 签名与返回值不变，仅收窄取值来源
/** 校验 JWT：固定 HS256 重算 + timingSafeEqual + exp 严格校验（number & finite & 未过期）；失败返回 null */
function verifyJwt(token) {}
/** 从 HttpOnly Cookie 取 JWT 校验；仅 Cookie，解析异常视为未通过 */
function checkAuth(req) {}

// server/api/terminal.js —— 新增导出供 router 判定503 文案
/** 已启用但未配置 terminal.credential（方案 A 下用于不 spawn 并给出可操作提示） */
function ttydCredentialMissing() {}
```

