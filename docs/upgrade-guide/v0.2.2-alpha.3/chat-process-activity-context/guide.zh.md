---
kind: upgrade-guide
description: "Chat 的 ProcessActivity 新增 context 类别，运行中活动改用 RunningProcessActivity。"
---

# Chat `ProcessActivity` 新增 `context`

[English](guide.md) | 中文

## 变更

`@deepseek-ai/dsh-client-ui-chat/client` 导出的 `ProcessActivity` 新增成员 `context`。成员全部为上下文注入的已结束过程组以它作为唯一类别。`ProcessActivitySummary.running` 的类型改为新导出的 `RunningProcessActivity`，该类型不含 `context`。对 `ProcessActivity` 做穷尽 switch 或为每个成员映射文案、图标的扩展受影响。

## 迁移

1. 在处理全部 `ProcessActivity` 成员的位置补上 `context` 分支，例如 `Record<ProcessActivity, …>` 或以 `assertNever` 结尾的 `switch`。
2. 读取 `summary.running` 且无需覆盖 `context` 的值，类型改为 `RunningProcessActivity`。
3. 运行扩展的类型检查，确认没有缺少成员的编译错误。
