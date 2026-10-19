# Agent Note: 在 Conversation Node Definition 的 State 中预计算插话批首

Status: implemented

[English](2026-10-16-steering-batch-start-in-definition-state.md) | 中文

## 问题

Chat 在每次 claim 的第一条插话行上方保留 44px 的位置（等于运行状态行的高度），条件是这批插话落在运行中 Turn 的过程输出之后；这样插话被领取时，运行状态与气泡交换位置，气泡不动（[conversation-nodes README](../../../../packages/client/ui-chat/src/client/conversation-nodes/README.zh.md)）。判断一条插话是否是批首，需要两个它自己的 `user/message` 事件里没有的事实：它是否是所在 `next-step` claim 的第一条人类消息；同一 Turn 在它之前是否已有持久可见的输出，也就是这一行是否排在 Turn 过程控件之后。结论在实时追加、回放和加载更早历史时都必须成立，并且不能扫描事件窗口或 Chat Node。

## 决策

批首是 Conversation Node State 中的事实，由 Definition 通过现有的 [`reader.previous`](2026-08-09-client-conversation-node-assembly.zh.md) 查询计算：

- [`inbox.ts`](../../../../packages/client/ui-chat/src/client/conversation-nodes/inbox.ts) 在 Client Inbox State 中记录 `firstClaimedHuman`，即每次 `next-step` claim 取走的第一条人类消息。
- [`turn-process.ts`](../../../../packages/client/ui-chat/src/client/conversation-nodes/turn-process.ts) 注册 `processEvidenceDefinition`（kind `process-evidence`，`publication: () => 'none'`）：每个有持久可见输出的 Step 一个 Context，id 为 `turn:step`，通过现有的 `processEvidence` 判断从 `assistant/message`、`tool/call`、`tool/result`、`llm/retry` 匹配。流式 chunk 不会进入它。它的 State 只保存 Turn 编号；Context 的 matches 累积该 Step 的证据事件，没有任何代码读取它们。
- [`message.ts`](../../../../packages/client/ui-chat/src/client/conversation-nodes/message.ts) 只对 claim 的第一条人类消息，在 `start` 中调用 `reader.previous('process-evidence')`。最近的一条更早记录属于同一 Turn 时，插话 State 带上 `batchStart: true`。之后追加的事件 seq 都更大，不会改变结论；加载更早历史时，组装器对 `reader.previous` 的依赖追踪会重放这个依赖，与 Message 读取 Inbox 的方式相同。
- 插话渲染器只读取 `data.batchStart`，在气泡根元素上写 `data-chat-steering-batch="start"`；CSS 给所在行保留这个位置。

每条领头的人类消息做一次 O(log N) 查询，N 为已加载窗口中有输出的 Step 数。这一改动不新增框架 API，也不涉及持久化或传输数据。

## 考虑过的替代方案

**在渲染器里根据 props 计算。** 渲染器需要相邻行和 Turn 的过程状态，这会把插话分支带进本应不含业务的节点列表和 Seat；而且只有相邻行变化时，这一行不会重新渲染。

**在 Chat 快照构建层计算。** 对有序条目做一次投影，会把插话专用的规则和额外一轮遍历放进通用构建层。

**给框架增加带追踪的 Turn 数据读取（`reader.turnData`）。** 为了一个使用方修改 `ConversationNodeBuildReader` 的约定和组装器的依赖追踪；而 `reader.previous` 已经提供所需的顺序、依赖与重放。

## 后果

结论保存在节点数据中，借助现有依赖追踪在回放和加载更早历史时保持正确；渲染器、Seat、节点列表和 ui-conversation 框架都不变。代价是多一个 Definition，每个有输出的 Step 多一个 Context：每个 State 只有一个数字，每个 Context 持有该 Step 证据事件的引用。保留的位置跟随 claim 的第一条人类消息，而不是该批第一条渲染出来的行；因此同一次 claim 中记录在它之前的 runtime-context 通知会排在这个位置上方；这由 README 中“claim 的第一条人类消息保留该位置”的规则推出。

## 测试

- [conversation-node-definitions.client.spec.ts](../../../../packages/client/ui-chat/tests/conversation-node-definitions.client.spec.ts)：`records durable process evidence once per Step and ignores live chunks and invisible replies` 固定证据匹配；`marks each claim lead and starts a batch only after the Turn control` 分别以回放、实时追加和加载更早历史三种方式运行，固定第一次和之后一次 claim 的批首，以及同一 claim 的第二行、开启 Turn 的空闲 claim、无输出 Step 之后的 claim 都不是批首。
- [chat-view.client.spec.tsx](../../../../packages/client/ui-chat/tests/chat-view.client.spec.tsx)：`marks the steering row whose data carries a batch start, and no other input` 固定渲染出的属性；[turn-tail-spacing.client.spec.ts](../../../../packages/client/ui-chat/tests/turn-tail-spacing.client.spec.ts) 固定 44px 位置的规则。
