---
name: file-manager-and-editor
overview: 为 srv-dashboard 新增两个桌面应用：文件管理器（FileApp，收藏夹+目录树+文件列表+上传+预览）与文本编辑器（EditorApp，CodeMirror 6 高亮编辑/保存/撤销重做/字体设置/多主题），并在 server.js 新增零依赖文件系统 API。
design:
  architecture:
    framework: react
  styleKeywords:
    - 复古 Mac OS 9
    - Platinum 质感
    - 紧凑信息密度
  fontSystem:
    fontFamily: Chicago / Geneva（classicy 内置）
    heading:
      size: 13px
      weight: 700
    subheading:
      size: 12px
      weight: 600
    body:
      size: 12px
      weight: 400
  colorSystem:
    primary:
      - "#1B1E8F"
      - "#FFFFFF"
    background:
      - "#D4D0C8"
      - "#ECE9E2"
    text:
      - "#000000"
      - "#FFFFFF"
    functional:
      - "#2F7D32"
      - "#C62828"
      - "#B8860B"
todos:
  - id: backend-fs-api
    content: 用 [subagent:code-explorer] 确认 serveFile/route 精确代码后，在 server.js 新增零依赖 /api/fs/* 路由（list/read/raw/write/upload/mkdir/delete/rename/favorites），含 checkAuth、路径穿越防护、大小限制与 favorites.json 原子持久化
    status: completed
  - id: frontend-api-fs
    content: 在 src/api.ts 新增 FsEntry 类型与 fs 接口封装函数（相对路径 './api/fs/...'，401 抛 Unauthorized）
    status: completed
    dependencies:
      - backend-fs-api
  - id: code-editor-component
    content: 创建 src/components/CodeEditor.tsx：CodeMirror 6 封装（后缀映射语言包、社区主题切换、字号字体、撤销重做、只读模式）
    status: completed
    dependencies:
      - frontend-api-fs
  - id: file-manager-app
    content: 创建 src/apps/FileManagerApp.tsx：SplitView 左收藏夹+目录树、右 ClassicyTable 文件列表，工具栏上传/新建/刷新，右键菜单，图片/文本/Markdown 预览窗口，401 处理
    status: completed
    dependencies:
      - code-editor-component
  - id: editor-app
    content: 创建 src/apps/EditorApp.tsx：打开文件、保存/撤销/重做、未保存提醒、Markdown 预览、主题/字号/字体设置并持久化 localStorage
    status: completed
    dependencies:
      - code-editor-component
  - id: register-and-verify
    content: 在 src/Desktop.tsx 注册两个应用；用 [skill:verification-before-completion] 运行 npm run build 与本地 node server.js 联调验证文件列表、上传、保存、收藏全链路
    status: completed
    dependencies:
      - file-manager-app
      - editor-app
---

## 需求概述

为 srv-dashboard（Classicy 复古桌面）新增两个桌面应用：

## 产品概述

### 应用一：文件管理器（FileManagerApp）
- 启动默认打开根节点（`/`），支持浏览服务器文件系统
- 左侧：收藏夹 + 目录树导航，支持将目录添加/移除收藏（收藏持久化到服务端，跨浏览器生效）
- 右侧：当前目录文件列表（ClassicyTable），展示名称、类型、大小、修改时间、权限等属性，双击进入目录或打开文件
- 支持上传文件（多选、进度提示）、新建文件夹、删除、重命名、下载
- 预览：图片（img 直显）、文本/代码（内嵌编辑器）、Markdown（渲染预览），其余类型提示不可预览并可下载

### 应用二：文本编辑器（EditorApp）
- 打开服务器上的文件（输入路径或从文件管理器联动打开）
- 根据文件后缀自动语法高亮（代码文件 + 必须 Markdown）
- 编辑、保存、撤销、重做等基本操作
- 可设置字体大小、选择字体（偏好持久化到 localStorage）
- 使用开源社区主题与高亮方案

### 体验补充（由助手补充）
- 未保存更改提醒（关闭窗口/切换文件时确认）
- 大文件保护（超限文本文件只读提示）、二进制文件检测
- 上传/保存失败的重试与错误提示（ClassicyAlert）


## 技术栈
- 前端：React 19 + TypeScript + Vite（现有），UI 沿用 classicy ^0.79.0（ClassicySplitView / ClassicyTree / ClassicyTable / ClassicyContextualMenu / ClassicyButton(Toolbar) / ClassicyComboBox / ClassicyAlert / ClassicyIcons）
- 编辑器：**CodeMirror 6**（`@codemirror/state|view|commands|search` + `@codemirror/lang-markdown|javascript|python|json|html|css|xml|sql` + `@lezer/highlight`），主题用社区方案 `@uiw/codemirror-theme-*`（如 dracula / github-dark / vscode-dark），多个主题可切换
- Markdown 预览：`marked` + `dompurify`（净化防 XSS）
- 后端：`server.js` 保持 CommonJS 单文件零依赖，仅用 Node 内置模块（fs/promises、path、stream）

## 实现方案

### 后端新增 `/api/fs/*` 路由（全部走 checkAuth，BASE 前缀兼容）
| 路由 | 说明 |
|---|---|
| `GET /api/fs/list?path=` | 列目录（含 stat 属性：类型/大小/mtime/权限） |
| `GET /api/fs/read?path=` | 读文本（限 2MB，超限/二进制返回标记） |
| `GET /api/fs/raw?path=` | 图片/下载原始流（Cookie 鉴权天然支持 `<img src>` 与下载） |
| `PUT /api/fs/write?path=` | 保存文本 |
| `POST /api/fs/upload?path=&name=` | **raw body 上传**（避免零依赖手写 multipart 解析），限 50MB |
| `POST /api/fs/mkdir`、`POST /api/fs/delete`、`POST /api/fs/rename` | 目录/文件操作 |
| `GET /api/fs/favorites` / `PUT /api/fs/favorites` | 收藏夹持久化（`data/favorites.json`，启动时惰性创建） |

安全要点：所有 path 经 `path.resolve` 后校验在允许根内（复用 serveFile 600-607 的穿越防护范式）；软链 realpath 校验；文本读取做二进制嗅探（NUL 字节检测）；上传流式写盘限流。

### 前端
- `src/components/CodeEditor.tsx`：CodeMirror 6 封装（受控 value、扩展动态加载、主题/字号/字体 props），文件管理器与编辑器共用
- `FileManagerApp`：ClassicySplitView 左（收藏夹+ClassicyTree）右（ClassicyTable + 工具栏 + 右键菜单）；预览用 ClassicyWindow 内嵌 CodeEditor/`<img>`/Markdown 渲染
- `EditorApp`：工具栏（保存/撤销/重做/主题/字号/字体/预览切换）+ CodeEditor；401 统一走 `onLogout`（沿用 MonitorApp 范式）；未保存提示

## 架构与数据流

```mermaid
graph LR
  A[FileManagerApp] -->|./api/fs/*| S[server.js 零依赖路由]
  B[EditorApp] -->|read/write/raw| S
  C[CodeEditor 共享组件] --> A
  C --> B
  S -->|favorites.json| D[(data/)]
  S -->|fs/promises| E[(服务器文件系统)]
```

## 关键代码结构

```ts
// 目录条目（list 返回，前后端契约）
interface FsEntry {
  name: string; path: string;
  type: 'file' | 'dir';
  size: number; mtime: number;
  mode: string;            // 如 rwxr-xr-x
  previewable: 'image' | 'text' | 'markdown' | 'none';
}

// CodeEditor 共享组件 props
interface CodeEditorProps {
  path: string;            // 决定语言高亮
  value: string;
  onChange: (v: string) => void;
  theme: string;           // dracula / github-dark / ...
  fontSize: number; fontFamily: string;
  readOnly?: boolean;
}
```

## 实施注意
- vite `publicDir:false`、`base:'./'` 保持不变；API 用相对路径 `./api/fs/...`
- CodeMirror 语言包按需动态 import，避免主包膨胀；主题静态引入数量控制在 3-4 个
- 上传用 fetch + ReadableStream/`body: File`，配合 ClassicyProgressBar 展示进度
- 收藏夹写入用原子写（临时文件 + rename），防止写坏


## 设计风格
完全遵循项目现有的 Classicy 仿 Mac OS 9 复古桌面隐喻，不做现代化改造：窗口带条纹标题栏与阴影、Bevel 按钮像素质感、Platinum 灰色控件。两个新 App 与 Monitor/Terminal 等现有窗口观感一致。

## 文件管理器窗口（初始约 900x640，可缩放）
1. **顶部工具栏块**：ClassicyButtonToolbar——后退/上级、新建文件夹、上传、刷新；右侧路径输入框（可直接跳转）
2. **左侧栏块（ClassicySplitView 左栏）**：收藏夹分区（星标目录，点击直达）+ 目录树（ClassicyTree，懒加载展开），右键收藏/取消收藏
3. **右侧文件列表块（ClassicyTable）**：列 = 名称(带 ClassicyIcons 文件类型图标)/类型/大小/修改时间/权限；双击目录进入、文件打开预览；支持多选删除
4. **预览块**：双击文件弹出预览窗口——图片等比缩放居中；文本/代码内嵌 CodeEditor（只读）；Markdown 渲染预览；底部提供"编辑"与"下载"按钮
5. **右键菜单块**：ClassicyContextualMenu——打开/编辑/下载/重命名/删除/收藏此目录

## 文本编辑器窗口（初始约 860x600）
1. **顶部工具栏块**：保存、撤销、重做、Markdown 预览开关；状态区显示路径与未保存标记（标题栏加 •）
2. **编辑区块**：CodeMirror 6 全高填充，等宽字体，行号 + 括号匹配 + 搜索
3. **设置块（ClassicyPopUpMenu）**：主题切换（Dracula/GitHub Dark/VSCode Dark）、字号（10-24px）、字体下拉（等宽系列）
4. **底部状态栏块**：文件大小、光标行列、保存时间

## Agent Extensions
### SubAgent
- **code-explorer**
  - Purpose：实现前确认 classicy 0.79 中 ClassicyTree/ClassicyTable/ClassicyContextualMenu/ClassicySplitView 的确切 props API，以及 server.js route()/serveFile 精确插入点
  - Expected outcome：拿到组件真实签名，避免按想象写代码导致返工
### Skill
- **frontend-design**
  - Purpose：在 classicy 复古风格约束下打磨两个新 App 的界面细节（布局密度、交互反馈）
  - Expected outcome：两窗口 UI 与现有桌面风格统一且体验精致
- **verification-before-completion**
  - Purpose：完成前运行 `npm run build` 与本地 `node server.js` 联调验证文件 API
  - Expected outcome：构建零错误、list/read/write/upload/favorites 接口实测通过
