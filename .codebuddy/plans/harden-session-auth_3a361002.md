---
name: harden-session-auth
overview: 加固watchdog-os 会话鉴权：JWT 密钥与密码解耦并强制显式配置、移除默认密码与 Header 鉴权通路、Cookie 按 HTTPS 自动加 Secure、token 有效期可配置、WS 升级校验 Origin、匿名信息收敛，并将测试脚本与同步脚本分别归入 test/ 与 scripts/ 目录。
todos:
  - id: config-secret-policy
    content: 改造 config.js：删除默认密码、JWT_SECRET 必配校验、JWT_EXPIRES_IN 上下界、COOKIE_SECURE 与 PUBLIC_ORIGIN 解析
    status: completed
  - id: auth-cookie-only
    content: 收窄 checkAuth 为仅 Cookie，verifyJwt 严格校验 exp，parseCookies 异常容错
    status: completed
  - id: router-and-terminal
    content: router.js 落地 Secure Cookie、health 去 hostname、login 去 token、WS Origin 白名单；terminal.js 剥离敏感头
    status: completed
    dependencies:
      - config-secret-policy
      - auth-cookie-only
  - id: frontend-anon
    content: 前端联动：api.ts HealthInfo 去 hostname，LoginApp 标题固定并移除 hostname 状态
    status: completed
    dependencies:
      - router-and-terminal
  - id: test-scripts-cookie
    content: 迁移 6 个脚本到 test/ 改 Cookie 鉴权与 env 密码、补 JWT_SECRET，新增 Bearer 头 401 负向断言
    status: completed
    dependencies:
      - router-and-terminal
  - id: cleanup-docs
    content: 删除 login.yaml 与临时脚本、sync-tkp.ps1 移入 scripts/ 修正 $root、补 .gitignore、更新 AGENTS.md 配置表与安全约定
    status: completed
    dependencies:
      - config-secret-policy
      - router-and-terminal
---

## 用户需求

对 watchdog-os 服务端会话鉴权进行加固，修复首轮安全分析中确认的风险，并调整配置策略与目录结构。

## 修复范围

1. **JWT 密钥与密码解耦**：签名密钥不再由访问密码确定性派生，改为必须显式配置（`.env` / 环境变量 / `config.json`），缺失或过短则拒绝启动。
2. **移除默认密码**：删除内置默认口令，检测不到密码配置时禁止服务启动（fail-fast），并给出可操作的提示。
3. **token 有效期可配置**：支持在 `.env` 中配置签发有效期，并加合理上下界防止误配。
4. **Cookie Secure 标志**：新增三态策略 `COOKIE_SECURE=auto|1|0`（默认 `auto`）——请求走 HTTPS 或经代理标注 HTTPS 时附加 `Secure`，纯 HTTP 内网访问不受影响。
5. **WebSocket 来源校验**：终端 WS 升级增加来源白名单校验，跨站来源拒绝，同源与无来源的非浏览器客户端放行。
6. **收紧会话校验**：畸形 Cookie 不再触发服务端异常（返回 401 而非 500）；令牌过期字段做严格类型与数值校验。
7. **WS 代理头清理**：转发到 ttyd 前剥离会话相关请求头。
8. **匿名信息收敛**：公开的健康检查接口不再返回主机名；登录响应体不再回传令牌。
9. **鉴权通路收敛**：会话校验只认 HttpOnly Cookie，不再接受 `x-auth-token` / `Authorization` 请求头。

## 配套改动

- 目录重组：6 个测试脚本移入 `test/`；同步脚本移入 `scripts/`；`run.sh` 与 `tools/` 保持原位；临时构建脚本直接删除。
- 测试脚本改造：改用 Cookie 鉴权、密码改为从环境变量读取、自起服务时补齐新的必配密钥变量，并新增负向断言验证请求头通路确已移除。
- 删除被版本控制跟踪、含明文口令的历史快照文件并加入忽略规则。
- 更新项目文档：新增配置项说明、安全约定与已知风险记录。

## 明确不在本次范围

登录限流与审计、会话吊销、权限模型拆分、ttyd 凭据保护（本次暂缓，需在文档中留作已知风险）。


## 技术栈

沿用现有栈，**不引入任何新依赖**：

