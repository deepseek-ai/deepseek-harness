---
kind: upgrade-guide
description: "SDK run 识别原生命令，并在本次输入完成后返回 RunResult。"
---

# SDK run 接受原生命令

[English](guide.md) | 中文

## 变更

Python 和 TypeScript 的 `run()` 通过原有入口接受字符串和内容块数组，始终返回 `RunResult`。受支持原生命令按定义身份和实际注册名识别。中英文别名跟随重命名的定义；无关的同名替代命令仍作为普通输入。见[支持的命令规则](../../../../packages/sdk/server/README.zh.md#command-input)。

`final_response` / `finalResponse` 包含最终助手文本；活动未输出助手文本时为空字符串。仅改变状态的命令返回原生 handler 的结果文本。`finish_reason` / `finishReason` 表示结束结果。每份结果都保留 Session id、根会话事件和会话树通知。仅改变状态的命令无需等待模型 turn；`/plan <task>` 等待其提交的活动，包括原生审阅及获批后的后续执行。目标创建和恢复跨越自动轮次等待，直到目标停止及最后的活动结束。底层严格命令调用仍在原生 handler 完成后返回 `CommandExecution`。

内容块数组不再绕过原生命令路由。已识别命令要求一个文本块及可选的编码位图；原生 handler 执行图片准入。`/plan off` 带图片会失败且不改变计划状态。空数组和纯空白输入在创建 Session 前拒绝；纯图片输入仍然接受。严格端点拒绝命令身份时保留已经初始化的 Session，不执行 handler 或提交提示词。

## 迁移

1. 普通提示词和命令均继续使用 `result.final_response` / `result.finalResponse`。通过 `finish_reason` / `finishReason` 检查失败；命令 id 和原生结果保留在 `command/run` 与 `command/done` 事件中。保存结果的 Session id，以便继续或恢复会话。
2. 计划审阅期间保持用户问题回调可用。状态变更命令的失败体现在 `RunResult` 中；路由、协议数据格式和传输失败仍抛出或拒绝。超时或观察回调失败不会回滚运行时工作。
3. 需要按原文排队输入时，使用 Python `client.session_prompt(session_id, blocks)` 或 TypeScript `client.prompt(sessionId, blocks)`，并管理后续活动。运行时技能识别仍然适用。
4. 自定义 `session/query` 客户端发送 `{ sessionId, contentBlocks }`。命令响应确认原生 handler 完成；对应的 `session.query.completed` 通知携带本次输入的最终结果。保持通知顺序，并在发送前订阅。
5. 调用 `run()` 前过滤空输入。图片使用支持图片的模型及原有 `run([text_block, image_block])` 形式。Python 对格式错误的原生命令响应抛出 `SdkProtocolError`，保留校验原因；调用者自行选择的通用响应模型保留原有校验行为。
