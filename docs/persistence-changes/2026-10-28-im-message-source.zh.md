---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-28-im-message-source

[English](2026-10-28-im-message-source.md) | 中文

## 概述

新增仅用于归属的 `im` 消息来源：`@deepseek-ai/dsh-im` 在投递到托管会话的用户消息上写入该来源，使读取方能够区分外部 IM 输入与所有者输入。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-10-28-im-message-source
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-27-retry-control-input"
    after: "0355c575aca4270bbee7139e96b581f79bbf9d58675e80f4afa57313ccd42348"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-27-retry-control-input"
    after: "e584c8c8287efccb70b9477e4c62b7e3c8956ae0aa6edd67264d36449013dfdb"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-27-retry-control-input"
    after: "d83988305c43ef6e9f971a1a042d52d5cb6fce07579d5571d5f6511115659faf"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-27-retry-control-input"
    after: "0afbb0496cb3532810ace398d8e50feef4317fbcb311e9335feb1f76ab34fee3"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

该来源只携带 `kind` 与 `relay` 上下文形式。新读取方按非空、由生产方拥有的 `kind` 接纳持久化消息来源，会话重放无需加载 IM 生产方即可派生消息。旧读取方保留未知生产方来源类型及其 JSON 元数据。任何读取方都不得从该来源推断权限：访问决策仍由运行中的 IM 服务负责，不含 IM 输入的日志不受影响。

<a id="verification"></a>
## 验证

pnpm exec vitest run scripts/im-persistence.spec.ts：2 个测试通过。测试对已发布 V4 行进行编码与严格解码，通过当前目录恢复，并在不加载 IM 生产方的情况下派生消息；一次带 `{kind: 'im', form: 'relay'}` 来源，一次不带任何 IM 来源。

<a id="dev-note"></a>
## 开发备注

无。