- 后端：Node.js 原生（零第三方依赖，硬约束），`server/` 分层为 `config.js` / `lib/` / `api/` / `router.js` / `static.js`
- 前端：React 19 + TypeScript + classicy（仅两处类型/文案联动，无 UI 改版）
- 测试：`test-*.js` 零依赖冒烟脚本（自起 server 子进程）
- 配置：沿用「config.json 配置节 + 环境变量覆盖」既有模式，`.env` 由 `server/config.js:16-27` 的 `loadEnv()` 解析，新增变量自动生效

## 实施策略

**总原则**：只做「删通路 / 加校验 / 换密钥来源」，不重构路由结构、不改 basePath 语义、不动 `401 优先于 503` 的既有约定。改动集中在 4 个后端文件 + 2 个前端文件 + 6 个测试脚本 + 2 个脚本文件 + 2 个工程文件。

### 1. 配置层（`server/config.js`）

**密码 fail-fast**：删除默认值对象第 40 行 `password: 'admin123'`。`server/config.js:125-128` 已存在 `if (!cfg.password) { ... process.exit(1); }`，删除默认值后该分支自然生效，仅需把提示文案补全（点名 `config.json` 的 `password`、`.env`/环境变量的 `PASSWORD`、以及新设的 `.env.example` 提示）。这是本次唯一「删除即生效」的改动。

**JWT_SECRET 必配**（用户明确选择 fail-fast）：解析顺序 `process.env.JWT_SECRET` → `fileCfg.jwtSecret` → 缺失则 `[fatal]` 退出。密钥以 UTF-8 字符串参与 HMAC，无需 hex/base64 解码，但要求 `Buffer.byteLength >= 32`，不足同样 fatal——把弱密钥挡在启动阶段。彻底移除 `config.js:142-146` 的 `sha256('sysprobe::jwt::' + cfg.password)`` 派生。

> 副作用（预期且需在交付说明中告知）：改密码不再导致全员登出（密钥与密码解耦的代价），换密钥才会。这是安全与运维便利的显式取舍。

**token 有效期**：`JWT_EXPIRES_IN`（秒）名称保留以免破坏现有 `.env`；加 clamp 到 `[300, 2592000]`（5 分钟 ~ 30 天），非法值回退 `86400` 并 `console.warn`。签发处 `exp = iat + JWT_EXPIRES`（`router.js:53`）与 Cookie `Max-Age` 同源，无需改动。

**COOKIE_SECURE 三态**：新增 `COOKIE_SECURE=auto|1|0`（默认 `auto`），规范化为 `always` / `never` / `auto`三个模式常量导出。`auto` 的判定逻辑放在 `router.js`（需要 `req`），`config.js` 只负责解析与规范化。

**PUBLIC_ORIGIN**：新增 `PUBLIC_ORIGIN`（`.env` / `config.json` / 环境变量，逗号分隔多值），规范化为小写、去掉尾部 `/` 的数组 `ORIGIN_ALLOW_LIST` 导出，空数组表示「仅同源」。

**fail-fast 顺序**：`loadEnv()` 与 `fileCfg` 读取在模块顶层，所有 `process.exit(1)` 必须位于其之后（`125` 行之后区域），确保 `.env` 已生效。

### 2. 鉴权通路收敛（`server/lib/auth.js`、`server/lib/http.js`）

**`checkAuth` 只认 Cookie**：删除 `x-auth-token` 与 `Authorization: Bearer` 两条分支，仅保留 `parseCookies(req)[COOKIE_NAME]`。**函数签名与返回类型保持不变** → `router.js` 的 6 处 `checkAuth` 调用点与 `handleUpgrade` 的 1 处**零改动**。

**`verifyJwt` 收紧**：保留「固定用 HS256 重算 + `timingSafeEqual` + 先比长度」的安全写法（`alg:none` / 算法混淆攻击本就不成立，**严禁改坏**）。`exp` 校验改为严格形式 `typeof payload.exp !== 'number' || !Number.isFinite(payload.exp) || payload.exp <= Math.floor(Date.now()/1000)` → `null`，修复 `exp:"abc"` 时比较为 NaN 被判「未过期」的漏洞。

**`parseCookies` 容错**（`http.js:31`）：`decodeURIComponent` 包 try/catch，失败时**原样保留该 pair 的原始值**（而非丢弃），使其稳定落到 `verifyJwt` 被拒 → 401。分层原则：解析器宽容、校验器严格。函数**永不抛异常**。`safeEqual` / `send` / `readBody` / `runCmd` 一律不动。

### 3. 路由与终端（`server/router.js`、`server/api/terminal.js`）

**Cookie Secure 落地**：登录处把 Cookie 属性数组改为条件追加 —— 新增模块内私有函数 `cookieSecureFor(req)`，按 `COOKIE_SECURE` 模式判定：`always` → 无条件加；`never` → 不加；`auto` → `req.socket.encrypted` 为真、或 `X-Forwarded-Proto` 首段为 `https`、或 `X-Forwarded-Ssl: on` 时加。这样 Nginx 终结 TLS 的部署自动获得 `Secure`，内网纯 HTTP 部署不受影响（避免「登录成功但后续全 401」的致命回归）。

**匿名面收敛**：`/api/health`（`router.js:32`）去掉 `hostname`，保留 `{ ok, basePath }`（`os` 仍被第 71 行 `os.uptime()` 使用，**不可删 require**）；`/api/login`（`router.js:62`）去掉 `token` 字段，保留 `{ ok: true, expiresIn }`。二者均不破坏前端：`src/api.ts:128-136` 的 `login()` 只看状态码。

**WS Origin 校验**：新增模块内私有函数 `originAllowed(req)`，判定通过后原有 `enabled/ttydReady/checkAuth` 顺序与语义**完全不变**，失败统一 `socket.destroy()`（不回 HTTP 响应，与现状一致）。规则：
1. `Origin` 头缺失 → **放行**（curl、测试脚本等非浏览器客户端必须可用）
2. `ORIGIN_ALLOW_LIST` 非空 → 规范化后（`protocol//host` 小写）在白名单内则放行
3. 否则按同源推导：与 `http://<Host>` 或 `https://<Host>` 之一相等即放行（覆盖 Nginx 终结 TLS）；`Host` 缺失且无白名单 → 拒绝

