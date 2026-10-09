---
kind: upgrade-guide
description: "会话标题提供方直接注册、拥有自己的策略设置，并只共享准备好的执行。"
---

# 迁移会话标题提供方

[English](guide.md) | 中文

## 变更

`@deepseek-ai/dsh-session-title-llm` 不再导出 `registerSessionTitleLlmProvider`、`generateSessionTitleWithLlm` 或 `SessionTitleLlmMessageSelector`。`SessionTitleLlmConfig` 现在只包含执行控制（`maxInputBytes`、`maxOutputTokens`、`timeoutMs` 以及可选的 `provider`/`model` 对）；`targetWords` 与 `targetCjkCharacters` 已移入各提供方自己的 `Config`。各提供方拥有自己的系统指令、消息封装、标题解析、推理选择与输出解释，直接通过 `ctx.sessionTitle.register()` 注册，并调用 `executeSessionTitleLlm(ctx, config, request, providerId, { system, input, messageSeqs, selectReasoningEffort })`。该函数返回组装后的内容块、终止结束原因与所用模型路由。`SessionTitleProviderRequest` 新增可选的 `currentTitle` 快照。

## 迁移

1. 把 `registerSessionTitleLlmProvider(...)` 调用替换为直接 `ctx.sessionTitle.register({ id, automatic, generate })`；保持相同的 `id` 与节奏。
2. 在 `generate(request)` 中构建自己的系统提示词与用户输入，传入 `selectReasoningEffort` 函数，然后用 `{ system, input, messageSeqs, selectReasoningEffort }` 调用 `executeSessionTitleLlm`。
3. 拒绝 `tool-calls` 或 `max-tokens` 终止结束原因与工具调用块；从文本块派生标题。
4. 当策略需要保留已接纳的提供方标题时读取 `request.currentTitle`；任何标题被接纳前该值为缺省。
5. 生成一次标题，确认保存的结果以及确切的 `session/title-llm-request` 记录。
