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
    previous: "2026-11-05-timeline-priority-notice"
    after: "d6d06328af1c9b5a8a763de75c8f95b3bdf15a67f9f5ae2c18401c80572f4ddf"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-11-05-timeline-priority-notice"
    after: "ee21b73a2ccee9a6a23640ead31553551776d82ad5c47679b7f468bf9889d3f9"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-11-05-timeline-priority-notice"
    after: "265c4bb3701a47b57cc9cede8a66e7056522b7546a5c9cb97938e44a6b1898df"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-11-05-timeline-priority-notice"
    after: "c68fa14948985fdc23004a95480ba96eab26cb08b82736425f9f9cd053e3ba2f"
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
