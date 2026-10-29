# 移动端 / 小屏适配（iPhone · iPad）

手机与平板访问面板时的布局与交互约定。实现集中在三处：断点层 `src/responsive.ts`、移动外壳 `src/mobile/`、样式作用域 `src/styles.css` 的「移动端 / 平板适配」段。

## 1. 目标与断点

| 档位 | 宽度 | 交互形态 |
| --- | --- | --- |
| `mobile` | < 768px（含 iPad 1/3 分屏 320~507px） | **移动外壳**：首页图标网格 + 单 app 全屏 + 精简菜单栏 + 右下角返回首页 |
| `tablet` | 768 ~ 1024px（iPad 竖屏 / 横屏 / 分屏宽态） | 保留多窗口，窗口尺寸夹进可视区，控件按触控放大 |
| `desktop` | > 1024px | 与改造前完全一致 |

- 判定是纯函数 `layoutForWidth(width)`；浏览器侧由 `useViewport()`（`matchMedia` / `resize` 单例 + `useSyncExternalStore`）驱动，**只在跨断点时重渲染**，滚动零开销。
- 结果写到 `<html data-wd-layout="mobile|tablet|desktop">`（以及 `data-wd-touch`），样式层只按该属性作用域覆盖，组件不必层层传参。
- `main.tsx` 在 `createRoot` 之前调用 `initViewport()`：首帧即为正确档位，不会出现「先画桌面再跳移动」的闪动。
- 旋转屏幕、拖动 iPad 分屏时实时切换，不刷新页面。

## 2. 三层结构

```
src/responsive.ts            断点层：layoutForWidth / useViewport / initViewport（写 data-wd-layout、--wd-vv-h）
src/mobile/shellModel.ts     纯逻辑：homeIcons / isHomeVisible / closeAllActions / primaryWindowId（可 Node 单测）
src/mobile/MobileShell.tsx   组合：mobile 档才挂载，并把菜单栏高度量成 --wd-m-menu-h
src/mobile/MobileHome.tsx    首页：图标网格 + 品牌头 + 状态条
src/mobile/MobileHomeBar.tsx 悬浮「返回首页」
src/styles.css               样式层：所有覆盖规则限定在 html[data-wd-layout="…"] 作用域内
```

### 2.1 为什么窗口全屏只用 CSS，不写 store

classicy 窗口节点（`div.classicyWindow#<appId>_<windowId>`）的 `width / height / left / top / minWidth / minHeight` **全部是内联 style（非 important）**，样式表用 `!important` 即可覆盖为全屏。

反过来，如果走 `dispatch ClassicyWindowResize / ClassicyWindowPosition` 改尺寸，这些值会被持久化进 `localStorage.classicyDesktopState`——手机访问一次，桌面端的多窗口布局就被改坏了。**硬约束：移动端不得写窗口几何。**

### 2.2 为什么首页另起一套图标，而不是改桌面图标

`.classicyDesktopIcon` 是 `#classicyDesktop` 的**直接子元素**，靠内联 `top/left` 绝对定位，与窗口共用同一个父节点（没有图标容器可做 grid 布局）；交互也是鼠标语义（单击选中、双击打开、拖拽框选）。

因此 mobile 档用 `display:none` 隐藏原生图标，改由 `MobileHome` 读**同一份 store 数据**（`System.Manager.Desktop.icons`）重排成网格：

- 过滤：只保留自研 app（`appId` 以 `srv-` 开头）与磁盘卷（`kind === 'drive'`）；`hidden` / `kind === 'trash'` / `inApplications === false` 一律不出现——classicy 内置的 Sound Manager、Date & Time、Drive Setup 等因此不会混进首页。
- 打开动作沿用图标自带数据：有 `event` 就派发该事件（磁盘卷是 `ClassicyAppFinderOpenFolder`），否则派发 `ClassicyAppOpen`。
- **按显示名去重，app 优先**：磁盘卷与自研文件管理器都叫 `Macintosh HD`（`srv-finder.app` 的 `APP_NAME` 就是它，桌面端靠位置区分）。手机上同名只会让人点错，故只留自研版（功能完整；内置 Finder 是深度受限的系统盘门面）。

