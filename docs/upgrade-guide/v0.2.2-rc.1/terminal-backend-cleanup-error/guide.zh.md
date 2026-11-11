---
kind: upgrade-guide
description: "TerminalBackendCleanupError 改为继承 TerminalError 而非 AggregateError，并带 CLEANUP_FAILED 错误码。"
---

# `TerminalBackendCleanupError` 改为继承 `TerminalError`

[English](guide.md) | 中文

## 变更

`@deepseek-ai/dsh-terminal` 导出的 `TerminalBackendCleanupError` 由 PTY 后端在启动失败且清理部分资源也失败时抛出。它原先继承 `AggregateError`，现在继承 `TerminalError`，因此是带 code `CLEANUP_FAILED` 的 `HarnessError`，携带它的工具结果会记录 `error.name` `TerminalBackendCleanupError` 和 `error.code` `CLEANUP_FAILED`。构造函数、`name`、`spawnError`、`cleanupError` 以及按原顺序排列的 `errors` 列表不变；`errors` 的类型由 `any[]` 改为 `readonly unknown[]`。`cause` 新增为同样两个失败组成的 `AggregateError`。`error instanceof AggregateError` 现在为 `false`。

只构造该错误、读取 `spawnError` 或 `cleanupError`、或检查 `instanceof TerminalBackendCleanupError` 的后端与消费方不受影响。

## 迁移

1. 把针对该错误的 `error instanceof AggregateError` 检查改为 `error instanceof TerminalBackendCleanupError`，或对 `TerminalError` 检查 `error.code === 'CLEANUP_FAILED'`。
2. TypeScript 代码未经收窄就读取 `error.errors` 元素成员时，先收窄每个 `unknown` 元素，或改为读取 `spawnError` 与 `cleanupError`。
3. 在消费项目中运行 `pnpm exec tsc --noEmit` 确认通过，并检查启动清理失败仍会进入原有的处理路径。