置于 `checkAuth` **之后**（先鉴权后校验来源），与项目「401 优先」的既有风格一致，且未鉴权者无法据此探测配置。

**WS 代理头清理**（`terminal.js:163`）：在已有 `delete h.cookie` 之后补 `delete h.authorization` / `delete h['x-auth-token']`，做纵深防御。`startTtyd()`（31-46）与 `proxyTerminalToken()`（132-152）**本次保持原样**（ttyd 凭据方案暂缓）。

### 4. 前端联动（最小改动）

- `src/api.ts`：`HealthInfo` 去掉 `hostname` 字段。
- `src/LoginApp.tsx`：移除 `hostname` state 与标题绑定，标题固定 `System Monitor`（与既有 catch 分支文案一致）；`fetchHealth()` 保留调用作后端可达性探测，不再消费 hostname。
- **不动** `src/apps/MonitorApp.tsx:62` 与 `src/components/SystemInfoPanel.tsx:8`——它们的 `host.hostname` 来自**已鉴权的** `/api/metrics`，与匿名面收敛无关，避免扩大范围。
- `src/apps/TerminalApp.tsx` 零改动：WS 连接逻辑（`323-342`）与 503 语义均不变。

### 5. 目录重组与测试脚本改造

统一三件套：`ROOT = path.join(__dirname, '..')`、`PASSWORD = process.env.PASSWORD || 'test123'`、`JWT_SECRET` 环境变量兜底。

| 脚本 | 现状（已核实） | 改造 |
|---|---|---|
| `test-fs-api.js` | `:37-41` `spawn(process.execPath, ['server.js'])` **相对路径 + 无 cwd**；`:49-57` 注释明写「用 Bearer，隔离 Cookie 因素」 | `[path.join(ROOT,'server.js')]` + `cwd: ROOT` + env 补 `JWT_SECRET`；login 改取 `set-cookie` 首段 |
| `test-runner-api.js` | `:62-69` 已用 `path.join(__dirname,'server.js')` + `cwd: __dirname`；`:71-79` Bearer | 路径改 `ROOT`；login 改 Cookie |
| `test-chat-api.js` | `:43-44` 同上模式；`:50-58` Bearer | 同上 |
| `test-chat-sessions-api.js` | `:98-111` 同上模式；`:136-144` Bearer | 同上 |
| `test-smoke.js` | 连已有服务（`BASE_HOST`）；`:32` 硬编码 `admin123`；`:34` 断言 `token.length === 64`；`:35` 已用 Cookie | 密码读 env；`:34` 改负向断言（响应体**无** `token` + `Set-Cookie` 含 `sp_token`）；**新增**伪造 `Authorization: Bearer` 访问 `/api/metrics` 应 401 的断言 |
| `test-basepath.js` | 连已有服务（`localhost:3001`）；`:25` 硬编码 `admin123`；`:27-28` 已用 Cookie | 密码读 env，缺省报错提示 |

