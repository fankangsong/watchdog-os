# watchdog-os 交互与设计规范（Classicy · Platinum）

> 本规范是 watchdog-os 桌面（Classicy Webtop）所有应用的**唯一交互与视觉标准**。
> AI 编码代理在设计、改造任何应用（窗口、表单、按钮、列表、反馈）时**必须严格遵循本规范**，不得自行发明交互模式。
> 菜单栏的专项规则见 `AGENTS.md`「菜单设计规范」一节，本规范其余部分对其形成补充与细化，两者冲突时以本规范的视觉/交互细则为准。

---

## 0. 参考系与设计哲学

### 0.1 参考图（设计北极星）

`docs/design/` 下的 9 张截图来自外部参考软件（exe / Mac OS 9 风格 Webtop），代表本项目期望达到的交互与视觉水准。逐张拆解见 [附录 A](#附录-a参考图设计要点拆解)。核心特征：

- Platinum 窗口：条纹标题栏、左上关闭盒、右上折叠/缩放盒、右下缩角、1px 黑边
- 桌面：紫蓝 Happy Mac 棋盘壁纸、右列大图标（图形 + 下方名称，选中时名称高亮）
- 模态对话框小而聚焦，默认按钮带双线环，父窗变暗
- 窗口底部状态栏：左上下文 / 右全局信息
- 紧凑、克制、信息密度高，无多余装饰

### 0.2 官方资源

| 资源 | 地址 | 用途 |
|---|---|---|
| Classicy 官网 | https://classicy.ing/ | 概念与特性总览 |
| 在线 Showcase | https://demo.classicy.ing | 交互实机体验（菜单/窗口/主题/声音） |
| Storybook | https://demo.classicy.ing/storybook/ | 35+ 组件的 props 与用法速查 |
| Building Apps 指南 | github.com/robbiebyrd/classicy → `docs/BUILDING-APPS.md` | 应用/窗口/菜单/存储完整 API |
| Agent Reference | 同上 `docs/AGENT-REFERENCE.md` | 公开 API 参考 |

### 0.3 设计原则（按优先级排序）

1. **一致性优先于个性**：新应用必须在窗口结构、控件选用、反馈方式上与既有 9 个应用（Monitor / Docker / Terminal / Macintosh HD / Editor / Runner / Printer / Chat / imcolin）保持一致。用户在一个应用里学到的操作方式，必须能迁移到所有其他应用。
2. **桌面隐喻与 WIMP**：一切皆窗口与对象；操作为「选择对象 → 对对象执行命令」（菜单 / 工具栏 / 右键菜单三条等价路径）。
3. **状态可见**：系统在做什么、刚刚做完了什么、出了什么问题，必须能在窗口内直接看到（状态栏、进度、错误文本），不靠弹窗轰炸。
4. **宽容而非阻断**：破坏性操作必须可确认、可取消；输入错误给出明确原因；网络失败保留上次正常数据并提示。
5. **克制**：不使用渐变、阴影、圆角卡片等现代 Web 装饰；视觉重量只来自 Platinum 本身的斜面（bevel）与主题变量。

---

## 1. 桌面与窗口系统

### 1.1 桌面

- 壁纸、图标列、菜单栏由 `ClassicyDesktop` 系统渲染，**应用不得自绘桌面元素**。
- 每个应用在桌面产生一个图标；图标必须从 `ClassicyIcons` 内置命名空间选取语义最贴近的图标（参考 `src/Desktop.tsx` 现有 9 个应用的选法），保持全桌面图标风格统一；不引入自制位图图标。
- 应用注册与 Apple 菜单注入集中在 `src/Desktop.tsx`（含 `Sign Out` 注入 `sp-menu-logout`），新应用在此登记，**不得自建 System/Sign Out 菜单**。

### 1.2 窗口解剖（Platinum 标准结构）

```
┌─ title bar ──────────────────────────── [✕] [▁] [□] ─┐  ← 19px，条纹底，标题居中加粗
│ [icon] Window Title                                  │
├─ contents ────────────────────────────────────────────┤
│  toolbar band（可选：窗口操作按钮带，§3.2）            │  ← 浅色容器带 + 底部分隔线
│  ┌ ControlGroup / SplitView / Table … ┐              │
│  └────────────────────────────────────┘              │
│  status bar（可选，placard 或自绘 sp-status）         │
└─────────────────────────────────────────── [缩角] ───┘
```

| 部位 | 规则 |
|---|---|
| 标题栏 | 居中标题；主窗口标题 = 应用名或当前对象名；对话框标题 = 动作名（`New Folder`） |
| 关闭盒 | 左上，始终可点（`closable` 默认 true，不无故关闭） |
| 缩放盒 | 右上，主内容窗口保持 `zoomable`；模态对话框建议 `zoomable={false}` |
| 折叠盒 | 保持默认；窗口无折叠必要时也无需禁用 |
| 缩角 | `resizable` 主内容窗口保持 true；定尺寸对话框设 `resizable={false}` |
| 工具栏带 | 窗口级命令按钮置于内容区首部的浅色容器带（`--color-system-01` 底 + 1px 分隔线），见 §3.2；classicy 的 `header` 插槽仅用于列表型窗口的信息行 |
| 状态栏 | 简单左置状态用 `placard`；需要「左上下文 + 右全局」双区时用自绘状态栏（见 §7.1） |

### 1.3 窗口类型与选用

| 类型 | 实现 | 用于 | 约束 |
|---|---|---|---|
| 主窗口 | `ClassicyWindow`（默认 document） | 应用主体 | `defaultWindow` 标记；`initialSize`/`minimumSize` 见 §1.4 |
| 模态对话框 | `ClassicyWindow modal` | 需要输入/选择的确认与表单 | 尺寸紧凑（宽 320–420px）；`zoomable={false}`；不resizeable；父窗自动变暗 |
| 工具面板 | `ClassicyWindow windowType="utility"` | 浮动调色板类（暂未使用，预留） | `alwaysOnTop` 仅 utility 可用 |
| 次窗口 | 普通 `ClassicyWindow` + 独立 id | 关于、设置、快捷键、会话列表、预览 | 数量受限（同类 ≤ 3，超出复用/置顶），级联偏移防重叠 |

**命令式开窗（Preview/会话窗/Bridge 联动）必须双发**，只 Focus 不 Open 对已关窗口无效：

```tsx
dispatch({ type: "ClassicyWindowOpen", app: { id: appId }, window: { id: windowId } })
dispatch({ type: "ClassicyWindowFocus", app: { id: appId }, window: { id: windowId } })
```

同类多窗口级联偏移：`cascadeRef.current++ % 6 * 26`（FinderApp 预览窗现成实现）。

### 1.4 窗口尺寸规范

- **内容优先**：能用内容驱动就不用固定值（`initialSize={[0, 0]}` 或 `["45%", 0]`）。
- 主窗口：`initialSize` 取视口 45%–75%；必须给 `minimumSize`（防内容破碎），如 `[640, 460]`。
- 对话框：`initialSize` 紧凑（高由内容决定），`minimumSize` 同初始值。
- **禁止**无 `minimumSize` 的宽主窗口；禁止把主窗口初始尺寸设成接近全屏（桌面隐喻需要能看到壁纸与其他窗口）。

### 1.5 窗口 id 与持久化约定

- id 命名：`<应用前缀>-<角色>`，如 `monitor-main`、`fm-dialog`、`chat-sessions`；多实例 id 必须由实例派生（`` id={`myapp-note_${noteId}`} ``），**禁止多实例共享 id**（store 条目互踩）。
- id 是数据（analytics path + localStorage 持久化）：必须稳定、**不得包含用户内容**（文件名/城市名等）。
- 窗口位置/尺寸由 classicy 自动持久化（`localStorage["classicyDesktopState"]`），无需自存。

### 1.6 关闭拦截

- 有未保存改动的窗口必须用 `onBeforeClose` 返回 Promise 做 veto 确认（EditorApp 为样板）：

```tsx
onBeforeClose={async () => (dirty ? await confirmDiscard() : true)}
```

- 对话框的取消一律显式关闭，不依赖点关闭盒的歧义。

---

## 2. 菜单栏规范

完整规则见 `AGENTS.md`「菜单设计规范（macOS / classicy）」：四段式结构（应用名 / File / Edit / View / 特有 / Help）、`useMemo` 记忆化、`<前缀>-m-<命令>` id、`…` 省略号、`checked` 表达切换态、`disabled` 而非隐藏、快捷键字形风格。本规范补充：

- 每个应用必须提供 `useClassicyAboutMenu` 的 `aboutMenuItem` 并渲染 `aboutWindow`。
- 有标准文本输入的应用用 `useClassicyEditMenu(idPrefix)`；操作对象不是文本框（CodeMirror、终端、文件选择）才自建 Edit 组。
- 帮助项（快捷键说明、使用提示）经 `useClassicyHelpMenu(appId, useMemo(items))` 注册，**不自建 Help 菜单**。
- 快捷键在菜单项上声明；浏览器/终端本地拦截的项标 `nativeShortcut: true` 并按需 `disabled`。
- **classicy 菜单渲染两条必修项**（Macintosh HD（原 Disk）实战教训，2026-10）：
  1. **勾选列一致性**：classicy 仅对 `checked !== undefined` 的项渲染 15px 勾选列——同一菜单内混用会导致标题左起点不齐（无勾选列项左移 21px）。含 `checked` 项的菜单必须给**所有**项显式声明 `checked`（不可用切换项写 `checked: false`）；无任何 checked 项的菜单则全部不声明。
  2. **菜单不折行**：classicy 菜单项默认 `flex-wrap: wrap`，下拉宽度受顶级项宽度约束（仅 `min-width: 180px` 兜底），长标题/快捷键超出即折行——Mac 菜单从不折行、只应变宽。按菜单项 id 前缀覆盖：`li[id^="<前缀>-"] { flex-wrap: nowrap } li[id^="<前缀>-"] > p { white-space: nowrap }`。
  3. **快捷键须真实绑定**：classicy 的 `keyboardShortcut` 仅作展示、不自动生效（不同于 TerminalApp 的 `nativeShortcut` 浏览器拦截）。菜单声明了快捷键的应用必须自建 `keydown` 监听执行同一动作，并跳过输入框/编辑器焦点（避免劫持打字）。

---

## 3. 控件选用规范

### 3.1 组件映射表（先查表，再动手）

| 需求 | 必须使用 | 禁止 |
|---|---|---|
| 命令按钮 | `ClassicyButton` | 裸 `<button>` |
| 图标工具按钮 | `ClassicyBevelButton bevelWidth="small" square icon=…` 包 `ClassicyBalloonHelp` | 用 emoji/文字模拟图标按钮 |
| 窗口操作按钮带 | 内容区首部的浅色容器带（`--color-system-01` 底 + 1px 分隔线）+ `ClassicyButton` push 文字按钮（§3.2：白色按钮面、HIG 12px 间距、12px 文字） | 按钮裸露在内容流第一行 / `ClassicyButtonToolbar` 容器 / icon 按钮进按钮带 |
| 模式切换工具组（调色板） | `ClassicyButtonToolbar` + `ClassicyButtonToolbarGroup size="small"` + `ClassicyBevelButton square`（组内间距 ~4px） | 用 push 按钮表达模式切换 |
| 单行文本 | `ClassicyInput`（`labelTitle`/`labelPosition`/`placeholder`/`onEnterFunc`） | 裸 `<input>` |
| 多行文本 | `ClassicyInput` textarea 形态或终端/编辑器用专用组件 | — |
| 布尔开关 | `ClassicyCheckbox` | 自制 switch |
| 单选 | `ClassicyRadioInput` | 自制 |
| 枚举选择（≤7 项） | `ClassicyPopUpMenu` | 自制 `<select>` |
| 长列表选择 | `ClassicyListBox` / `ClassicyTable` | — |
| 数据表格 | `ClassicyTable`（列定义 `useMemo`） | 手写 `<table>` |
| 层级导航 | `ClassicyTree`（懒加载、`branchSelectable`） | — |
| 主从分栏 | `ClassicySplitView`（`defaultSizes`、`minPaneSize`） | 自制拖拽分栏 |
| 分区容器 | `ClassicyControlGroup`（`label`/`variant`） | 用卡片/边框 div 模拟 |
| 表单 + 按钮行 | `ClassicyForm layout="dialog"` + `ClassicyFormButtonRow` | — |
| 警告/确认 | `ClassicyAlert`（`alertType`） | `window.confirm` / 自绘浮层 |
| 进度 | `ClassicyProgressBar`（`indeterminate` 未知进度） | 自制 spinner |
| 资源计量 | `ClassicyMeter`（`value` + `low/high/optimum`） | 用进度条表达阈值语义 |
| 折叠区 | `ClassicyDisclosure` / `ClassicyTriangle` | — |
| 快捷键展示 | `ClassicyKbd variant="keycaps" shortcut="⇧⌘C"` | 文本拼 "Shift+Cmd+C" |
| 气泡帮助 | `ClassicyBalloonHelp`（`content`/`title`/`position`） | 原生 `title` 属性 |
| 右键菜单 | `ClassicyContextualMenuTarget` 包目标区域 | 监听 contextmenu 自绘 |

### 3.2 窗口操作按钮带（Window Action Button Strip）

**范本：参考图 1「Paint」顶部按钮 + imcolin.fan 的容器化工具栏。** 用于承载窗口级命令（导航、新建、上传、下载、刷新等）的主窗口。核心特征：**按钮置于窗口内的浅色容器带中，该带与标题栏、内容区均视觉分开**——按钮不属于内容流（不随内容滚动），但容器带本身是窗口内容区的首个元素。

> 演进记录：曾尝试「内容区第一行裸按钮」（无容器，与内容糊在一起，否决）→「header chrome 横带」（classicy header 插槽，高度链需补偿，且灰带观感偏重，否决）→ **本规范：窗口内浅色容器带（imcolin.fan 模式，终版）**。

#### 3.2.1 结构

```
┌─ title bar ────────────────────────────────┐
├─ contents ─────────────────────────────────┤
│ ┌─ toolbar band（浅色容器带）─────────────┐ │
│ │  [Back] [Up] …                         │ │  ← system-01 浅灰底，全宽
│ ├─────────────────────────────────────────┤ │  ← 1px 分隔线与内容区分开
│ │  icon/table content（白色，flex:1 滚动）│ │
│ └─────────────────────────────────────────┘ │
```

- 容器带是内容区（`.classicyWindowContentsInner` flex column）的首个元素，`flex: 0 0 auto` 不参与滚动；与标题栏之间由窗口框线分开，与内容区之间由**底部分隔线**（`--color-system-05`）分开。

#### 3.2.2 规则

| # | 规则 | 值 / 做法 |
|---|---|---|
| 1 | 位置 | 内容区首部的**浅色容器带**；按钮不得裸露在内容流第一行（无容器的做法已否决） |
| 2 | 容器带尺寸 | 高度 ~32px（按钮 20px + 上下 6px padding），全宽，`flex: 0 0 auto` |
| 3 | 容器带配色 | 背景 `--color-system-01`（浅灰）；底边 1px `--color-system-05` 分隔线；左右 padding ~10px |
| 4 | 按钮类型 | 一律 push **文字**按钮（`ClassicyButton`），动词短词；范本：`Undo` `Clear` `Resize` `Save…` `Export` |
| 4b | 按钮面色 | 按钮面 = `--color-white`（**亮于容器带**，形成「亮按钮 / 浅带」层次）；`:active`（按下加深）保留 classicy 默认，**不得覆盖**（选择器写 `:enabled:not(:active)`）；`:disabled` 按规则 10 覆盖 |
| 5 | 按钮尺寸 | **标准按钮**：保留 classicy 默认 58px 最小宽（`--hig-button-min-width`）与 HIG 8px 水平内边距（`--hig-button-text-padding`）；文字 12px（Platinum 经典 appFont 字号）；**禁止** `min-width: 0` 收窄或 `buttonSize="small"`（9.3px 过小） |
| 6 | 排布 | 单排左对齐，按钮间距 = `var(--hig-button-gap-h)`（12px）；语义分组靠顺序表达，不加分组分隔符；行内同基线同高度。**必须 `margin: 0`**——classicy 按钮默认带 6px 外边距，与 gap 叠加会变成 18px |
| 7 | default 环 | 仅当带内存在明确主操作时使用（范本 `Export`）；导航等无主操作的不设 |
| 8 | icon 按钮 | `ClassicyBevelButton square` 等 icon 按钮**禁入按钮带**（仅用于模式/格式切换工具组，见 §3.1） |
| 8b | 按钮内嵌前置图标 | 允许：push 文字按钮可带 16px 前置小图标（位于文本左侧、垂直居中、间距 ~5px，`.sp-tb-icon`）。图标为**像素画双色、固定配色**：深蓝 `#1b3d72` 描边 + 蓝 `#4a86d8` 面（与气泡同一支蓝；不用白面——启用态按钮底色即白，白面会与底色融合成一色）。固定色不跟随文字三态，故三态由 CSS filter 补：按下 `brightness(0) invert(1)` 反白成剪影（按下态按钮底是 #808080，深蓝描边会糊掉）、禁用 `grayscale(1) opacity(.5)` 压灰。语义与按钮动词一致，图标是文字陪衬，不把按钮变成 icon 按钮。现有用例：Macintosh HD 的 Back / Up / Favorites（制作流程见 icon-pipeline.md §1.2） |
| 9 | 右端上下文（可选） | 按信息密度取舍：右对齐、小一号等宽字体（~11px）、超长省略号；不放可交互控件 |
| 10 | 禁用态 | **Platinum 正宗化，不直接用 classicy 默认**：classicy 的 `:disabled` 会把按钮面退化为 `--color-system-03`（与旧条带同色、糊成一片）+ `--color-system-05` 灰边框；必须覆盖为**黑边框 + 容器带同色面（`--color-system-01`）+ 灰字 + 扁平（无 bevel）**——对齐真实 Mac OS 9 禁用钮（保留框，以扁平和灰字表达禁用） |

#### 3.2.3 标准实现模板（可直接复制）

```tsx
<ClassicyWindow id={`${prefix}-main`} appId={appId} title="…" scrollable={false} appMenu={appMenu}>
  {/* contents：flex column；工具栏带为首个元素，不随内容滚动 */}
  <div className="sp-toolbar">
    <ClassicyButton disabled={!canBack} onClickFunc={goBack}>Back</ClassicyButton>
    <ClassicyButton disabled={!canUp} onClickFunc={goUp}>Up</ClassicyButton>
  </div>
  {/* 内容区（flex: 1 可滚动）… */}
</ClassicyWindow>
```

```css
/* 高度链前提：禁窗口级滚动 + ContentsInner 钉为 flex column（见 §4.1） */
#<win> > .classicyWindowContents { overflow: hidden; }
#<win> .classicyWindowContentsInner { display: flex; flex-direction: column; overflow: hidden; }
/* ① 容器带（共享类 .sp-toolbar，Macintosh HD / WatchDog OS 已在用）：浅灰底 + 1px 分隔线，
      全宽，高 ~32px，不参与滚动；右端状态可加 .sp-toolbar-status（margin-left:auto） */
.sp-toolbar {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: var(--hig-button-gap-h);
  padding: 6px 10px;
  background: var(--color-system-01);
  border-bottom: var(--window-border-size) solid var(--color-system-05);
}
/* ② 按钮：HIG 12px 间距 + 标准按钮（58px 最小宽）+ 12px 文字；
      margin:0 清除默认 6px 外边距（否则与 gap 叠加成 18px）；
      白色按钮面亮于浅灰带 */
.sp-toolbar .classicyButton { margin: 0; font-size: 12px; }
.sp-toolbar .classicyButton:enabled:not(:active) { background-color: var(--color-white); }
/* ③ 禁用态 Platinum 正宗化：黑框 + 带同色面 + 灰字 + 扁平 */
.sp-toolbar .classicyButton:disabled { background-color: var(--color-system-01); border-color: var(--color-black); color: var(--color-system-05); }
/* ④ 带内 PopUpMenu（WatchDog OS 刷新间隔即此用法）：classicy 默认 width:100% + flex-grow:2，
      在 flex 带中会以整带宽为基础尺寸挤爆其他项（标签/按钮文字换行）——必须覆盖为
      内容定宽 + 不收缩；高度对齐按钮保持带高一致 */
.sp-toolbar > * { flex: 0 0 auto; }
.sp-toolbar .classicyPopUpMenuWrapper { width: auto; }
.sp-toolbar .classicyPopUpMenu { flex-grow: 0; width: 72px; height: var(--hig-button-height); }
```

> 选择器中的窗口定位 `#<win>` = `#{appId}_{windowId}`（点号转义，如 `#srv-finder\.app_fm-main`）。

#### 3.2.4 检查清单（新应用落地时逐项过）

- [ ] 按钮在内容区首部的**浅色容器带**内，不裸露在内容流第一行
- [ ] 容器带：`system-01` 浅灰底 + 1px `system-05` 底部分隔线 + 左右 ~10px padding
- [ ] 按钮为标准 push 文字按钮（58px 最小宽 + 12px 文字），间距 = `--hig-button-gap-h`，`margin: 0`，**不收缩**（`flex: 0 0 auto`，文字不换行）
- [ ] 带内 PopUpMenu 已覆盖 `width: 100%`/`flex-grow: 2` 默认值（内容定宽，不挤爆其他项）
- [ ] 按钮面白色（亮于带）；`:active` 不被覆盖
- [ ] 禁用态为「黑框 + 带同色面 + 灰字 + 扁平」，不与内容糊成一片
- [ ] 无 icon 按钮；无 default 环（除非带内有明确主操作）
- [ ] `scrollable={false}` + ContentsInner flex 钉死，带不随内容滚动、横向滚动条贴窗口底

### 3.3 默认按钮与对话框按钮行（HIG）

**默认按钮（primary action）**——每个对话框/表单有且仅有一个：

```tsx
<ClassicyButton isDefault buttonType="submit" disabled={!canSubmit}>Create</ClassicyButton>
```

- `isDefault` 按钮获得双线环并响应 Return；**同一可视区域内只允许一个**。
- 对话框按钮行（`ClassicyFormButtonRow`，HIG 顺序）：右下对齐，**默认按钮在最右**，取消紧邻其左；help 角色（如有）在最左。参考 `New Folder` 对话框。
- 表单主操作禁用态：校验不通过时 `disabled` 主按钮（保留可见，不隐藏）。
- **两套语义不得混用**：按钮带（§3.2）是左对齐命令组；对话框按钮行是右对齐确认组。
- 按钮文案规则见 §8（动词开头；会弹对话框的命令加 `…`）。

### 3.4 表单与对话框

**模态对话框标准结构**（新建文件夹/重命名/设置统一模式）：

```tsx
<ClassicyWindow id={`${prefix}-dialog`} appId={appId} title="New Folder" modal
                initialSize={[360, 0]} zoomable={false} resizable={false}>
  <ClassicyForm layout="dialog" onSubmitFunc={handleSubmit}>
    <ClassicyInput id={`${prefix}-name`} labelTitle="Name" labelPosition="left"
                   placeholder="Folder name" prefillValue={initial}
                   onChangeFunc={(e) => setName(e.target.value)}
                   onEnterFunc={handleSubmit} />
    <ClassicyFormButtonRow>
      <ClassicyButton onClickFunc={closeDialog}>Cancel</ClassicyButton>
      <ClassicyButton isDefault buttonType="submit" disabled={!name.trim()}>Create</ClassicyButton>
    </ClassicyFormButtonRow>
  </ClassicyForm>
</ClassicyWindow>
```

规则：

1. 标签 + 输入框一行（`labelPosition="left"`），标签英文 Title Case。
2. 重命名/新建类对话框打开时输入框**预填并全选**既有名称（`prefillValue` + select），参考 Todo 行内编辑。
3. **Enter 提交、Escape 取消**（`onEnterFunc` + 取消按钮；对话框默认行为已含 Escape）。
4. 输入为空/非法时主按钮 `disabled`；提交后校验失败用 alert 说明原因，不清空用户已填内容。
5. 破坏性动作（删除、覆盖、丢弃改动）**必须** `ClassicyAlert alertType="caution"` 确认，且**默认按钮为安全项（Cancel）`defaultButtonId` 指到 cancel**（有数据丢失风险时 HIG 要求默认安全）；按钮文案用具体动词（`Delete`、`Overwrite`、`Discard`），不用 `OK`。

```tsx
<ClassicyAlert alertType="caution" label={`Delete "${name}"?`}
               message="This cannot be undone."
               buttons={[
                 { id: "cancel", label: "Cancel", role: "cancel", onClick: close },
                 { id: "delete", label: "Delete", role: "default", onClick: doDelete },
               ]}
               defaultButtonId="cancel" />
```

### 3.5 行内表单（Inline Form Row）

参考 Todo 的 "New to-do… + Add"：输入框与主操作按钮同一行，按钮贴输入框右侧，Enter 等价于点按钮，空输入时按钮 disabled。适用于「快速添加一条」的场景，替代打开对话框。

---

## 4. 布局规范

### 4.1 窗口三段式骨架

```
toolbar band（窗口操作按钮带：内容区首部浅色容器带，push 文字按钮，§3.2，可选）
   ↓
content（ControlGroup 分区 / SplitView 主从 / Table，flex: 1 可滚动）
   ↓
status bar（左：上下文状态；右：全局信息）
```

- 主内容窗口设 `scrollable`（默认 true）+ flex column 布局；长内容不撑破窗口。
- 内容区间隔：组间 `var(--hig-group-gap)`（16px），组内元素间 `var(--hig-item-gap)`（4px）；统一用 CSS 变量，不写死 px。
- `ClassicyControlGroup variant="primary"`（2px 蚀刻边框）用于主要数据分区（监控面板、任务区）；`variant="secondary"` 用于次要分组；label 为分区标题（可含计数，如 `Containers (3)`）。

### 4.2 SplitView 主从布局

- 「列表 + 详情」一律 `ClassicySplitView direction="horizontal"`，`defaultSizes` 如 `[26, 74]`，`minPaneSize` ≥ 180（Finder 文件树/Blue Pencil 笔记列表模式）。
- 「输入 + 输出」上下分栏用 `direction="vertical"`（Blue Pencil：上输入、下校对结果，各自独立滚动）。
- 分栏比例可被用户调整即持久化由 classicy 处理；代码里只给合理默认。

### 4.3 空状态 / 加载态 / 错误态（每个数据视图必须三态齐全）

| 状态 | 呈现 | 文案示例 |
|---|---|---|
| 空 | 内容区居中灰色说明文字（不堆插画） | `No containers.` / `No notes yet.` |
| 加载中 | `ClassicyProgressBar indeterminate`（或区域顶部 chasing arrows）+ 文字 `Loading…` | — |
| 错误 | **保留上次正常数据**，状态栏红字显示原因 + `Reload`/`Retry` 按钮；首次加载失败才整区错误态 | `Failed to load metrics.` |
| 未启用/未配置 | 灰色说明 + 原因（服务端未开启该功能） | `Chat is disabled.` |

---

## 5. 列表、表格与树

### 5.1 选中态

- 单选：系统高亮蓝；**列表/表格视图中高亮名称标签而非整行白字**（项目 `styles.css` 已有 OS8 风格修正，保持）。
- 图标视图：选中图标其下方名称加高亮底（参考 Workspace 的 `untitled folder`）。
- 多选（`ClassicyTable selectionMode="multi"`）：Ctrl/⌘ 点选、Shift 连选的标准行为由组件提供，不自定义。

### 5.2 行内操作

- **行级操作按钮只在选中行出现、置于行末右对齐**（Todo 的 `Remove`、会话列表的行内删除），通过列 `render` 注入；点击必须 `stopPropagation` 防触发行选中。
- 每行的破坏性操作（删除）走 caution alert 确认，与菜单/右键菜单中的同名命令**行为一致**。

### 5.3 行内编辑

- 双击（或选中后 Enter）将行标签切换为 `ClassicyInput`：Enter 提交、Escape 取消、失焦提交；提交中禁用重复提交。
- 参考实现：Todo 应用对选中任务就地出输入框。

### 5.4 表格与树

- 列定义 `useMemo<ClassicyTableColumn<T>[]>`；可排序列 `sortable`；数值列右对齐、时间列用 `format.ts` 统一格式化。
- 树形行内联展开用 `rowCanExpand`/`getSubRows`/`onToggleRow` + 首列自绘 `ClassicyTriangle`（Finder 现成模式）。
- 双击行/Enter = 激活（`onActivateRow`：打开容器、用编辑器打开文件、切换会话等），与双击桌面图标的语义一致。
- 目录树懒加载：展开时才取数，加载中用占位节点表达。

---

## 6. 反馈与状态规范

### 6.1 状态栏（强约束）

窗口底部状态栏分双区（参考 Blue Pencil / World Clock）：

- **左区（上下文）**：当前对象与操作结果——`Ready`、`1 city`、`8 items`、错误信息（红字 `var(--color-error)`）、上传/构建进行中的简述。
- **右区（全局）**：与当前选择无关的全局信息——本地时间（`Here: Shanghai · 16:12 · GMT+8` 格式）、模型标识（`glm-5.2 (max)` 徽章）、连接状态。
- 简单左置状态可直接用 `ClassicyWindow placard`；需要双区用自绘状态栏（FinderApp `sp-fm-status` 为参考实现，统一 `sp-` 前缀）。

### 6.2 进度

- 已知进度：`ClassicyProgressBar value/max` + 百分比文字；可取消的长任务提供取消按钮（Finder 上传：进度条 + ✕）。
- 未知进度：`indeterminate`（采集、连接等待）。
- 资源阈值语义（CPU/内存/磁盘/温度）用 `ClassicyMeter` 的 `low/high/optimum`，**不用**进度条；阈值配色集中在 `src/format.ts`（`levelColor`/`tempColor`），禁止各视图散落硬编码色值。

### 6.3 数据轮询（监控类应用）

- 一律用 `src/hooks/usePolling.ts`（`cancelled` 防竞态、返回 `{ data, error, reload }`）。
- 状态栏显示**上次更新时间**；用户可控：`Refresh Now` + `Pause/Resume`（MonitorApp 模式）或按场景固定间隔（Docker 5s、Printer 5s、Runner 运行中 2s/空闲 10s）。
- 轮询失败：保留上次数据 + 状态栏红字；**不**弹 alert（轮询是常态行为，弹窗即骚扰）。
- 所有 API 经 `src/api.ts` 的 `request<T>`：401 → 抛 `Unauthorized` → 应用层 `onLogout()` 回登录页；**不得**自建 fetch 绕过。

### 6.4 反馈优先级

`状态栏文字 < 区域错误态 < ClassicyAlert（需用户决策才弹）`。默认用最低足够级别；alert 只用于需要用户决策或必须知晓的事件。

---

## 7. 视觉规范

### 7.1 色彩

- **一切 chrome 颜色（窗口底、控件面、边框、文字、高亮）必须取自 classicy 主题 CSS 变量**：`var(--color-system-01..07)`、`var(--color-highlight)`、`var(--color-select)`、`var(--color-window-*)`、`var(--color-theme-*)` 等。**禁止**在组件里写死 hex（语义状态色除外，见下）。
- 语义状态色（正常/警告/危险）允许固定值，但必须集中在 `src/format.ts` 或 `src/styles.css` 的 `sp-` 变量中定义后引用。
- 21 套主题（Bondi/Sapphire/Lavender…）下所有应用必须自动跟随，不得出现主题切换后不改色的自绘元素。
- 非 Desktop 环境（LoginApp）手动补齐 Platinum 变量已有先例（`styles.css`），新增同类页面照做。

### 7.2 字体排版

| 用途 | 变量/字号 |
|---|---|
| UI 正文 | `var(--ui-font)`，默认 12px |
| 窗口标题 | `var(--header-font)`（classicy 标题栏自动） |
| 等宽（日志、ID、技术值） | `var(--mono-font)`（Runner 日志区、终端） |
| 数值/时间强调 | 系统字号加大一档（World Clock 的时间列模式） |
| 像素字体 Silkscreen | **仅登录页**：品牌名 24px/700、窗口标题 16px/700、副标题 12px/400 |

- 不引入**在线** Web 字体（不得依赖 CDN 或外部网络请求）；确需特殊字体时把 woff2 入库到 `src/assets/fonts/`（随附许可证），并用 `sp-` 选择器限定使用范围。
- 像素字体（Silkscreen，OFL 1.1）字号必须取 **8 的倍数**——非整数倍会让字形落在半像素上被插值糊掉；同时**不加 `text-shadow`**（投影落在像素格之间，会毁掉方块边）。
- 不改变全局字号；密集中文技术值的等宽场景用 `--mono-font`。
- 文本一律英文（UI 文案规范见 AGENTS.md）；代码注释中文。

### 7.3 间距与尺寸

- 间距变量：`var(--window-padding-size)`（窗口内边距）、`var(--hig-item-gap)`（4px 元素间距）、`var(--hig-group-gap)`（16px 组间距）。
- HIG 度量：按钮高 `var(--hig-button-height)`（20px）、最小宽 `var(--hig-button-min-width)`（58px）、标题栏 `var(--hig-titlebar-height)`（19px）。自绘控件必须复用这些变量。
- 自定义样式一律 `sp-` 前缀写入 `src/styles.css`（现有 490 行模式），**禁止**在组件里散写内联样式做布局。

### 7.4 图标

- 统一 `ClassicyIcons` 命名空间（`system.*` / `applications.*` / `controlPanels.*`）；工具栏图标 16px 档，桌面/标题栏 32px 档。
- 按钮带 push 文字按钮的前置小图标（§3.2.2 规则 8b）：16×16、1:1 渲染、双色（深蓝 `#1b3d72` 描边 + 蓝 `#4a86d8` 面，按下/禁用态由 CSS filter 补）；自绘，制作流程见 [icon-pipeline.md](./icon-pipeline.md) §1.2。
- 新应用无专用图标时选语义最接近的内置图标，并在 `src/Desktop.tsx` 登记；不用 emoji 代替。
- 自绘图标放 `src/assets/icons/*.svg`，`viewBox="0 0 32 32"`（桌面与标题栏同档，矢量可任意缩放）；仅在本项目语义强于内置图标时自绘（如 `terminal.svg` / `chat.svg`），其余沿用内置。
- 自绘 SVG 约定：**不用 `<text>`/`<font>`**（各平台字体不一致，图标会走形），字符一律用 `<path>` 画；`id`（渐变等）加模块前缀防冲突；靠浮雕高光与暗边做 Mac OS 9 的 3D 感，不加投影；加 `shape-rendering="crispEdges"` 防止相邻像素插值出灰缝；文件控制在 4 KB 内。
- ⚠️ classicy 把应用注册信息持久化在 localStorage，其注册 reducer（`lq`）**对已存在条目不更新 `name`/`icon`**，换图标后老用户需清 `localStorage.classicyDesktopState` 才能看到新图标。
- ⚠️ **自绘图标的 `import` 必须带 `?no-inline`**（`import x from './x.svg?no-inline'`）。Vite 的 `svgToDataURL` 在非 base64 分支会把 SVG 双引号替换为单引号，产出含 `'` 的 data URI；CSS 无引号 `url()` 不允许该字符，整条声明非法 → classicy 注入的 `--classicy-icon-mask` 被 CSSOM 丢弃 → 桌面遮罩失效、黑底与斜纹直接透出。**`?url` 不够**，它不绕过 `assetsInlineLimit`。完整流程与踩坑记录见 [icon-pipeline.md](./icon-pipeline.md)。

---

## 8. 文案规范

- 界面文案一律**英文 Title Case**；动词开头；执行类不加标点（`Save`、`Refresh`、`Build`）。
- 会弹出对话框的命令以 `…` 结尾（`New Folder…`、`Settings…`、`Get Info…`）；破坏性命令同样加 `…` 且执行前 alert 确认（`Delete…`）。
- 状态与计数用名词短语：`8 items, 21.0 GB available`、`1 city`、`Ready`、`Waiting`。
- 错误文案 = 发生了什么 + 用户能做什么：`Failed to load metrics. Retry.`；禁止裸 `Error`/`500`。
- 空状态用一句陈述：`No containers.`。

---

## 9. 键盘与快捷键

- 全局约定：`Return` = 默认按钮 / 激活选中项；`Escape` = 取消对话框 / 关闭浮层；`⌘.` = 取消（alert 已支持）；`Mod+S` = 保存（有保存语义的应用）。
- 快捷键仅在菜单项声明；展示用 `ClassicyKbd`；字形风格 `⌘S ⇧⌘Z ⌥H`，**禁止** `Cmd+S` 写法。
- 浏览器已占用组合不绑定；终端/编辑器内自行拦截的项标 `nativeShortcut: true`。
- 每个含重要快捷键的应用经 `useClassicyHelpMenu` 提供快捷键说明窗口（TerminalApp 为样板）。

---

## 10. 数据交互规范

- 所有后端调用经 `src/api.ts`；相对路径 `./api/*`（兼容 basePath 子路径部署）。
- 401 → `Unauthorized` → 应用 `handleLogout`；禁止把后端 401 当普通错误弹 alert（chat 上游 401 映射 502 的先例：watchdog 自身 401 才是登出信号）。
- 流式（SSE）用 `streamChat` 模式：逐 chunk 回调 + 完成态 + 错误态齐全；工具调用/思考过程用可折叠 `<details>` 呈现，不刷屏。
- 上传：XHR 出进度条 + 可取消；409 覆盖用 caution alert 确认。
- 用户偏好（终端字体、编辑器主题等）存 localStorage，键名 `srv-` 前缀，读取时做类型校验回退。

---

## 11. 新应用创建清单（AI 必须逐项过）

设计或改造一个应用时，按序确认：

- [ ] 在 `src/Desktop.tsx` 登记；`APP_ID` 以 `.app` 结尾；图标取自 `ClassicyIcons`（语义强时可自绘 SVG，见 §7.4）
- [ ] `useClassicyAboutMenu` → `aboutMenuItem` 进应用名菜单 + 渲染 `aboutWindow`
- [ ] `appMenu` 四段式（应用名/File/Edit/View/特有），`useMemo` 记忆化，id 规范 `<前缀>-m-<命令>`，英文文案，`…`/`checked`/`disabled` 规则
- [ ] 有标准文本输入 → `useClassicyEditMenu(idPrefix)`；帮助项 → `useClassicyHelpMenu`
- [ ] 主窗口 `initialSize` 合理 + `minimumSize`；窗口 id 稳定且不含用户内容；多实例 id 派生
- [ ] 窗口结构 = 工具栏带（内容区首部浅色容器带，§3.2，可选）/ 内容 / 状态栏三段式；数据分区用 `ClassicyControlGroup`；主从用 `ClassicySplitView`
- [ ] 若用窗口操作按钮带：逐项过 §3.2.4 检查清单（浅色容器带 + 分隔线、白色按钮面、HIG 间距、禁用态正宗化）
- [ ] 数据视图三态齐全（空/加载/错误保留旧数据）；错误进状态栏不进 alert
- [ ] 表格列定义 `useMemo`；单选高亮名称标签；行内操作仅选中行出现且 `stopPropagation`；双击/Enter 激活
- [ ] 对话框 = `modal` + `ClassicyForm layout="dialog"` + `FormButtonRow`；唯一 `isDefault` 在最右；Enter/Escape 生效
- [ ] 破坏性操作 = caution alert + 具体动词按钮 + `defaultButtonId` 指 cancel
- [ ] 颜色全部走 CSS 变量；语义色集中 `format.ts`；间距用 HIG 变量；自绘样式 `sp-` 前缀
- [ ] 数据经 `api.ts` + `usePolling`；401 登出；上次更新时间进状态栏
- [ ] 未保存改动用 `onBeforeClose` veto；偏好 localStorage `srv-` 前缀
- [ ] `npm run build` 通过；按 AGENTS.md「验证」节执行相关冒烟测试

---

## 12. 反模式（禁止事项）

| 禁止 | 原因 / 替代 |
|---|---|
| 裸 HTML `<button>/<input>/<select>/<table>` | 用对应 `Classicy*` 组件 |
| 窗口操作按钮裸露在内容流第一行 / 用 icon 按钮 / 带底色工具栏容器 | §3.2 范本：内容区首部浅色容器带、push 文字按钮、白色按钮面 |
| 自绘弹窗、`window.confirm/alert` | `ClassicyWindow modal` / `ClassicyAlert` |
| 组件内写死颜色/字号/间距 | 主题 CSS 变量 + HIG 变量 |
| 同一区域多个默认按钮 / 无默认按钮 | 每可视区域恰好一个 `isDefault` |
| 轮询失败弹 alert | 状态栏红字 + 保留旧数据 |
| 按状态隐藏菜单项/按钮 | `disabled` 保留可见 |
| 手动拼 `✓ ` 前缀 / `Cmd+S` 写法 | `checked` / `⌘S` |
| 中文界面文案 | UI 英文 Title Case，注释中文 |
| 窗口 id 含文件名等用户内容 | 实例派生 id + `analyticsPath` |
| 多实例共享窗口 id | 派生 id（store 条目互踩） |
| 主窗口初始尺寸接近全屏且无 `minimumSize` | 45–75% 视口 + minimumSize |
| 只 `dispatch ClassicyWindowFocus` 开窗 | Open + Focus 双发 |
| 在 appMenu 自建 Help / System(Sign Out) 菜单 | `useClassicyHelpMenu` / Desktop 统一注入 |
| 终端 shell 命令等后端配置由客户端传入 | 服务端配置唯一来源（AGENTS.md 安全约定） |

---

## 附录 A：参考图设计要点拆解

| 参考图 | 学到的规则 |
|---|---|
| `1.png` Paint | 工具栏分组（工具图标列 / 撤销类 / 文件类 push 按钮）；工具选中态凹陷；画布 inset 边框 + 右下缩角；主操作按钮（Export）双线环；色板选中指示 |
| `2.png` Notes | 小号圆形图标按钮 + push 按钮混排工具栏；默认按钮（Delete）双线环；底部状态行：日期、页码、色点、缩放；窗口左下经典折角 |
| `3.png` Mac OS 9 安装助手 | 模态对话框：顶部按钮行（默认在左但视觉最重，本项目按 HIG 统一默认在右）、米黄信息横幅、编号步骤列表（粗体标题 + 灰色状态 Waiting）、底部单确认按钮 |
| `160950` Todo | 行内表单（输入 + Add 贴右）；复选框行首；选中行才显示 Remove（行末右对齐）；就地输入框行内编辑；空列表留白 |
| `161049` New Folder | 紧凑模态对话框：标签 + 输入 + Cancel/Create（Create 默认在最右）；父窗变暗；列表窗口信息行 "0 items, 21.0 GB available"；窗口右下缩角 + 横向滚动条 |
| `161118` Workspace | 图标视图：大图标 + 下方名称，选中名称高亮；同应用多窗口并存、各自标题栏 |
| `161140/161156` Blue Pencil | SplitView 主从（左笔记列表单选高亮 / 右输入 + 输出上下两栏独立滚动）；底部按钮行 New（左下）/ Clear / Copy / Accept（右下默认）；状态栏左 Ready、错误红字，右模型徽章 |
| `161252` World Clock + About | 顶部过滤输入；列表行：图标 + 粗体名称 + 大号右对齐时间 + 行末 ✕；状态栏 "1 city" + "Here: Shanghai · 16:12 · GMT+8"；About 窗：居中图标名称、标签左值右的情报行、蓝色下划线链接、磁盘进度条 |

---

*本规范随 classicy 升级与项目演进而维护；新增通用模式应先补入本规范再实现，实现与规范冲突时以规范为准并修正实现。*
