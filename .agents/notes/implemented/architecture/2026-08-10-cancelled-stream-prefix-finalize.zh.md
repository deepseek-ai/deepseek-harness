# Agent Note: 被取消的流定稿其已送达前缀

Status: implemented

[English](2026-08-10-cancelled-stream-prefix-finalize.md) | 中文

## Problem

被取消的流可能留下 Client 已经渲染的瞬态 chunk，但如果没有 `assistant/message` 记录已送达前缀，`deriveMessages()` 就会排除这部分内容。后续的「第二点展开讲讲」之类追问会缺少用户已读到的文本，在该轮次上创建的分支也会继承这个缺口。

模型历史必须包含取消后仍对用户可见的 assistant 内容。

## Decision

`ReactLoopAgent.step()` 在消费模型 stream 期间捕捉取消，此时 `BlockAssembler`、紧凑 stream accumulator 与 provider route 可以确定已送达前缀。loop 把该前缀追加为 step 的 `assistant/message`，并设置 `interrupted: true`、`surfaceOp: 'append'` 与精确嵌入式带时间 stream。该追加先于 committed `agent/assistant-stream` end frame、`step/end` 和记录 aborted 的 `turn/end`。

`BlockAssembler.interruptedBlocks()` 按 stream 顺序返回内容非空白的已闭合和未闭合 `text` 与 `reasoning` block。打断先于分派，没有真实工具结果，因此它会省略工具调用，也会省略空 block 和未闭合的未知 block 类型。返回结果为空时追加 `assistant/attempt`，而不是 surface message。Provider `error` 与 `aborted` finish 也会在 `agent/request-error` 前提交 `assistant/attempt`，因此其 stream 保持持久，但失败请求内容不会进入模型历史。

Chat 和 Trajectory Conversation Definition 从持久 message 读取 `interrupted`。Chat 渲染 Stopped marker，Trajectory 则在 `step/end` 后把 provider request 保持在 error 生命周期，并保留持久 result seq 与 provider 信息。工具执行期间的取消遵循工具调度器约定，因为 assistant message 已提交：已启动的调用生成真实结果，未分派的调用获得 `ABORTED_BEFORE_DISPATCH` 结果。

## Alternatives considered

**始终丢弃前缀。** 这能避免新增持久标记，但每次取消后的追问和分支都会缺少仍对用户可见的 assistant 内容。

**在投影时从嵌入式 attempt 组装前缀。** `deriveMessages()` 与 Client Conversation Definition 都需要实现打断组装规则，日志中也没有该前缀的权威 surface message。这还会让模型历史超出三类 `SurfaceEventType` 事件。

**保留完整工具调用并合成 aborted 结果。** 这些调用从未分派，合成结果会声称一个并未发生的执行结果，还会增加用户未收到的工具结果内容。

**追加 `[interrupted by user]` 之类模型可见的打断消息。** 这可以告诉模型前缀并不完整，但需要独立的来源类型、投影规则、UI 处理和本地化文案。持久的 aborted `turn/end` 保留了该后续决策所需的事实。

## Consequences

取消后的追问和分支会包含已送达前缀。ACP 桥会在结算 prompt 前排空按序传送的 assistant 输出，因此最后一条 `agent_message_chunk` 更新先于 cancelled stop reason。

终局 provider error 会在 `assistant/attempt` 中保留其 stream，但不让内容进入模型历史。只有用户的取消决策会把可见的已送达文本变成 interrupted surface message。

## Testing

`packages/core/agent-loop/tests/cancel.spec.ts` 覆盖 content、嵌入式 stream、事件顺序、下一请求的一致性、仅 reasoning 的输出、工具调用省略、恢复期间的取消和空前缀 attempt。`packages/llm/llm/tests/assembler.spec.ts` 覆盖 `interruptedBlocks()`。`packages/client/ui-chat/tests/conversation-node-definitions.client.spec.ts` 与 `packages/client/ui-trajectory/tests/conversation-definitions.client.spec.ts` 覆盖两种 Client 投影。keyless `cancel` ACP snapshot 与 `goal-round-driver` goal snapshot 覆盖组装应用。