> `cwd` 必须保持项目根：`config.js:138` 的 `cfg.diskMounts` 在为空时取 `process.cwd().slice(0, 3)`。

`package.json:6-11` 的 `scripts` 不引用任何测试脚本，移动文件不影响 npm 命令。

**同步脚本**：`sync-tkp.ps1` 移入 `scripts/`，仅需将第 5 行 `$root = $PSScriptRoot` 改为 `$root = Split-Path $PSScriptRoot -Parent`（全文所有路径均由此派生）。**删除** `.tmp-runner-build.js`。

## 影响面与兼容性

- **⚠️ 部署影响必须提示**：本次后端改动全部在 `server/` 目录内，而 `sync-tkp.ps1:19-20` 只上传 `server.js` / `package.json` / `run.sh` / `dist/*`，**不含 `server/`**。用户选择不补传，因此需在交付说明中明确：同步到 tkp 不会生效，需手动 `scp -r server tkp:/root/watchdog-os/`。
- **启动前置条件变更**：远端 `config.json` / `.env` 必须补 `JWT_SECRET`（≥32 字节），否则进程 fail-fast 退出——这是用户明确选择的语义。
- **改动即失效的旧行为**：所有依赖 `Authorization` / `x-auth-token` 的外部调用方（含用户自建 curl 习惯）需改用 Cookie。
- `public/` 旧版零依赖前端只依赖 Cookie 与登录状态码，不受影响。
- 性能：所有新增校验均为 O(1) 字符串比较或一次数组 `includes`（白名单通常0~3 项），无循环嵌套、无额外 I/O；`parseCookies` 的 try/catch 仅在畸形输入时触发。**不引入任何缓存或会话状态存储**。

## 目录结构

