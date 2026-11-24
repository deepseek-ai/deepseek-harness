---
kind: upgrade-guide
description: "ChangeRequestSummary 去掉 closingIssues 与 closingIssuesTruncated。"
---

# Forge 的 viewer 列表项不再带会关闭的 issue

[English](guide.md) | 中文

## 变更

`ChangeRequestSummary`（`ForgeProvider` 的 `listForViewer` 返回的列表项）去掉了 `closingIssues` 与 `closingIssuesTruncated`。代码评审页不再显示列表里的变更请求会关闭哪些 issue；变更请求自己的概览仍从未改动的 `ChangeRequestSnapshot.closingIssues` 列出它们。GitHub 提供方的列表搜索不再读取会关闭的 issue。

受影响的是提供 viewer 列表的第三方 `ForgeProvider` 实现，以及其他构造或读取 `ChangeRequestSummary` 的代码。该类型来自 `@deepseek-ai/dsh-experimental-forge`。

## 迁移

1. 在提供方构造的每个 `ChangeRequestSummary` 中去掉 `closingIssues` 与 `closingIssuesTruncated`，并删除只为它们服务的读取。
2. 原先从列表项读取这两个字段的代码，改为读取该变更请求的 `ChangeRequestSnapshot` 上的 `closingIssues` 与 `closingIssuesTruncated`，它由 `ctx.forge.watch` 送达。
