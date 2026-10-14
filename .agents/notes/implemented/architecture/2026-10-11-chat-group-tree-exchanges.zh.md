# Agent Note: Chat 分组树位置与交互段

Status: implemented

[English](2026-10-11-chat-group-tree-exchanges.md) | 中文

## Problem

「下次发送时收起」原本只让已加载时间线的最后一个 Turn 保持展开。由通知唤醒的 Turn（子 agent 完成、Goal Round、定时任务、后台作业）不是本客户端提交的，它一出现，上一轮就被当作历史折叠。这次折叠没有自己输入的驱动来计算精确的剩余补白，滚动层只能按通用规则预留底部空间，正在跟尾的读者因此看到一片空白。录制的真实 Session 中，通知在上一轮结束后 13–15 ms 唤醒新轮次；最小复现里空白高 596 px，五秒后仍未恢复。

## Decision

通知不算正文，也不算用户消息：折叠和推进底部时都忽略它。底部从"最后一个 Turn"改为"最新交互段"。

- **分组树位置。** `ChatConversationViewNode.groupTree` 声明节点在分组树中的位置，类型为 `ChatGroupTree = 'exchange' | 'input' | 'turn' | 'process'`，由外到内有序；站在某个位置的节点同时具有所有内层位置的效果。`exchange` 开启一个交互段。`input` 表示节点是所在 Turn 的输入：出现在该轮过程之前即为开场输入，之后出现即为中途输入，使整个 Turn 保持展开。`turn` 让节点留在 Turn 的整轮折叠之外，`process` 让节点留在整轮折叠之内、步骤组之外，没有位置的节点并入相邻的步骤组。`isAtOrOutside(node, position)` 是读取这一顺序的唯一入口：过程分组读 `process`，整轮折叠读 `turn`，轮次输入判断读 `input`，交互段读 `exchange`。
- **交互段。** 含 `exchange` 节点的 Turn 开启一个交互段，交互段持续到下一个开启 Turn。业务层的 message Definition 只给 Step 1 中被认领的真人输入（`user` 或 `steering`）标 `exchange`；之后的真人输入和触发通知位于 `input`，不开启交互段。
- **内置位置。** `turn-error`、`turn-max-tokens`、`turn-tail` 与 `turn-process` 控件位于 `turn`；`model-retry` 位于 `process`。ui-chat 自己的 `assistant-step` 节点保留两条放置规则：推理行并入步骤组、回复行在步骤组之外；该轮的过程规格让最终答案的回复留在整轮折叠之外，因为哪一步是最终答案会随后续步骤到来而变化。
- **机制。** `GroupTreeSegments(position)` 按含该位置节点的 Turn 切分已加载的 Turn，最新一段从最后一个开启 Turn 开始，窗口中没有开启 Turn 时从第一个已加载 Turn 开始。它按 Turn 增量计数，不扫描已加载节点；起点移动时只返回进入或离开最新一段的 Turn。Chat Builder 的 `bottomSource` 为"节点可见且属于最新交互段"。

结果是：通知唤醒的 Turn 不再折叠前面的 Turn，没有折叠就没有补白；真人下一次普通输入时，整个交互段经由自己输入的路径一起折叠。

## 为什么标开头而不是标通知

Host 在 `turn/start` 之后立即认领唤醒输入，然后组装系统提示，再写 `step/start` 和 `user/message`。录制的 Session 中这段间隔为 187 ms。只给通知打标的话，这段时间新 Turn 还没有标签，底部照样推进，上一轮会先折叠再展开。把标签放在真人开头上、未标的 Turn 默认续接，空白间隔里什么都不会发生。

## Alternatives considered

**给通知打"续接"标签。** 上面那 187 ms 的间隔会让它先折后展；同一次认领里通知和真人输入并存时还要额外判断。

**按 kind 写一张开启名单（`user`、`steering`）。** kind 区分不了 Step 1 的 steering 与 Turn 中途的 steering，真人往通知唤醒的 Turn 里插话时会错误地折叠前一个交互段。

**发布到 Turn 级 Location data。** 同一 Turn 的同一个 key 只允许一个 Context 发布，而开启输入来自多个消息 Context；改成按 Turn 汇总就得在新的 Definition 里重复 inbox 认领分类，并且每次都要读取所有 Turn。

**节点声明业务角色（`input`、`notice`）。** 这会把业务语义放进分组机制；分组树位置只描述结构，业务 Definition 自行决定位置。

**修正非自身输入折叠时的滚动补白。** 通知本来就不应触发折叠，修补白不能消除这次不必要的折叠。本页没有回显的真人输入引起的折叠，由[「下条消息时收起」只用一条折叠动画](2026-10-13-chat-single-fold-motion.zh.md)处理。

**在 `turn` 位置上判断轮次输入。** 终止错误、最大 token 提示和已完成轮次页脚同样在整轮折叠之外，读 `turn` 会把它们误当作开场输入；轮次输入需要自己的位置。

**由 Step 1 中的 `input` 推导交互段。** 触发通知是所在 Turn 的开场输入，却不能开启交互段。推导交互段就得把触发通知移出 `input`，从而改变通知唤醒的 Turn 中过程行的排列。

## Consequences

- 通知唤醒的 Turn 不再产生折叠、补白和空白。
- 外部 Definition 通过 `groupTree` 放置自己的 Chat 行。除 `assistant-step` 的两条规则外，ui-chat 在分组、折叠和判断轮次输入时不点名任何 kind，内置 kind 保持原 kind 名单给出的放置。
- 「下次发送时收起」下，一长串通知唤醒的 Turn（抽样会话中 Goal 模式最长 31 轮）会一直展开，直到真人再次输入。
- 已加载窗口里没有开启 Turn 时，所有已加载 Turn 都属于最新交互段。
- 另一个标签页里的真人输入在它的 `user/message` 到达时才折叠，比原来在 `turn/start` 时晚约 200 ms；其落点按[「下条消息时收起」只用一条折叠动画](2026-10-13-chat-single-fold-motion.zh.md)决定。

## Testing

- `packages/client/ui-chat/tests/group-tree-segments.client.spec.ts`：位置顺序、切分、计数回退与空窗口。
- `packages/client/ui-chat/tests/chat-node-bottom.client.spec.ts`：最新交互段的成员与通知范围。
- `packages/client/ui-chat/tests/conversation-node-definitions.client.spec.ts`：真实 assembler 下的开轮、中途 steering、Step 1 前的间隔、通知唤醒与空闲 steer，非开启输入位于 `input`。
- `packages/client/ui-chat/tests/process-groups.client.spec.ts`：任意位置上的节点不论 kind 都会切开步骤组，位置变化会触发重新分组。
- `apps/web/tests/notice-wake-tail.e2e.ts`：长 Turn 之后由通知唤醒，在 Step 1 前的间隔和通知回复之后，上一轮都保持展开，跟尾读者看到通知与回复。
