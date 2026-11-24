---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-24-todo-reminder-source

[English](2026-11-24-todo-reminder-source.md) | 中文

## 概述

新增使用 snapshot 形式与有界提醒文本的 todo-reminder 消息来源类型。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-11-24-todo-reminder-source
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-19-plugin-reference-source"
    after: "a6ad7b1b4ecb39b6c2c6ba801bff9d2601e990acf846db7217350fab6d05fea8"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-19-plugin-reference-source"
    after: "1fa784dd2338cf16d2641a437ad6f2ae81ad3e2d8e9c8b5f1dd983e1682e2a6f"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-19-plugin-reference-source"
    after: "f2aa1a0423acdb256a598c513fb7bb45d86a13a67080ee34f5dcea6289d7396f"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-19-plugin-reference-source"
    after: "c234c1ee836693b406782c6dac3abfe3644abc814216ef765ff1bd08682ac1cf"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

本变更仍保持 Session 格式 V4。当前读取器保留所有既有来源类型和事件字段。已发布的 V4 读取器接受用户消息和开发者消息中的非空未知生产者类型，保留其 snapshot 元数据与文本内容，并正常推导模型历史。相同的来源对象也可能出现在队列收件箱或标题请求消息中，不会改变事件判别字段、头部或既有来源语义。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/session/session-format-v3-to-v4/tests/attribution.spec.ts packages/session/session-format-v3-to-v4/tests/message-sources.spec.ts（12 项通过）；pnpm exec vitest run packages/todo/tool-todo/tests/（5 个文件、48 项通过，100% 覆盖率）；pnpm exec vitest run --config vitest.snapshot.config.ts -t todo-update-reminder（1 项通过）。

<a id="dev-note"></a>
## 开发备注

无。
