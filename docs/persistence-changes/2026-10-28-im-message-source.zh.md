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
    previous: "2026-11-19-cua-input-notices"
    after: "7b3076b2edd39cbc65d59ccdbdbdf586cd543e9aa894b70fb6cfdbc172aed01d"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-11-19-cua-input-notices"
    after: "02cfeb91a193ce6642c8dfbf892b2bfce40999842fc8c8d1a8c34852f95dd833"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-11-19-cua-input-notices"
    after: "5c7929f7efc45376cf32cfdb8414f89bd5db63003cafb901c54271cca8eb6dc1"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-11-19-cua-input-notices"
    after: "7995e48c2ead64c21ad85aee5dc56a248529229b33a7b4b29649b9c68c2cba36"
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
