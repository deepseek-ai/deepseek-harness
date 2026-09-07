# Agent Note: user 与 steering 气泡移除分支操作

Status: implemented
Archived: 2026-09-04

[English](2026-08-06-user-bubbles-drop-the-branch-action.md) | 中文

## 问题

每个 user 气泡和已消费的 steering（中途引导）气泡都渲染分支控件，受[已完成轮次尾部决策](../bug-fix/2026-08-02-message-fork-actions-require-completed-turn-tail.zh.md)的门禁约束。在这些气泡上，该门禁实际上是永久性的：开轮的 user 消息后面必然跟着本轮自己的节点，已消费的 steering 消息按构造就处在轮次中间，因此只有当轮次结束时该消息之后一个节点都没有——即在第一个模型事件之前就取消——控件才可能启用。读者因此看到一个永远不会启用的控件，tooltip 许诺的是这个按钮到达不了的状态。这个操作入口本身也有误导：在消息 seq 处 fork 会切在所在轮次的 `turn/end`，「在我的消息处分支」实际会把下方的回答一并带走，与在自己气泡上看到分支时「分叉重问」的直觉预期恰好相反。

## 决策

user 与 steering 气泡不再渲染分支操作。`MessageItem` 移除其 fork props，`PendingSteeringBubble` 移除其 `showBranch` 特例，`messageBranchSeqs` 收窄为 `assistantBranchSeqs`：只有已完成轮次的 transcript（文本记录）尾部、且该尾部是本轮自己的带 text 内容 assistant 节点才可 fork。分支入口只存在于已定稿的回答之下。

含有 steer 的轮次的 fork 点保持不变：fork 是切在 `turn/end` 上的日志前缀，steer 是子会话必须继承的模型可见历史，因此被引导过的轮次的已定稿回答与其他轮次一样可以 fork。assistant 侧的门禁及其可见但不可用的呈现也保持不变——在回答之下，不可用是一个短暂且可到达的状态（当前尾部被后续工具行或错误行占据），这正是 tooltip 的用武之地。

## 考虑过的替代方案

**仅在不可用时隐藏消息气泡上的控件。** 否决：它保住了那个几乎不可达的启用场景，代价是图标只在轮次尚未产出任何东西就中止时才出现在自己的气泡上，这种不一致不值得为它服务的场景付出。

**保留可见但不可用的控件（现状）。** 否决：[已完成轮次尾部决策](../bug-fix/2026-08-02-message-fork-actions-require-completed-turn-tail.zh.md)选择可见，是为了让 tooltip 解释一个读者可以到达的边界；在 user 与 steering 气泡上这个边界实际不可达，解释文本是在为一个不该存在于此的控件打补丁。

**在 user 气泡上采用切在消息之前的分支语义。** 不在本次范围内：从自己的提示词重问需要切在消息之前并预填输入框，是另一个 Host 操作。移除当前控件恰好为这样的功能留出位置，而不是让语义相反的控件占着它。

## 后果

唯一的 fork 入口是已定稿回答下方启用的分支控件。在任何节点跟上其消息之前就被取消的轮次失去了它唯一的入口，从此没有 fork 点，与尾部是无内容 interrupted 节点的轮次一致。`apps/web` 的 aria golden 全部移除 user 气泡的禁用分支行及其隐藏说明文本。包测试钉住：user 与 steering 气泡不渲染分支控件，steering 作为尾部的轮次让叙述节点的控件保持不可用。
