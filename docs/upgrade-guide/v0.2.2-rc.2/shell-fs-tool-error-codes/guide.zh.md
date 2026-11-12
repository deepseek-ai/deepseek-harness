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
| 在没有沙箱执行器的组合中，`bash` 或 `pwsh` 收到 `sandbox_permissions` | `SandboxEscalationError` / `SANDBOX_ESCALATION_UNAVAILABLE` | `ToolArgsError` / `INVALID_ARGS` |
| `enableRunInBackground: false` 时，`bash` 或 `pwsh` 收到 `run_in_background: true` | `JobError` / `JOB_BACKGROUND_DISABLED` | `ToolArgsError` / `INVALID_ARGS` |
| `read_image` 运行在不支持图像输入的模型路由上 | `ImageInputError` / `IMAGE_UNSUPPORTED_MODEL` | `ImageInputError` / `MODEL_DOES_NOT_SUPPORT_IMAGES` |

两个 shell 情形中，被拒绝的参数都没有出现在 schema 里，模型的修正办法是去掉它。这两条 shell 消息现在以 `invalid arguments: ` 开头，模型和对话记录的读者都能看到。`SANDBOX_ESCALATION_UNAVAILABLE` 仍用于组合无法发起审批的情形。

`@deepseek-ai/dsh-jobs` 的 `JOB_ERROR_CODES` 与 `JobErrorCode` 类型删除了 `JOB_BACKGROUND_DISABLED`。`@deepseek-ai/dsh-tool-fs` 的 `ImageInputErrorCode` 用 `MODEL_DOES_NOT_SUPPORT_IMAGES` 替换 `IMAGE_UNSUPPORTED_MODEL`，子 agent 附件与 Session 附件拒绝已在使用这个值。

## 迁移

1. 读取 `tool/result` `error` 的统计或重试规则中，把 `JOB_BACKGROUND_DISABLED` 与 shell 的 `SANDBOX_ESCALATION_UNAVAILABLE` 情形映射为 `INVALID_ARGS`，把 `IMAGE_UNSUPPORTED_MODEL` 映射为 `MODEL_DOES_NOT_SUPPORT_IMAGES`。v0.2.2-rc.2 写入的 Session 日志保留旧值。
2. 替换 TypeScript 中对 `'JOB_BACKGROUND_DISABLED'` 或 `'IMAGE_UNSUPPORTED_MODEL'` 的引用；`pnpm run typecheck` 会报出剩余的引用。
3. 更新那些期望 shell 消息不带 `invalid arguments: ` 前缀的文本匹配。
