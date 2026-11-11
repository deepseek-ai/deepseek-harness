---
kind: upgrade-guide
description: 三个已发布插件的根入口移除内部辅助实体的值导出。
---

# 替换内部插件根导入

[English](guide.md) | 中文

## 变更

从 v0.2.2-rc.1 升级后，以下插件根入口不再导出这些值。对应实现在包内保留。从包根入口导入这些值的消费方需要更改导入或改用所属服务。

| 包名后缀（`@deepseek-ai/dsh-`） | 移除的根辅助实体 |
|---|---|
| `file-reference-local` | `DEFAULT_FILE_SEARCH_EXCLUDED_DIRECTORIES`、`DEFAULT_FILE_SEARCH_MAX_ENTRIES`、`DEFAULT_FILE_SEARCH_MAX_RESULTS`、`WorkspaceFileSearch`、`FILE_REFERENCE_PROMPT`、`activeAtToken`、`formatFileMention` |
| `llm-pi-ai` | `recordKeyFor` |
| `lsp-stdio` | `LspConnection`、`LspInstance`、`MessageDecoder`、`canonicalizeWorkspace`、`encodeMessage`、`negotiatePositionEncoding`、`normalizeHover`、`normalizeLocations`、`readHostSource`、`requestMethod`、`supportsOperation`、`supportsTransientOpen` |

品牌构造器、包子路径、持久化值和 Session 格式不变。

## 迁移

1. 停止从插件根入口导入上表的辅助实体值。包内测试可以相对导入对应内部模块。
2. 应用代码应使用注入的 `fileReferences` 或 `lsp` 服务，而不是提供方的实现类或协议辅助函数。文件引用语法仍在 `@deepseek-ai/dsh-file-reference/grammar`；`FILE_REFERENCE_PROMPT` 仍在 `@deepseek-ai/dsh-file-reference`。`recordKeyFor` 没有替代的公开入口。
3. 编译应用并运行其测试，同时用 Node 加载纯 JavaScript 消费方：仅检查 TypeScript 无法覆盖 `.mjs` 文件中缺少 ESM 命名导出的错误。
