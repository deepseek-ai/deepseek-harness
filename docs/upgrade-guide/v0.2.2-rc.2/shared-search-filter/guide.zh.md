---
kind: upgrade-guide
description: "ui-primitives 不再导出 rankByName，popupSelect 命令不再接受 searchMode。"
---

# 共享搜索过滤器取代 rankByName 和 searchMode

[English](guide.md) | 中文

## 变更

`@deepseek-ai/dsh-client-ui-primitives` 曾导出 `rankByName(items, query)`，它按 `name` 或 `label` 的有序子序列对条目排序。该函数已移除。`@deepseek-ai/dsh-client-ui-commands` 曾在 `popupSelect` 命令规格上接受 `searchMode: 'substring' | 'fuzzy-label'`，并导出 `PopupSearchMode` 类型；两者均已移除。现在每个弹窗都用同一种方式过滤选项：标签模糊匹配，详情按子串匹配，选项在各自分组内排序。共享搜索是 `@deepseek-ai/dsh-util-text-search` 中的 [`TextSearchIndex`](../../../../packages/util/text-search/README.zh.md)。受影响的是导入 `rankByName`、设置 `searchMode` 或导入 `PopupSearchMode` 的插件作者。

## 迁移

1. 把 `rankByName(items, query)` 替换为从 `@deepseek-ai/dsh-util-text-search` 导入的 `TextSearchIndex`：列表变化时构建 `new TextSearchIndex(items, item => ({ fuzzy: [item.name, item.label] }))`，每次查询时调用 `index.search(query)`。把该包加入插件的依赖：Client 插件加入 `devDependencies`，Host 插件加入 `dependencies`。把描述或其他长文本放进 `substring`，并通过 `localizedValues` 传入 `LocalizedText` 的所有语言。
2. 从每个 `popupSelect` 规格中删除 `searchMode`，并移除所有 `PopupSearchMode` 导入。
3. 确认插件通过类型检查，并确认在其弹窗中键入选项标签的一部分仍能找到该选项。
