# Agent Note: 整轮折叠保留全部 Assistant 回复

Status: implemented

[English](2026-10-15-chat-keep-assistant-replies.md) | 中文

## Problem

简洁、标准、详细模式下，正常结束的 Turn 会整轮折叠。原规则下读者只看到输入、整轮控件、**最终答案**和页脚。最终答案按位置选取，即最后一个 Step 里最后一条有可见回复、且不带工具调用块的 Assistant 消息（[turn-process.ts](../../../../packages/client/ui-chat/src/client/conversation-nodes/turn-process.ts) 的 `latestAnswer`）；在它之前的阶段回复和过程一起被隐藏。

位置不等于内容。回答之后 Turn 往往还会继续：子 agent 结束的通知唤醒一步，Agent 记账、收尾，或回答后又调用了工具。这时最后一条变成一句简短补充，或者根本没有纯文字收尾，真正的回答被折进了过程（#6132、#5429）。例如一段很长的调研汇总之后，子 agent 结束的通知又唤醒一步，最后一条只写了一句补充；读者看到的就只有这句补充。

我们对阶段回复的分布做了粗略估计。以下比例是量级判断，不是统计结果：

- 主会话里，最后一条正文之前的阶段回复约占 Assistant 正文的 10%；子 agent 会话的阶段回复更碎，约占 20%。
- 按条数算，一半以上是一两行的"接下来要做什么"，全部显示会带来冗余。
- 少数较长的阶段回复装着实际结论或交付内容。原规则下它们随过程被折叠，直接影响读者理解问题。
- 一部分子任务以结构化结果的工具调用结束，没有纯文字回复，原规则下整轮看不到任何文字。

## Decision

整轮收起默认只隐藏过程，不再隐藏回复：所有 `assistant-step` 的回复行都留在整轮折叠之外，不论它属于哪个 Step。主会话和子 agent 会话使用同一规则，不按会话类型分支。

设置 → 通用设置的「收起后显示的回复」位于「工作步骤收起时机」正下方：

| 选项 | 行为 |
|---|---|
| 全部回复（默认，`all`） | 回复全部可见，只收起过程 |
| 仅最终回答（`final`） | 原规则：阶段回复随过程一起收起，只露最终答案 |

- 选择以 `ui-chat.foldedReplies` 保存到与「工作步骤展示」相同的 Host profile 设置；未保存时按 `all`，不自动写入默认值。
- 切换立即作用于已渲染的 Turn，只改显隐，不重建行。
- 完全展开模式从不折叠 Turn，该选项在这一模式下隐藏。

### 可见范围

| 查看状态（简洁／标准／详细，`all`） | 可见内容 |
|---|---|
| 整轮收起 | 输入、整轮控件、按原顺序排列的**全部回复行**、`turn` 位置的节点（终止错误、最大 token 提示、已完成轮次页脚） |
| 整轮展开 | 过程组头与全部回复行；组正文按模式与手动开合显示 |

整轮收起时隐藏的内容：

- 所有 Step 的推理行，包括最终答案附带的推理；
- 工具调用与结果、步骤组；
- `process` 位置的节点（如模型重试）；
- 其余没有分组树位置的过程行。

只有回复、没有任何过程内容的 Turn，整轮控件保留标题，不提供折叠操作。

### 不变的部分

| 方面 | 说明 |
|---|---|
| 折叠资格 | 运行中、已停止、失败、过程开始后有可见输入的 Turn 不提供整轮收起；缺起点、缺结束记录的规则不变 |
| 整轮控件 | 每个 Turn 一个，位置和标题（时长或状态）不变。回复之间被隐藏的步骤组直接消失，不为每段过程单独生成折叠行 |
| 收起时机 | 「完成时收起」「下次发送时收起」与交互段例外不变 |
| 手动开合 | 仍按答案世代保存 |
| 页脚、分支、复制 | 挂在本 Turn 最后一条带文字的已结算 Assistant 消息上（`turn-tail` 的 `closing`），与整轮折叠无关 |

### 实现

只改"谁是过程成员"这一条规则，并让它跟随设置。`TurnProcessSpec` 及其答案字段（`answerAnchorSeq`、`answerStep`、`inlineReasoning`、`messageCount`）、`latestAnswer` 选取、按答案 Step 保存的手动开合保持原样；选「仅最终回答」时这些结构照旧生效，行为与原规则一致。

