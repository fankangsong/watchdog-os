# Office 文档预览（DOCX / XLSX）前后端技术方案

> 适用场景：Web 编辑器 / IDE 中内嵌预览 Word（.docx）与 Excel（.xlsx）文档。
> 本文档基于 `app/api/files/[...path]/route.ts`、`components/FileViewer.tsx`、`lib/file-types.ts` 的现状撰写。
>
> **状态说明**：
>
> - **DOCX**：已实现（前端 + 后端）。
> - **XLSX**：当前项目**未实现**，下方 XLSX 章节为基于现有架构给出的**推荐设计方案**，落地时按需实现。

---

## 1. 总体方案

Office 文档（docx / xlsx）无法被浏览器原生渲染，必须**由后端转换为 HTML**，再塞进一个 `<iframe>` 中展示。核心链路：

```
前端 <iframe sandbox>  ──GET──▶  /api/files/<path>?type=preview
                                       │
                                       ▼
                              后端读取原文件
                                       │
                          ┌────────────┴─────────────┐
                          │ docx → mammoth.convertToHtml │   （已实现）
                          │ xlsx → SheetJS sheet_to_html  │   （待实现）
                          └────────────┬─────────────┘
                                       ▼
                          包装为完整 HTML 页面 + CSP 头
                                       │
                                       ▼
                              返回 text/html 给 iframe
```

- 预览与下载分离：`type=read` 用于 PDF（浏览器原生）/ 二进制下载；`type=preview` 专用于文档转 HTML。
- 统一 iframe 渲染，前端 `DocumentViewer` 对 PDF 不沙箱、对转换出的 HTML 加 `sandbox=""` 隔离。

---

## 2. DOCX 前端方案（已实现）

位置：`components/FileViewer.tsx` 第 664–784 行（`DocumentViewer`）、第 786–797 行（分派）。

### 2.1 分派条件

```ts
const ext = getFileExt(filePath);          // file-types.ts: getFileExt
const isPdf = ext === "pdf";
const previewUrl = isPdf
  ? getFileApiUrl(filePath, "read", ...)        // PDF 走 read，浏览器原生渲染
  : getFileApiUrl(filePath, "preview", ...);    // docx 走 preview，后端转 HTML
```

`isDocumentPreviewPath()`（`file-types.ts:71`）通过 `documentPreviewKind()` 返回 `"pdf" | "docx"` 决定进入 `DocumentViewer`。

### 2.2 渲染结构

- `<iframe src={previewUrl} sandbox={isPdf ? undefined : ""}>`：
  - **PDF**：`sandbox` 不设置（PDF 阅读器需要脚本/导航）。
  - **DOCX（HTML）**：`sandbox=""` 完全隔离，禁止脚本、表单、同源访问。
- 顶栏：相对路径、扩展名标签（"docx preview" / "pdf"）、文件大小、下载按钮、live 指示灯。
- 大小保护：打开前先 `fetch(...?type=meta)` 取 `size`，若 docx 超过 `DOCX_PREVIEW_MAX_BYTES`（10MB）直接显示「DOCX too large for preview (>10MB)」，不渲染 iframe。
- live 同步：通过 `?type=watch` 的 SSE，文件变化时 `bust` 缓存（iframe `key` 变化重新加载）。

### 2.3 关键常量（`lib/file-types.ts`）

```ts
DOCX_PREVIEW_MAX_BYTES = 10 * 1024 * 1024; // 10MB
DOCUMENT_EXT_TO_MIME = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};
```

---

## 3. DOCX 后端方案（已实现）

位置：`app/api/files/[...path]/route.ts` 第 499–528 行（`type === "preview"`）。

### 3.1 接口契约

| 项       | 值                                                                              |
| -------- | ------------------------------------------------------------------------------- |
| 路径     | `GET /api/files/<encoded-path>?type=preview`                                    |
| 入参     | `path`（URL 编码绝对路径）、可选 `sessionId`（会话引用鉴权）                    |
| 前置校验 | 必须为 `.docx`（`getFileExt(filePath) !== "docx"` → 400）；大小 ≤ 10MB → 413    |
| 鉴权     | 走 `getAllowedFileRoots()` / `isFilePathReferencedBySession()` 通用文件访问规则 |
| 成功返回 | `Content-Type: text/html; charset=utf-8` + 一组安全响应头                       |
| 失败返回 | JSON `{ error }` + 对应状态码                                                   |

### 3.2 转换核心

