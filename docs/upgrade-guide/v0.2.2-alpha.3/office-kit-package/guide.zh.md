---
kind: upgrade-guide
description: "`@deepseek-ai/dsh-office-kit` 取代 `@deepseek-ai/dsh-office-to-pdf`，其服务、Remote 方法、导出类型和配置行随之改名。"
---

# `@deepseek-ai/dsh-office-kit` 取代 `@deepseek-ai/dsh-office-to-pdf`

[English](guide.md) | 中文

## 变更

Office 转换提供方从 `@deepseek-ai/dsh-office-to-pdf` 移到 `@deepseek-ai/dsh-office-kit`。引用旧包、服务、Remote 方法或导出符号的组合、插件和 Client 受到影响：

| 旧名 | 新名 |
|---|---|
| `cordis.yml` 行 `id: office-to-pdf`、`name: '@deepseek-ai/dsh-office-to-pdf'` | `id: office-kit`、`name: '@deepseek-ai/dsh-office-kit'`；配置项不变 |
| `ctx.officeToPdf` | `ctx.officeKit` |
| Remote `officeToPdf/render`、`officeToPdf/generation` | `officeKit/render`、`officeKit/generation` |
| `OfficeToPdf` | `OfficeKit` |
| `OfficeToPdfError`、`OfficeToPdfErrorCode` | `OfficeKitError`、`OfficeKitErrorCode` |
| `OfficeToPdfGeneration` | `OfficeKitGeneration` |
| `OfficeToPdfRequest`、`OfficeToPdfResult`、`OfficeToPdfPriority`、`OfficeToPdfKey` | `OfficeKitRequest`、`OfficeKitResult`、`OfficeKitPriority`、`OfficeKitKey` |

Remote 错误 `document-render/failed`、`RenderedDocumentBytes`、`OfficeSourceKey` 和 `OfficeExtension` 保持原名。`/types` 和 `/remote` 入口仍然保留。

原先 LibreOffice Kit 缺失时提供方加载失败。现在没有 Kit 时提供方照常注册；每次需要转换器的转换都以代码为 `unavailable` 的 `OfficeKitError` 拒绝，并重新定位 Kit，因此之后安装的 Kit 无需重新加载提供方即可生效。

## 迁移

1. 在 `cordis.yml`、patch 和 overlay 中，把 `id: office-to-pdf` 行改为 `id: office-kit`，并把其 `name` 改为 `'@deepseek-ai/dsh-office-kit'`。`config` 块保持不变。
2. 在 `package.json` 中用 `@deepseek-ai/dsh-office-kit` 替换依赖 `@deepseek-ai/dsh-office-to-pdf`，并更新导入路径，包括 `/types` 和 `/remote`。
3. 按上表重命名 `ctx.officeToPdf`、Remote 方法名和导出符号。
4. 原先把转换行加载失败视为“Kit 缺失”的代码，改为检查转换返回的、代码为 `unavailable` 的 `OfficeKitError`。
5. 在项目中搜索 `office-to-pdf`、`officeToPdf` 和 `OfficeToPdf` 确认已无残留，然后在 Web 文档预览中打开一个 DOCX 文件，确认迁移完成。