| 位置 | 内容 |
|---|---|
| [chat-settings.ts](../../../../packages/client/ui-chat/src/chat-settings.ts)、[index.ts](../../../../packages/client/ui-chat/src/index.ts) | `FOLDED_REPLIES_FIELD`、`FOLDED_REPLIES = ['all', 'final']`、`DEFAULT_FOLDED_REPLIES = 'all'`，登记在 `ChatSettingsFields` 与 Host `Config` |
| [transcript-view.ts](../../../../packages/client/ui-chat/src/client/transcript-view.ts) | `TranscriptViewPolicy` 的 `foldedReplies` 快照与 `setFoldedReplies`，读写方式与 `collapseTiming` 相同 |
| [presentation-policy.ts](../../../../packages/client/ui-chat/src/client/presentation-policy.ts) | `ChatPresentationPolicy.foldedReplies`；`presentationPolicyFor(mode, timing, replies)` 对 16 种组合各返回固定对象；`derivePresentationPolicy` 订阅三项偏好 |
| [apply.ts](../../../../packages/client/ui-chat/src/client/apply.ts)、[settings/TranscriptViewRow.tsx](../../../../packages/client/ui-chat/src/client/settings/TranscriptViewRow.tsx)、[locale.ts](../../../../packages/client/ui-chat/src/client/locale.ts) | 设置行在收起时机下方的选择框，完全展开模式下不渲染；中英文案 |
| [chat/ChatNodeSeat.tsx](../../../../packages/client/ui-chat/src/client/chat/ChatNodeSeat.tsx) | `foldedReplies === 'all'` 时的 `replyRow`（`assistant-step` 中非推理部分且有回复内容的行）不是 `processMember`，并拥有开合状态（`ownsDisclosure`）以读取 `foldable`/`open`；可折叠内容按设置取 `hasNonReplyProcess` 或 `hasExternalProcess` |
| [chat/AssistantNodeView.tsx](../../../../packages/client/ui-chat/src/client/chat/AssistantNodeView.tsx) | `all` 时整轮收起隐藏回复行自带的内联推理；`final` 时只隐藏最终答案的内联推理 |
| [conversation-nodes/turn-process-presentation.ts](../../../../packages/client/ui-chat/src/client/conversation-nodes/turn-process-presentation.ts) | `hasExternalProcess` 之外的 `hasNonReplyProcess`：非答案 Step 的 `assistant-step` 只有带推理时才算过程内容 |

[Chat 节点业务规则](../../../../packages/client/ui-chat/src/client/conversation-nodes/README.zh.md)描述读者可见的规则与设置；[Chat 分组树位置与交互段](../architecture/2026-10-11-chat-group-tree-exchanges.zh.md)记录 `assistant-step` 回复行留在整轮折叠之外。

## Alternatives considered

**保持只露最终答案。** 最终答案按位置选取。回答之后 Turn 还在继续时，读者会丢掉真正的回答。

**按消息结构区分：只露不带工具调用的回复，带 `present`、`ask_user_question` 的消息例外。** 能去掉一部分冗余，同时保住大部分有效内容，但需要按工具名维护例外名单，属于微观规则。

**按字数阈值区分：较短且紧跟工具调用的回复继续折叠。** 能去掉大部分短预告，但阈值没有通用依据，中英文字数也不可比。

**子 agent 会话保持原规则。** ui-chat 需要新读 `sessions.subagentAddress()` 并按会话类型分支。子 agent 的阶段回复更碎，全部显示后冗余更多，但这类视图很少被直接阅读，读者点进去通常就是想看过程；以结构化结果收尾的子任务原规则下整轮空白，改后能看到提交结果前写的总结。

**每段过程各给一个折叠行。** 回复把过程切成多段，会多出大量折叠行。整轮控件已经能一次开合全部过程。

**同时删除最终答案结构（`answerStep` 等字段、`latestAnswer`、按答案世代的手动开合）。** 代码更少，但改动面大，也无法再提供「仅最终回答」选项。

**不提供设置，只改默认规则。** 想看原呈现的用户没有退路；原规则的代码本来就保留，加一个偏好只多一条读写链。

**把选项绑到「工作步骤展示」模式上（例如简洁 = 仅最终回答）。** 不需要新设置行，但两件独立的事被绑在一起，不能单独切换。

**把短的动作预告并入后续步骤组的标题。** 不丢文字，也不占行，但需要单独设计组标题，不在本次范围内。

## Consequences

- 收益：回答之后又有通知、记账或工具调用的 Turn 不再丢失回答；以结构化结果收尾的子任务不再整轮空白；想要原呈现的读者可以一键切回。
- 收起后的正文按估计在主会话多出约 10%，在子 agent 视图多出约 20%。多出的内容里既有原本被折掉的实际结论，也有一两行动作预告带来的冗余；子 agent 视图阅读频率低，代价按绝对量计较小。
- 收起后连续的回复之间不再显示过程，几条回复可能被连读成一段；每条回复仍是独立行，保持原有间距。
- 收起的 Turn 不再给最终答案额外的控件 16px 间距：两种选项下，与控件之间隔着已收起行的回复都保持 12px 回复间距，只有紧跟控件的那一行得到 16px。折叠结束时没有回复改变间距，最终答案不再在折叠末尾下移约 4px（#6323）。
- 保留的答案结构在 `all` 下留下一处小的不对称：`data-turn-process-messages` 仍统计最终答案之前的回复数，尽管它们已可见。
- 上述比例是粗略估计，不同的工作方式和模型下会有差异。

## Testing

- `packages/client/ui-chat/tests/chat-view.client.spec.tsx`：收起后各 Step 的回复可见、推理与工具收起、无纯文字收尾的 Turn 仍显示回复、只有回复的 Turn 不提供折叠；`all` 与 `final` 实时切换不重建行；把阶段回复当作过程替身的用例改为纯推理行。
- `packages/client/ui-chat/tests/presentation-policy.client.spec.tsx`：16 种组合的固定策略对象与三项偏好订阅。
- `packages/client/ui-chat/tests/transcript-view-policy.client.spec.ts`、`transcript-view-row.client.spec.tsx`、`config.host.spec.ts`：默认值、持久化与采纳，设置行位置、中英文案与完全展开时隐藏，Host 配置校验与恢复。
- Web e2e：`turn-tail-actions.e2e.ts` 与 `chat-flow-layout.e2e.ts` 断言收起后控件之后第一条可见回复保持 12px 回复间距；设置页与收起后 aria 黄金快照包含新设置行与阶段回复。
