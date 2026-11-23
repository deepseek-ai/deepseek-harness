---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-17-action-card-decision-event

[English](2026-11-17-action-card-decision-event.md) | 中文

## 概述

新增 action-cards/decision 事件，记录操作卡片的关闭和卡片种类的进度，取代原来的实验性插件记录。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-11-17-action-card-decision-event
baseline: false
changes:
  - root: "event:action-cards/decision"
    previous: null
    after: "492fa1aa4c50b0476e236570fe9865de7959d2a4eeffc044ec47dcedf02909ec"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

在同一会话格式版本内新增一个根。已有日志不含此事件，仍然有效；早于此变更的读取端遇到含此事件的日志会拒绝，与所有读取时必需的事件一致。此前写下的决定仍是可忽略的 plugin:action-cards/decision 记录，actionCards 投影继续读取它们，已关闭和已创建的卡片保持原状态。只有用户操作卡片或卡片种类记录进度时才追加此事件。它不发给模型；向模型报告决定的状态通知是单独的 user/message 事件。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/interaction/action-cards packages/extensions/creation-recommendations packages/extensions/plugin-recommendations：110 个测试通过，包括投影读取旧插件记录的用例。

<a id="dev-note"></a>
## 开发备注

无。
