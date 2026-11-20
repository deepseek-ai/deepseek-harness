---
kind: upgrade-guide
description: "个性化推荐的卡片改由回答里的 action-card 代码块提出；propose_action 工具、action-cards 的 queuedMessageLimit 字段和卡片的 callId 字段都已移除。"
---

# 操作卡片改由回答里的代码块提出

[English](guide.md) | 中文

## 变更

实验性的个性化推荐 Bundle 过去通过 `propose_action` 工具提出卡片。现在模型在最终回答末尾写一个围栏代码块，语言为 `action-card`，内容仍是 `action`、`title`、`brief` 与 `details`，`@deepseek-ai/dsh-action-cards` 从日志里的回答读出卡片。该工具不再声明，服务也不再有 `queuedMessageLimit` 配置字段：profile 的 `cordis.patch.yml` 里 `id: action-cards` 下留下的值会被忽略。

对注册卡片种类或调用该服务的插件：

- `ActionCardKind` 不再接受 `skill` 与 `invitation`；由种类自己的 Skill 告诉模型怎样写代码块、怎样邀请用户。
- `ActionCardProposal`、`ActionCardDecision`、`ctx.actionCards.act()` 与 `actionCards` Remote 用 `cardId`（类型 `ActionCardId`）指代卡片，不再用 `callId`；新写入的决定带 `cardId`。
- 本包不再导出 `ActionCardError`，`Config` 只剩 `enabled`（见[“个性化推荐” bundle 已移除](../../v0.2.2-rc.5/personalized-recommendations-bundle-retired/guide.zh.md)）。

用 `propose_action` 录下的会话不再显示这些卡片：这些调用显示为普通工具行，其决定也不再读取。受影响的是有这类会话的用户、改过 `queuedMessageLimit` 的用户和注册卡片种类的插件；随产品提供的 Bundle 无需改动。

## 迁移

1. 从 profile 的 `cordis.patch.yml` 里 `id: action-cards` 条目中删除 `queuedMessageLimit`；条目里不再有其他内容时，删除整个条目。
2. 在注册卡片种类的插件里，从 `ctx.actionCards.register()` 中去掉 `skill` 与 `invitation`，并把它的 Skill 改为要求在最终回答末尾写一个 `action-card` 代码块、邀请句写在代码块之前，做法同 [`official-plugins.md`](../../../../packages/extensions/plugin-recommendations/skills/official-plugins.md)。
3. 插件读取提议或决定、记录决定或调用 `act()` 的地方，把 `callId` 改为 `cardId`。
4. 提一个某个种类的 Skill 会以卡片回应的问题；卡片出现在回答下方、过程区没有 `propose_action` 调用，即迁移完成。