### 2.3 打开 app 后为什么要补一次 Focus

classicy 的 `ClassicyAppOpen` 会把该 app **所有已注册窗口**的 `closed` 置 false 并逐个聚焦，最后聚焦者胜出。`srv-finder.app` 的收藏夹窗口是常驻渲染树，于是会出现「点 Macintosh HD 却看到 Favorites 空窗口」。

`MobileHome` 在 `ClassicyAppOpen` 之后补一次 `ClassicyWindowFocus`，目标是 `primaryWindowId()`（优先 `default: true` 的窗口，否则注册顺序上的第一个，即各 app 的主窗口）。

### 2.4 返回首页

`MobileHomeBar` 枚举所有 `closed === false` 的窗口，逐个 `dispatch ClassicyWindowClose`：

- 用 `ClassicyWindowClose` 而不是 `ClassicyAppClose`：app 保持已加载，再次进入无需重新注册，且对已关窗口幂等。
- 首页可见性只看「是否存在未关闭窗口」（`isHomeVisible`），**不看 `focusedAppId`**——返回首页后 classicy 不会清空它，以它为判据会永远回不到首页。

### 2.5 菜单栏

- 手机端隐藏 `.classicyDesktopMenuAppSwitcher`（无 Cmd-Tab 语义）与声音开关（省宽度），缩字号/内边距，菜单条可横向滑动。
- **不要**改顶级菜单项的 `flex-wrap`：classicy 用「标题 + `width:100%` 下拉容器」布局，改成 nowrap 会让下拉落到标题下方或整体溢出屏幕（`styles.css` 里 `fm-*` 那组注释记着同一个坑）。
- 菜单栏高度由 `MobileShell` 用 `ResizeObserver` 量出写入 `--wd-m-menu-h`，全屏窗口 `top` 取该变量：菜单栏 `z-index: 500` 在窗口之上，硬编码高度会把标题栏与关闭框压到菜单下面。

### 2.6 高度链

手机端去掉 `.classicyWindow` 的 `padding` 后，classicy 内容区原有的 `height: calc(100% - control - padding*1.5)` 与真实可用高度差 1~2px，最后一整行会被 `overflow:hidden` 裁掉（状态栏文字缺一截）。因此 mobile 档把 `.classicyWindow` 改成 flex 列、内容区 `flex:1 1 auto; height:auto`，精确吃掉剩余高度。

## 3. 触屏与 iOS 细节

| 项 | 做法 |
| --- | --- |
| 安全区（刘海 / 圆角 / Home 条） | `index.html` viewport 加 `viewport-fit=cover`；菜单栏 `padding-top`、首页、悬浮键、登录页分别用 `env(safe-area-inset-*)` 补内边距 |
| 动态视口高度 | `html/body/#root` 用 `@supports (height: 100dvh)` 覆盖为 `100dvh`；全屏窗口 `height: calc(100dvh - var(--wd-m-menu-h))`；`--wd-vv-h` 由 `visualViewport` 兜底 |
| 输入框聚焦自动放大 | mobile / tablet 档 `input, textarea, select` 字号统一 16px（iOS 低于 16px 会缩放整页） |
| 整页橡皮筋 | `body { overscroll-behavior: none }`；滚动容器单独 `overscroll-behavior: contain` |
| 触控目标 | 关闭框视觉 18px + 伪元素把命中区扩到约 42px；工具栏按钮 ≥26px；首页图标单元 ≥92px；返回首页 44×44 |
| 缩放 / 折叠框 | 手机端隐藏（指腹误触会把窗口拖成半屏），只保留关闭框；控制框的外层 `.classicyWindowControlBox` 要一并收掉，否则标题栏右侧留一个空盒子 |
| 弹出对话框 | 手机端 `.sp-dialog` 收成 `calc(100vw - 24px)` 宽、`max-height: 80dvh`；classicy 模态窗口改为居中卡片而非全屏 |

