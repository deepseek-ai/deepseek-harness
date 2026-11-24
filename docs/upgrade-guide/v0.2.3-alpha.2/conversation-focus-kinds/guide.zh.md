---
kind: upgrade-guide
description: "Conversation View 焦点改为以 kind 区分的值，View Definition 改为列出接受的类型，不再转换 id。"
---

# Conversation View 焦点值

[English](guide.md) | 中文

## 变更

在 0.2.3-alpha.2 中，`ConversationViewRequest.focus` 是字符串，由各 View Definition 通过 `toolCallFocus(callId)` 生成。升级后，`focus` 是以 `kind` 区分的 `ConversationFocus` 值，例如 `{ kind: 'tool-call', callId }` 或 `{ kind: 'request', turn, step }`。View Definition 在 `accepts` 中列出自己处理的类型，`openView(view, focus)` 接收同样的值。旧版本保存的待处理请求在还原 Session 时被丢弃。shell 规则见 [View 选择](../../../subsystems/conversation.zh.md)。

## 迁移

1. 在第三方 View Definition 中，把 `toolCallFocus: callId => …` 改为 `accepts: ['tool-call']`；若该 View 能定位模型请求，再加上 `'request'`。
2. 在 View 组件中读取 `viewRequest.focus.kind`，从值中取 `callId` 或 `turn` 与 `step`，不再解析字符串。忽略该 View 不处理的类型。
3. 把直接调用的 `openView(view, 'id')` 改为 `openView(view, { kind: 'tool-call', callId: 'id' })`。
4. 新增类型时，通过声明合并向 `ConversationFocusMap` 添加可 JSON 序列化的字段，在 `accepts` 中列出它，并确认插件能通过类型检查。
