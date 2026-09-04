# Agent Note: 用同一条选取规则在空终止消息后保留子代理输出

Status: implemented

[English](2026-08-10-subagent-empty-terminal-message-output.md) | 中文

## 问题

当 `max-tokens` step 只组装出 tool-call block 时，agent loop 会追加空 content `assistant/message`，因为 `BlockAssembler.blocks()` 会丢弃被截断的 tool call；该 message 保留 stream 与 usage，但不贡献 output block。三个消费方独立选取 child agent 输出，并把该 record 当成输出。进程内 driver 的 `readResult` 与 continuable Activation 的 `subagent/end` capture 不加过滤地选取最后一条 `assistant/message`，SDK backend observer 则让任何 `assistant/message` 优先于累计 text。在被 max-tokens 截断的多 step turn 中，最后的空 message 导致 `SubagentResult.output`、tool result、telemetry 与 `subagent/end.lastAssistantMessage` 漏掉真实 partial answer。进程内 driver 也缺少 streamed-text fallback，因此被取消 child 的唯一 text 若只存在于嵌入式 Assistant stream 中，也会报告 `[]`。

## 决策

`dsh-subagent` 在 `src/assistant-output.ts` 中拥有唯一规范选取规则：选取最后一条非空 Assistant message；没有时，从嵌入式 `assistant/message` 与 `assistant/attempt` stream 或 chunk-only transport 选取累计 `text-delta` content；忽略空 content message。增量 `AssistantOutputFold` 通过 `push(event)`、`pushText(text)` 与 `collect()` 实现该规则。`finalAssistantOutput(events)` 把规则应用于完整 event suffix，供进程内 `readResult` 与 Activation capture 使用。SDK backend 折叠 notification event；ACP backend 不公开完整 Assistant message，并折叠 raw chunk text。`SubagentResult.output` 定义 result contract，`subagent/end.lastAssistantMessage` 使用同一规则。child 不产生任一种输出时，一次性与 continuable run 的 lifecycle field 都缺省，而不是空 array。`max-tokens` 或 `aborted` result 保留实际 stop reason。

前台委派工具使用同一选取规则。非 `completed` 的结果仍是 `isError` 工具结果，但其消息会在终止原因标题之后呈现由[非交互权限决策](../feature/2026-08-15-product-subagent-noninteractive-permissions.zh.md)负责的可选安全提供方诊断，再附上子 agent 的部分文本。父模型会同时收到失败、独立的基础设施说明与已有 assistant 输出，而且不会把它们混为一体。

## 验证

无密钥 SDK 后端测试使用 `FAKE_EMPTY_MESSAGE` 发出一条仅记录 usage 的终止消息。`subagent-max-tokens-partial` ACP 快照记录一个子 agent：它流式输出文本与一次工具调用，结束于仅含工具调用的 max-tokens 步骤，持久化日志中含一条空的 usage 消息，并通过父侧的错误工具结果返回部分文本。单元覆盖检查空终止消息、取消、消息顺序、不含文本的非空消息，以及排除工具结果内容。

## 考虑过的替代方案

**各消费方就地修复、不抽共享辅助函数。** 之所以否决：三处独立选取已发生分歧，而同一次运行的观察方必须对其输出达成一致。

**让 loop 不再追加空消息。** 之所以否决：这条消息记录 usage，并在持久化日志中保留该步骤（"model-visible ⟺ logged"）；为处理输出选取而改动会话事件，会影响所有 replay 与 projection 消费方。

**把空内容消息视为错误。** 之所以否决：流式文本才是子代理真实的部分回答，且终止原因已经告诉消费方轮次被截断。

## 后果

被 max-tokens 截断的多步子 agent 会报告其更早的文本；被取消的进程内子 agent 保留中止前已流式的文本；一次性与 continuable 的 `subagent/end` 事件同 `SubagentResult.output` 一致。内容非空但不含文本的消息（例如仅含 reasoning 的内容）仍然优先于流式文本，因为规则检查内容长度，而不是文本是否存在。非空消息同样优先于其后才流式出的文本：子 agent 在流式输出后续步骤时被取消，报告的是更早那条完整消息，终止原因则记录该截断。
