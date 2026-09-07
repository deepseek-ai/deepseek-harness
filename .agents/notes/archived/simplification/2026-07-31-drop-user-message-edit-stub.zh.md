# Agent Note: 移除 user 消息的编辑存根

Status: implemented
Archived: 2026-09-04

[English](2026-07-31-drop-user-message-edit-stub.md) | 中文

## 问题

user 气泡的 IconActions 行在复制和分支旁边还有一个编辑按钮，但其背后什么都没有：该控件没有点击处理、没有 client 侧变更，也没有 host 侧重新发送已编辑消息的操作。用户找到它时，看到的是一个产品无法兑现的可供性。

## 决策

`MessageIconActions` 只渲染时钟／复制／分支，其 `edit` prop 随按钮一并删除；`MessageItem` 不再传入该 prop。现在 user 气泡与 assistant chrome 只在时钟位置上不同。包 README 在 Known Limitations 中记录这项缺失的能力，web 的 message-actions 预期输出固定了不含该控件的动作行。

公共 locale 保留通用的 `edit` 词条：它是共享词汇，而非本组件的文案。

重新引入该控件时要与能力一起落地：既需要编辑已定稿 user 消息的 client 变更，也需要 host 侧决定这条编辑后的消息对已经消费过它的轮次意味着什么。

## 曾考虑的替代方案

**把按钮置灰并加提示。** 一个可见但无效的控件仍在宣告可以编辑，解释成本相同；直接移除才是诚实的状态。

**接到队列编辑器上。** 队列编辑的是尚未发送的消息。已定稿的 user 消息已经进入 transcript（文本记录）和模型上下文，复用该编辑器会让同一个动作悄悄变成另一件事。

## 后果

Web 没有任何途径修正已发送的消息；从该消息分支是最接近的现有手势。由于动作行的内容完全由 props 组合而来，client 变更就绪后重新引入只是一次纯 UI 改动。
