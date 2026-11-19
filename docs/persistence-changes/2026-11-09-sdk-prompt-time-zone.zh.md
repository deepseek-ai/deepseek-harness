---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-09-sdk-prompt-time-zone

[English](2026-11-09-sdk-prompt-time-zone.md) | 中文

## 概述

新增 sdk-user 消息来源：SDK prompt 在不带 rpcId 的 user 来源上记录可选的规范化 clientTimeZone。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-11-09-sdk-prompt-time-zone
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-11-05-timeline-priority-notice"
    after: "5509e694e7b11c54a7b7b1730ad09fd46986a1aeaa45a713a69b9247f5861efb"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-11-05-timeline-priority-notice"
    after: "53538b9e2b974a81f1248a4505482f8ab5c91bdf59b24cb3bd8e908bf8dd278e"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-11-05-timeline-priority-notice"
    after: "5d8b5283839b93371885639068f7df86ab6d3134faf186456bdd4f4bdcb42260"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-11-05-timeline-priority-notice"
    after: "3a34ff4c0c404f4b674b06d4d567953b4dee24c35dd72b03ee5b89553326bb3a"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

kind 仍为 'user'，字段可选，因此所有既有 Session 日志都不变；没有可用时区的 SDK prompt 仍写入与之前相同的 { kind: 'user' } 来源。写入方在提交前规范化时区，请求准备阶段仍拒绝非规范值。当前读取方读取旧日志时，SDK prompt 上没有 clientTimeZone，与之前一样报告时区不可用。早于本更改的读取方忽略不带 rpcId 的 clientTimeZone，同样报告时区不可用；已记录请求的模型可见时间上下文从其自身记录的事件回放，不从来源重新计算。该字段不进入任何模型请求：provider 适配器只读取模型可见的消息内容。SESSION_FORMAT_VERSION 不变。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/sdk/server/tests/time-zone.spec.ts packages/context/time-context/tests：SDK prompt 持久化规范化后的显式或采样时区，采样时区不可用时不写该字段，原生命令不记录时区，不带 rpcId 的 user 来源向时间上下文提供其时区；全部测试通过。

<a id="dev-note"></a>
## 开发备注

无。
