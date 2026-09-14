---
description: "feedback 包组：关于会话与 assistant 消息的用户反馈，供用户与维护者选择、组合或排查反馈采集。"
kind: "package-group"
---

# feedback/：记录的人类反馈

[English](README.md) | 中文

## 概述

feedback 组收集用户对 harness 工作成果的意见：用户可以提交一条关于整个会话的自由文本评价，也可以对单条 assistant 消息评分或加备注。两类反馈都不会到达模型——它们是关于输出的信号，绝不是输入。用户通过 `/feedback` 命令记录会话评价；产品界面通过 `messageFeedback` 服务读取和修改逐消息评分。两个包相互独立：会话评价与逐消息评分互不影响。本页概述该包组；具体包级约定以各包 README 和[反馈子系统页](../../docs/subsystems/feedback.zh.md)为准。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

<a id="packages"></a>
## 包

| 包 | 职责 |
|---|---|
| [`command-feedback`](command-feedback/README.zh.md) | 会话级反馈：`/feedback` 命令、Web 弹窗背后的 `sessionFeedback` Remote，以及固定分类表，均无需模型轮次 |
| [`message-feedback`](message-feedback/README.zh.md) | 逐消息评分、分类与备注，通过 `messageFeedback` 服务提供给产品界面 |

会话评价是单向信号：在对话的任何时刻记录它都是安全的，且绝不会改变模型看到的内容。在 feedback-gated 共享策略下，记录会话评价会触发放行，使该会话可供共享。

逐消息评分与备注与会话一起保存，重启后依然存在，并且绝不会出现在模型历史或遥测中。

<a id="related-documentation"></a>
## 相关文档

- [反馈子系统](../../docs/subsystems/feedback.zh.md)——message-feedback 的类型、服务约定与 Web 消费方。
- [会话遥测子系统](../../docs/subsystems/session-telemetry.zh.md)——`/feedback` 确认文本披露的共享策略。
- [匿名用户身份](../identity/README.zh.md)——反馈确认文本中嵌入的 id，每个 harness home 各有一个。

<a id="dev-note"></a>
## 开发备注

无。