## 4. 逐 app 降级清单

| app | 手机端表现 |
| --- | --- |
| WatchDog OS（监控） | 全屏；仪表并排、历史曲线独占一行、CPU 核心单列 |
| Docker / Printer / 审计 | 表格横向滑动（`-webkit-overflow-scrolling: touch`）；审计概览卡两列、事件表限高 40dvh、筛选输入独占一行 |
| 聊天 | 左侧会话栏改成顶部横条（限高 132px）；气泡最大宽度 92%；输入区收紧 |
| 文本编辑器 | `ClassicySplitView` 由 `useViewport()` 传 `direction="vertical"`（手机上分栏改上下堆叠；SplitView 用内联 flex-basis，纯 CSS 改不了轴），状态栏允许换行 |
| 文件管理器 / HEIC 转换器 | 工具栏换行，地址栏独占第二行；图标视图单元格收窄；文件卡与进度行换行 |
| 终端 | 全屏后由既有 `ResizeObserver` + `FitAddon` 自动重算行列；`touch-action: pan-y` 避免与 xterm 滚动手势打架 |
| 登录页 | 窗口铺满宽度上限 380px，品牌名降到 16px（Silkscreen 取 8 的倍数才不糊），输入框/按钮加高到 34px |

## 5. 明确降级（手机上不提供）

- 窗口拖拽移动、自由缩放、缩放框 / 折叠框；多窗口并排（叠放时只有最上面的可见）。
- 桌面图标框选、右键菜单（触屏无右键语义）、Classicy 内置示例 app 的入口。
- 平板档保留多窗口与拖拽，只是尺寸被夹进可视区（`max-width/max-height` 用 `!important` 写死，因为 `initialSize` 只在首帧生效、历史持久化尺寸不受其约束）。

## 6. 扩展规矩

1. **新增 app 无需改移动代码**：首页与返回首页都基于 store（`Desktop.icons` / `Applications.apps`）与 `srv-` 前缀工作。
2. **新增移动样式必须加作用域**：写成 `html[data-wd-layout="mobile"] .sp-xxx { … }`，禁止裸写 `.sp-toolbar { … }`——后者会直接回归桌面端。
3. 需要按档位改结构（而不只是样式）时，用 `useViewport()` 取 `layout`，不要各自监听 `resize`。
4. 桌面专属交互（拖拽、右键、快捷键）在手机端可降级，但**不得为了手机端去改桌面端的窗口几何、菜单结构或轮询语义**。

## 7. 验证

```bash
node test/test-mobile-shell.mjs   # 断点边界 / 首页图标过滤与去重 / 首页可见性 / 返回首页枚举 / 主窗口选择
npx tsc --noEmit && npm run build
```

浏览器侧（可用 `agent-browser`，登录后逐档位看）：

| 尺寸 | 期望 |
| --- | --- |
| 390×844（iPhone 14/15）、430×932（Pro Max） | 先落登录页（输入框 16px）；登录后是 3 列图标网格 + 底部状态条；点任一图标 → 单 app 全屏（标题栏紧贴菜单栏下沿、无缩放/折叠框）；右下角 44×44 返回键回到首页 |
| 767×900 / 768×1024 | 767 仍是移动外壳；768 起恢复多窗口、桌面图标保留 |
| 1024×768 | 多窗口，窗口不超出视口 |
| 1280×800 | 与改造前完全一致（无首页、无悬浮键、菜单栏含声音图标与应用切换器） |

> Chrome DevTools 的设备模拟不会施加 `env(safe-area-inset-*)`（全为 0），安全区只能在真机或 iOS Simulator 上目视确认；模拟器里重点看首页顶部、悬浮键与登录页底部不贴边。