```ts
const mammoth = await import("mammoth"); // 动态 import，避免常驻内存
const result = await mammoth.convertToHtml(
  { path: filePath },
  {
    externalFileAccess: false, // 禁止读取外部文件
    convertImage: mammoth.images.dataUri, // 图片内联为 data: URI
  },
);
const html = wrapDocxPreviewHtml(result.value, path.basename(filePath));
```

- `externalFileAccess: false`：防止 docx 内嵌入的外部链接被读取。
- `convertImage: mammoth.images.dataUri`：把文档内图片直接内联为 base64，避免 iframe 需要二次请求图片资源（与 CSP `img-src data:` 配合）。
- `result.messages` 可记录转换警告（如不支持的样式），当前实现未回传，迁移时建议记日志。

### 3.3 页面包装（`wrapDocxPreviewHtml`，第 365–412 行）

把 mammoth 产出的 body HTML 包裹成完整页面：固定白卡片样式、居中、A4 风格（max-width 840px + 阴影），左上角显示文件名，响应式（窄屏去卡片）。

### 3.4 安全响应头（关键）

```http
Content-Security-Policy: default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'
Referrer-Policy: no-referrer
X-Content-Type-Options: nosniff
Cache-Control: no-cache
```

- `default-src 'none'`：除显式允许的 `img-src data:` 与 `style-src 'unsafe-inline'` 外，一切资源/脚本都被禁。
- `style-src 'unsafe-inline'` 是必须的——因为 `wrapDocxPreviewHtml` 注入了大量内联样式。
- 配合前端 iframe 的 `sandbox=""`，形成「iframe 隔离 + CSP 收紧」双重防护。

### 3.5 依赖部署注意

`mammoth`（`^1.12.0`）当前位于 **`devDependencies`**。生产 `next build` 后若该依赖未随部署产物打包会导致运行时 `import("mammoth")` 失败。**迁移 / 上线前必须把它移入 `dependencies`**，或为 preview 接口单独打包。

---

## 4. XLSX 前端方案（设计 / 待实现）

复用 `DocumentViewer` 的现有模式，几乎零新增前端逻辑。

### 4.1 需要改动的点

1. `lib/file-types.ts`：
   - `DOCUMENT_EXT_TO_MIME` 增加 `xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"`。
   - `documentPreviewKind()` 的判定增加 `ext === "xlsx"`（或把常量表改成查表），使 `isDocumentPreviewPath()` 命中。
2. `components/FileViewer.tsx` `DocumentViewer`：
   - 顶栏标签从 `"docx preview" / "pdf"` 泛化为 `"xlsx preview" / "docx preview" / "pdf"`。
   - 其余（iframe + `sandbox=""` + meta 大小校验 + watch live）**完全复用**，无需重写。

### 4.2 预期渲染

- `<iframe src="...?type=preview" sandbox="">` 展示后端生成的 HTML 表格。
- 表格样式由后端 `wrapXlsxPreviewHtml`（建议参照 `wrapDocxPreviewHtml` 实现）统一提供。

---

## 5. XLSX 后端方案（设计 / 待实现）

在 `type === "preview"` 分支中新增 `xlsx` 处理，与 docx 平行。

### 5.1 推荐依赖

- **SheetJS（社区版 `xlsx`，npm 包名 `xlsx`）**：`XLSX.readFile` → `XLSX.utils.sheet_to_html` 一站式转 HTML 表格，零原生依赖。
  - 注意：SheetJS 官方 npm 版本偏旧，生产环境建议从官网 CDN 安装最新版，或直接用 `exceljs` 亦可。
- 也可用 `exceljs`：`workbook.xlsx.readFile` → 遍历 worksheet → 自行拼接 `<table>`。

### 5.2 推荐实现骨架

```ts
if (type === "preview") {
  if (!stat.isFile())
    return NextResponse.json({ error: "Not a file" }, { status: 400 });
  const ext = getFileExt(filePath);
  if (ext !== "docx" && ext !== "xlsx") {
    return NextResponse.json(
      { error: "Preview not available for this file type" },
      { status: 400 },
    );
  }
  if (stat.size > DOCX_PREVIEW_MAX_BYTES) {
    // 可另设 XLSX_PREVIEW_MAX_BYTES
    return NextResponse.json(
      { error: "File too large for preview (>10MB)" },
      { status: 413 },
    );
  }

  let bodyHtml: string;
  if (ext === "docx") {
    const mammoth = await import("mammoth");
    const r = await mammoth.convertToHtml(
      { path: filePath },
      { externalFileAccess: false, convertImage: mammoth.images.dataUri },
    );
    bodyHtml = r.value;
  } else {
    const XLSX = await import("xlsx");
    const wb = XLSX.readFile(filePath, { type: "file" });
    // 多 sheet 时拼接，每个 sheet 加标题
    bodyHtml = wb.SheetNames.map((name) => {
      const html = XLSX.utils.sheet_to_html(wb.Sheets[name], {
        editable: false,
      });
      return `<h3>${escapeHtml(name)}</h3>${html}`;
    }).join("<hr>");
  }

  const html = wrapXlsxPreviewHtml
    ? wrapXlsxPreviewHtml(bodyHtml, path.basename(filePath))
    : wrapDocxPreviewHtml(bodyHtml, path.basename(filePath));

  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-cache",
      // 与 docx 一致的 CSP：表格无需图片，可进一步收紧 img-src
      "Content-Security-Policy":
        "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
```

