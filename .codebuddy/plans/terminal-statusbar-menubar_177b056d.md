---
name: terminal-statusbar-menubar
overview: 将 Terminal 窗口内的工具栏（Reconnect 按钮 + 连接状态文本）拆分：状态信息移至窗口底部状态栏，操作（Reconnect）合并到桌面顶部菜单栏的 Terminal 应用菜单中。
todos:
  - id: terminal-statusbar-menu
    content: 修改 TerminalApp.tsx：删除顶部工具栏，新增底部状态栏，appMenu 增加 Terminal > Reconnect 菜单项
    status: completed
  - id: statusbar-css
    content: 在 src/styles.css 新增 .sp-term-statusbar 样式并清理未使用的 .sp-term-status
    status: completed
    dependencies:
      - terminal-statusbar-menu
  - id: verify-build
    content: 运行 npm run build 验证无 TS/构建错误，并按 AGENTS.md 用 mock ttyd 联调验证状态栏与菜单功能
    status: completed
    dependencies:
      - statusbar-css
---

## 需求概述

对 Terminal 应用窗口做布局与菜单调整：

## 用户需求

- **状态信息移至窗口底部（状态栏）**：将当前位于窗口顶部工具栏中的连接状态文本（连接中… / 已连接 / 未连接 + 错误信息）移到终端窗口底部的状态栏展示。
- **操作菜单合并到桌面顶部菜单**：移除窗口内的顶部工具栏（Reconnect 按钮所在的 `sp-web-toolbar`），将 Reconnect 操作合并到 Terminal 窗口聚焦时显示在桌面顶部菜单栏的应用菜单（`ClassicyWindow` 的 `appMenu`，Mac OS 9 隐喻）中。

## Core Features

- 终端窗口底部新增状态栏，实时显示连接状态（连接中 / 已连接 / 未连接及错误原因），状态异常时保留红色脉冲提示样式
- 移除窗口内顶部工具栏，终端区域占满窗口剩余空间
- Reconnect 操作进入桌面顶部菜单栏的 Terminal 菜单（窗口聚焦时可见），保留原 System > Sign Out 菜单项
- 终端功能未启用（disabled）时的提示界面保持不变

## 技术方案

### 技术栈

- 复用现有栈：React 19 + TypeScript + `classicy` 组件库（仿 Mac OS 9 桌面风格），无新增依赖。

### 实现思路

1. **状态栏**：`ClassicyWindow` 无内置状态栏 prop，采用窗口内容 flex 布局实现——`sp-term-wrap` 已是 `flex-direction: column`，在 `sp-term` 容器之后追加一个 `flex: 0 0 auto` 的底部状态栏 div，展示 `status`/`error` 文本；复用现有 `.sp-dim`（灰色正常态）与 `.sp-pulse`（红色异常态）样式类。
2. **顶部菜单合并**：`appMenu`（`ClassicyMenuItem[]`）在窗口聚焦时渲染于桌面顶部菜单栏。将其调整为两个菜单：新增 `Terminal` 菜单（含 `Reconnect` 项，`onClickFunc: reconnect`），保留 `System > Sign Out` 项。注意 `reconnect` 需在 `appMenu` 的 `useMemo` 之前定义（当前定义在后面），并加入依赖数组。
3. **清理**：删除工具栏 JSX 与不再使用的 `ClassicyButtonToolbar` / `ClassicyButtonToolbarGroup` / `ClassicyButton` 导入。
4. **CSS**：`src/styles.css` 新增 `.sp-term-statusbar`（flex 行布局、上边框、小字号）；`.sp-term-status`（line 174）当前未使用，可删除或并入状态栏样式。

### 实现注意事项

- 状态栏仅在终端功能启用分支渲染；disabled 分支提示界面不动。
- `reconnect` 是 `useCallback(() => setAttempt(a => a + 1), [])`，引用稳定，菜单项点击触发 `attempt` 递增即可重连，无需改连接逻辑。
- 错误信息可能较长，状态栏文本做 `text-overflow: ellipsis` 单行截断，避免撑高窗口。
- 爆炸半径控制：仅改动 `TerminalApp.tsx` 与 `styles.css`，不动其他 App 与后端。

### 涉及文件

```
src/
├── apps/TerminalApp.tsx   # [MODIFY] 删除工具栏、新增底部状态栏、调整 appMenu（新增 Terminal > Reconnect）
└── styles.css             # [MODIFY] 新增 .sp-term-statusbar 样式，清理未用的 .sp-term-status
```