```
watchdog-os/
├── server/
│   ├── config.js            # [MODIFY] ① 删除第 40 行 password 默认值（使 125-128 fail-fast 生效，提示文案补全来源）
│   │                        #          ② JWT_SECRET 必配（env → config.json jwtSecret → 缺失/字节数<32 则 fatal），移除密码派生
│   │                        #          ③ JWT_EXPIRES_IN clamp [300, 2592000]，越界 warn + 非法值回退 86400
│   │                        #          ④ 新增 COOKIE_SECURE（always/never/auto 三态解析）⑤ 新增 PUBLIC_ORIGIN → ORIGIN_ALLOW_LIST
│   │                        #          ⑥ module.exports 增补 COOKIE_SECURE_MODE 与 ORIGIN_ALLOW_LIST
│   ├── lib/
│   │   ├── auth.js          # [MODIFY] checkAuth 收窄为仅 parseCookies(req)[COOKIE_NAME]，删除 x-auth-token / Authorization 分支
│   │   │                    #          verifyJwt 保持固定 HS256 重算 + timingSafeEqual，exp 改为 typeof/Number.isFinite/时序三重校验
│   │   └── http.js          # [MODIFY] parseCookies 单 pair 的 decodeURIComponent 包 try/catch，异常时原样保留值，函数不再抛异常
│   ├── router.js            # [MODIFY] /api/health 去掉 hostname（保留 os require，第 71 行仍用）
│   │                        #          新增私有 cookieSecureFor(req) 实现 auto判定（encrypted / X-Forwarded-Proto / X-Forwarded-Ssl）
│   │                        #          /api/login 条件追加 Secure 属性、响应体去掉 token 字段
│   │                        #          新增私有 originAllowed(req)，置于 handleUpgrade 的 checkAuth 之后
│   └── api/
│       └── terminal.js      # [MODIFY] proxyTerminalWs 在 delete h.cookie 后补 delete h.authorization / h['x-auth-token']
│                            #          （startTtyd 与 proxyTerminalToken 本次不动，ttyd 凭据方案暂缓）
├── src/
│   ├── api.ts               # [MODIFY] HealthInfo 去掉 hostname 字段，其余类型与函数不动
│   └── LoginApp.tsx         # [MODIFY] 移除 hostname state 与 document.title 绑定，标题固定 System Monitor；保留 fetchHealth 探测
├── test/                    # [NEW] 冒烟测试目录（从根目录移入 6 个脚本，路径依赖同步修正）
│   ├── test-smoke.js        # [MOVED+MODIFY] 密码读 env；:34 token 断言改负向；新增 Bearer 头应 401 断言
│   ├── test-basepath.js     # [MOVED+MODIFY] :25 硬编码 admin123 → process.env.PASSWORD（缺省明确报错）
│   ├── test-fs-api.js       # [MOVED+MODIFY] spawn 改绝对路径 + cwd: ROOT + env 补 JWT_SECRET；login 改 Cookie 鉴权
│   ├── test-runner-api.js   # [MOVED+MODIFY] startServer 路径改 ROOT、env 补 JWT_SECRET；login 改 Cookie
│   ├── test-chat-api.js     # [MOVED+MODIFY] 同上
│   └── test-chat-sessions-api.js  # [MOVED+MODIFY] 同上
├── scripts/
│   └── sync-tkp.ps1         # [MOVED+MODIFY] 第 5 行 $root 改为 Split-Path $PSScriptRoot -Parent，其余路径引用不动
├── .tmp-runner-build.js     # [DELETE] 临时构建脚本（依赖已移除的响应体 token），直接删除
├── .gitignore               # [MODIFY] 新增 login.yaml 忽略规则防回归
├── login.yaml               # [DELETE] 被 git 跟踪且含明文口令的历史快照；删除不等于清除 git 历史，需提示轮换该口令
└── AGENTS.md                # [MODIFY] 常用命令更新为 node test/test-*.js；后端配置变量表新增 #          JWT_SECRET(必配)/JWT_EXPIRES_IN/COOKIE_SECURE/PUBLIC_ORIGIN；移除默认密码表述；
                             #          新增安全约定章节（仅 Cookie 鉴权、WS Origin 校验、登录不回传 token、Cookie Secure auto 策略）；
                             #          记录已知风险：ttyd 未配 -c，本机进程可绕过面板口令直取终端（本次暂缓）
```

## 关键代码结构

```js
// server/config.js —— 新增导出（既有导出保持不变）
/** Cookie Secure 模式：'always' | 'never' | 'auto'（默认 auto） */
const COOKIE_SECURE_MODE = parseCookieSecureMode(process.env.COOKIE_SECURE || cfg.cookieSecure);

/** WS Origin 白名单：PUBLIC_ORIGIN 逗号分隔，规范化小写并去尾部 /；空数组 = 仅同源 */
const ORIGIN_ALLOW_LIST = parseOriginList(process.env.PUBLIC_ORIGIN || cfg.publicOrigin);

// server/lib/auth.js —— 签名不变，仅收窄取值来源
/** 校验 JWT：固定 HS256 重算 + timingSafeEqual + exp 严格类型/数值/时序校验；失败返回 null */
function verifyJwt(token) {}

/** 从 HttpOnly Cookie 取 JWT 校验；仅 Cookie，解析异常视为未通过 */
function checkAuth(req) {}

// server/router.js —— 模块内私有函数（不导出）
/** Cookie Secure 判定：always恒真 / never 恒假 / auto 依 req 是否 HTTPS（含反代头） */
function cookieSecureFor(req) {}

/** WS 升级 Origin 白名单：缺 Origin 放行；命中 PUBLIC_ORIGIN 或同源放行；否则拒绝 */
function originAllowed(req) {}
```


## Agent Extensions

### Skill
- **verification-before-completion**
  - Purpose: 在交付前以实际命令输出验证结论——运行 `node test/test-fs-api.js`（自起服务、含鉴权与越权断言）与 `node test/test-smoke.js`（负向断言），并确认缺少 `JWT_SECRET` 时进程确实 fail-fast 退出。
  - Expected outcome: 每项安全加固都有可复现的验证证据（401行为、Cookie 属性、失败启动报错），避免在未验证的情况下宣称完成。
