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
| `bash` or `pwsh` receives `sandbox_permissions` in a composition without a sandboxing executor | `SandboxEscalationError` / `SANDBOX_ESCALATION_UNAVAILABLE` | `ToolArgsError` / `INVALID_ARGS` |
| `bash` or `pwsh` receives `run_in_background: true` with `enableRunInBackground: false` | `JobError` / `JOB_BACKGROUND_DISABLED` | `ToolArgsError` / `INVALID_ARGS` |
| `read_image` runs on a model route without image input | `ImageInputError` / `IMAGE_UNSUPPORTED_MODEL` | `ImageInputError` / `MODEL_DOES_NOT_SUPPORT_IMAGES` |

In both shell cases the schema does not advertise the rejected argument, so the model's fix is to drop it. Both shell messages now start with `invalid arguments: `, which the model and transcript readers see. `SANDBOX_ESCALATION_UNAVAILABLE` remains for compositions that cannot route an approval.

`JOB_BACKGROUND_DISABLED` is removed from `JOB_ERROR_CODES` and the `JobErrorCode` type in `@deepseek-ai/dsh-jobs`. `ImageInputErrorCode` in `@deepseek-ai/dsh-tool-fs` replaces `IMAGE_UNSUPPORTED_MODEL` with `MODEL_DOES_NOT_SUPPORT_IMAGES`, the value subagent attachments and Session attachment rejections already use.

## Migration

1. In analytics or retry rules that read `tool/result` `error`, map `JOB_BACKGROUND_DISABLED` and the shell `SANDBOX_ESCALATION_UNAVAILABLE` case to `INVALID_ARGS`, and `IMAGE_UNSUPPORTED_MODEL` to `MODEL_DOES_NOT_SUPPORT_IMAGES`. Session logs written by v0.2.2-rc.2 keep the old values.
2. Replace TypeScript references to `'JOB_BACKGROUND_DISABLED'` or `'IMAGE_UNSUPPORTED_MODEL'`; `pnpm run typecheck` reports any that remain.
3. Update text matchers that expect the shell messages without the `invalid arguments: ` prefix.
