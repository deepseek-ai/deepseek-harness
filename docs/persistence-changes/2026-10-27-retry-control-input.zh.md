---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-27-retry-control-input

[English](2026-10-27-retry-control-input.md) | 中文

## 概述

为空 Session API 继续提示词增加 retry 消息来源；普通 user/message 记录保留输入身份和调用方元数据。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-10-27-retry-control-input
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-27-subagent-settlement-attribution"
    after: "1682631f010d5ea717d181ed6f4ef46cde08d92a31ab461e7e98edfc98461f85"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-27-subagent-settlement-attribution"
    after: "510826cf4e1f9220d75c1efd90b349dd9a77fc5ba15d19e16f87e85a48db5f99"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-27-subagent-settlement-attribution"
    after: "3bca25b2baa6b22be9b577621a7603497f40870ed88a8dac4383d37dc2bb6e18"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-27-subagent-settlement-attribution"
    after: "50a15408d511e9be3fa93abff37a38ae770f3ab905fc6849fee0d989200d2b97"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

retry 来源是现有空 UserMessage 表示中的生产方元数据。AgentLoop、模型历史派生与 SDK 提示词行为保持不变。旧读取方保留可扩展来源元数据，并按普通用户消息准入消费；旧界面可能显示空上下文行。更新后的读取方保留历史普通消息，Chat 仅隐藏空重试消息。现有事件判别标签与当前 Session 版本不变，不新增必读事件。

<a id="verification"></a>
## 验证

源码审查确认 AgentLoop 与 SDK 文件和 PR 基线一致。回归用例覆盖连续失败、请求去重、正常轮次结算、空重试消息准入、无关空消息，以及回放、实时和前插历史三种 Chat 展示。按要求，更新后的行为检查将在发布后运行。

<a id="dev-note"></a>
## 开发备注

无。
