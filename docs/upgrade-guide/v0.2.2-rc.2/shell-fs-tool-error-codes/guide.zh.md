---
kind: upgrade-guide
description: "bash 与 pwsh 把 schema 未公开的 sandbox_permissions 与 run_in_background 报为 ToolArgsError，删除 JOB_BACKGROUND_DISABLED，read_image 改报 MODEL_DOES_NOT_SUPPORT_IMAGES 而非 IMAGE_UNSUPPORTED_MODEL。"
---

# Shell 与 read_image 的失败改用统一的错误 code

[English](guide.md) | 中文

## 变更

v0.2.2-rc.2 记录的三种 `tool/result` 错误标识发生变化：

| 失败 | v0.2.2-rc.2 | 现在 |
| --- | --- | --- |
| 在没有沙箱执行器的组合中，`bash` 或 `pwsh` 收到 `sandbox_permissions` 与 `justification` | `SandboxEscalationError` / `SANDBOX_ESCALATION_UNAVAILABLE` | `ToolArgsError` / `INVALID_ARGS` |
| `enableRunInBackground: false` 时，`bash` 或 `pwsh` 收到 `run_in_background: true` | `JobError` / `JOB_BACKGROUND_DISABLED` | `ToolArgsError` / `INVALID_ARGS` |
| `read_image` 运行在不支持图像输入的模型路由上 | `ImageInputError` / `IMAGE_UNSUPPORTED_MODEL` | `ImageInputError` / `MODEL_DOES_NOT_SUPPORT_IMAGES` |

两个 shell 情形中，被拒绝的参数都没有出现在 schema 里，模型的修正办法是去掉它。在没有沙箱后端时，若 `bash`、`pwsh`、`write`、`edit` 或 `apply_patch` 只收到 `sandbox_permissions` 与 `justification` 之一，此前会在配对校验中以 `SandboxEscalationError` / `SANDBOX_ESCALATION_INVALID_ARGUMENT` 失败；现在同样报 `INVALID_ARGS`。这些调用会在任何审批请求之前被拒绝。

shell 消息现在以 `invalid arguments: ` 开头，升权消息同时点名两个字段：`invalid arguments: sandbox_permissions and justification are not available in this composition (no sandboxing executor to escalate)`。对于有沙箱执行器、但缺少审批服务、调用方 Agent 或审批通道的组合，`SANDBOX_ESCALATION_UNAVAILABLE` 的含义不变。

`@deepseek-ai/dsh-jobs` 的 `JOB_ERROR_CODES` 与 `JobErrorCode` 类型删除了 `JOB_BACKGROUND_DISABLED`。`@deepseek-ai/dsh-tool-fs` 的 `ImageInputErrorCode` 用 `MODEL_DOES_NOT_SUPPORT_IMAGES` 替换 `IMAGE_UNSUPPORTED_MODEL`，子 agent 附件与 Session 附件拒绝已在使用这个值。

## 迁移

1. 读取 `tool/result` `error` 的统计或重试规则中，把 v0.2.2-rc.2 的 `JOB_BACKGROUND_DISABLED` 结果视为 `INVALID_ARGS`，把 `IMAGE_UNSUPPORTED_MODEL` 视为 `MODEL_DOES_NOT_SUPPORT_IMAGES`。仅凭 `error` 无法从 `SANDBOX_ESCALATION_UNAVAILABLE` 中分出 shell 情形：只有 v0.2.2-rc.2 的 `bash` 或 `pwsh` 结果的消息含 `no sandboxing executor to escalate` 时，才视为 `INVALID_ARGS`；其余 `SANDBOX_ESCALATION_UNAVAILABLE` 结果保持原义。Session 日志保留写入时的值。
2. 替换 TypeScript 中对 `'JOB_BACKGROUND_DISABLED'` 或 `'IMAGE_UNSUPPORTED_MODEL'` 的引用；`pnpm run typecheck` 会报出剩余的引用。
3. 更新那些期望旧 shell 消息的文本匹配：旧消息没有 `invalid arguments: ` 前缀，且只点名 `sandbox_permissions`。