### 5.3 安全要点（XLSX 特有）

- `XLSX.readFile` 会解析单元格公式与共享字符串，**历史上存在公式注入 / XXE 类风险**。务必：
  - 只用 `sheet_to_html`（纯展示，不执行公式），不要 `XLSX.read` 时启用危险选项。
  - 保持 CSP `default-src 'none'` + `sandbox=""`，即使单元格含 `=cmd` 类文本也不会被执行。
- 单 sheet 超大（十万行）会生成巨大 HTML，建议设 `XLSX_PREVIEW_MAX_BYTES` 或限制渲染行数（如取前 1000 行并提示「仅预览前 N 行」）。

---

## 6. 安全策略对照表

| 维度     | DOCX                                                           | XLSX（设计）                                                           |
| -------- | -------------------------------------------------------------- | ---------------------------------------------------------------------- |
| 前端隔离 | iframe `sandbox=""`                                            | iframe `sandbox=""`（同）                                              |
| 后端 CSP | `default-src 'none'; img-src data:; style-src 'unsafe-inline'` | `default-src 'none'; style-src 'unsafe-inline'`（无 img 可省略 data:） |
| 图片处理 | 内联 data URI（mammoth）                                       | 通常无图片                                                             |
| 公式风险 | 无                                                             | 公式文本不执行（CSP + 纯 HTML 展示）                                   |
| 大小上限 | 10MB                                                           | 建议 10MB 或限制行数                                                   |

---

## 7. 迁移 / 落地 Checklist

### DOCX（已实现，迁移注意）

- [ ] 拷贝 `route.ts` 中 `type==="preview"` 的 docx 分支 + `wrapDocxPreviewHtml`。
- [ ] 拷贝 `lib/file-types.ts` 的 `DOCUMENT_EXT_TO_MIME` / `documentPreviewKind` / `isDocumentPreviewPath`。
- [ ] 拷贝 `components/FileViewer.tsx` 的 `DocumentViewer` 与分派逻辑。
- [ ] **把 `mammoth` 放入 `dependencies`**（不要留在 devDependencies）。
- [ ] 对齐文件访问鉴权（`getAllowedFileRoots` 等）。

### XLSX（待实现）

- [ ] 安装 `xlsx`（或 `exceljs`）到 `dependencies`。
- [ ] `file-types.ts` 扩展 `DOCUMENT_EXT_TO_MIME` 与 `documentPreviewKind` 支持 `xlsx`。
- [ ] `route.ts` 的 `preview` 分支增加 `xlsx` 处理（SheetJS 转 HTML + 多 sheet 标题）。
- [ ] 新增 `wrapXlsxPreviewHtml`（或复用 docx 包装，按需调表格样式）。
- [ ] `DocumentViewer` 顶栏标签泛化，复用 iframe + sandbox + meta 校验 + watch。
- [ ] 设大小 / 行数上限，防止超大表格拖垮浏览器。

---

## 8. 关键源码索引

| 内容                                    | 位置                                                   |
| --------------------------------------- | ------------------------------------------------------ |
| preview 接口（docx 转换 + CSP）         | `app/api/files/[...path]/route.ts` 第 499–528 行       |
| docx HTML 页面包装                      | `app/api/files/[...path]/route.ts` 第 365–412 行       |
| 文档 MIME / 类型判断                    | `lib/file-types.ts` 第 32–61 行                        |
| 大小阈值常量                            | `lib/file-types.ts` 第 1–3 行                          |
| 前端 DocumentViewer（iframe + sandbox） | `components/FileViewer.tsx` 第 664–784 行              |
| 类型分派入口                            | `components/FileViewer.tsx` 第 786–797 行              |
| mammoth 依赖声明                        | `package.json` 第 66 行（**devDependencies，需迁移**） |
