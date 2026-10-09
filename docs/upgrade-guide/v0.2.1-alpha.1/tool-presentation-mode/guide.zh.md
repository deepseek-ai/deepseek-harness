---
kind: upgrade-guide
description: "工具呈现方式仅接受 native 或 ptc；混合的 both 模式会被拒绝。"
---

# 选择原生或 PTC 工具呈现方式

[English](guide.md) | 中文

## 变更

`@deepseek-ai/dsh-tools` 和 `@deepseek-ai/dsh-agent-tool-presentation` 的 `mode` 字段仅接受 `native` 或 `ptc`。`both` 值会被拒绝。这也影响 `DSH_TOOLS_MODE=both`，该环境变量通过随附的 profile 补丁提供工具配置。

`native` 将可见工具公开为直接函数调用。`ptc` 公开 `run_code`，程序通过生成的 SDK 调用可见工具。同一应用中的不同 agent preset 仍可使用不同模式。

## 迁移

1. 在 `cordis.yml`、profile 的 `cordis.patch.yml` 或自定义覆盖文件中，将 `mode: both` 替换为用于直接调用的 `mode: native`，或用于程序调用的 `mode: ptc`。
2. 将 `DSH_TOOLS_MODE=both` 替换为 `DSH_TOOLS_MODE=native` 或 `DSH_TOOLS_MODE=ptc`。若需按 preset 选择，请改为更新该 preset 的 `@deepseek-ai/dsh-agent-tool-presentation` 行。
3. 将调用 `ctx.tools.presentAs('both')` 的代码改为选择 `native` 或 `ptc`。在 PTC 程序中，将调用保留在 `run_code` 内；不要将 SDK 函数名称作为模型的直接工具调用发出。
4. 启动受影响的 profile，确认配置可加载。原生请求公开获准的直接工具；PTC 请求公开 `run_code` 及其 SDK 说明。
