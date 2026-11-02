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

Session API 测试通过：51 个文件、1112 个测试，continuation.ts 的语句、分支、函数和行覆盖率均为 100%。Chat 与 conversation 测试通过：113 个文件、1875 个测试；最终定向 Chat 与输入回归分别通过 96 和 31 个测试。浏览器继续回放通过，断言日志保留空 retry 用户消息、Chat 无空气泡且轮次正常闭合。构建 10 项全部通过，类型感知 lint 退出码为 0，doc-sync 的 43 项全部通过。与 PR 基线的 Git 比较确认 AgentLoop、Core Agent、Core Session 和 SDK 无改动。

<a id="dev-note"></a>
## 开发备注

无。
