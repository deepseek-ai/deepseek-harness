---
kind: upgrade-guide
description: "bash and pwsh report unadvertised sandbox_permissions and run_in_background as ToolArgsError, JOB_BACKGROUND_DISABLED is removed, and read_image reports MODEL_DOES_NOT_SUPPORT_IMAGES instead of IMAGE_UNSUPPORTED_MODEL."
---

# Shell and read_image failures use consolidated error codes

English | [中文](guide.zh.md)

## Change

Three `tool/result` error identities recorded by v0.2.2-rc.2 change:

| Failure | v0.2.2-rc.2 | Now |
| --- | --- | --- |
| `bash` or `pwsh` receives `sandbox_permissions` and `justification` in a composition without a sandboxing executor | `SandboxEscalationError` / `SANDBOX_ESCALATION_UNAVAILABLE` | `ToolArgsError` / `INVALID_ARGS` |
| `bash` or `pwsh` receives `run_in_background: true` with `enableRunInBackground: false` | `JobError` / `JOB_BACKGROUND_DISABLED` | `ToolArgsError` / `INVALID_ARGS` |
| `read_image` runs on a model route without image input | `ImageInputError` / `IMAGE_UNSUPPORTED_MODEL` | `ImageInputError` / `MODEL_DOES_NOT_SUPPORT_IMAGES` |

In both shell cases the schema does not advertise the rejected argument, so the model's fix is to drop it. When only one of `sandbox_permissions` and `justification` reaches `bash`, `pwsh`, `write`, `edit`, or `apply_patch` without a sandboxing backend, the call previously failed the pairing check with `SandboxEscalationError` / `SANDBOX_ESCALATION_INVALID_ARGUMENT`; it now reports `INVALID_ARGS` as well. These calls are rejected before any approval request.

The shell messages now start with `invalid arguments: `, and the escalation message names both fields: `invalid arguments: sandbox_permissions and justification are not available in this composition (no sandboxing executor to escalate)`. `SANDBOX_ESCALATION_UNAVAILABLE` keeps its meaning for compositions that have a sandboxing executor but no approval service, calling Agent, or approval channel.

`JOB_BACKGROUND_DISABLED` is removed from `JOB_ERROR_CODES` and the `JobErrorCode` type in `@deepseek-ai/dsh-jobs`. `ImageInputErrorCode` in `@deepseek-ai/dsh-tool-fs` replaces `IMAGE_UNSUPPORTED_MODEL` with `MODEL_DOES_NOT_SUPPORT_IMAGES`, the value subagent attachments and Session attachment rejections already use.

## Migration

1. In analytics or retry rules that read `tool/result` `error`, treat v0.2.2-rc.2 `JOB_BACKGROUND_DISABLED` results as `INVALID_ARGS` and `IMAGE_UNSUPPORTED_MODEL` as `MODEL_DOES_NOT_SUPPORT_IMAGES`. For `SANDBOX_ESCALATION_UNAVAILABLE`, `error` alone does not identify the shell case: treat a v0.2.2-rc.2 `bash` or `pwsh` result as `INVALID_ARGS` only when its message contains `no sandboxing executor to escalate`, and keep every other `SANDBOX_ESCALATION_UNAVAILABLE` result unchanged. Session logs keep the values they were written with.
2. Replace TypeScript references to `'JOB_BACKGROUND_DISABLED'` or `'IMAGE_UNSUPPORTED_MODEL'`; `pnpm run typecheck` reports any that remain.
3. Update text matchers that expect the earlier shell messages, which had no `invalid arguments: ` prefix and named only `sandbox_permissions`.
