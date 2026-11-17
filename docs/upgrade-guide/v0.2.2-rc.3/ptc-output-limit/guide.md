---
kind: upgrade-guide
description: "PTC display-output overflow truncates output while execution continues."
---

# PTC output truncation

English | [中文](guide.zh.md)

## Change

The Node PTC runtime discards subsequent display output after `maxOutputBytes` is exhausted and continues execution under the original timeout and cancellation rules. Truncation alone no longer terminates the process or clears retained variables. This also applies to environment initialization.

`PtcRunResult.outputTruncated` marks truncated captured output or diagnostics independently of `error`. A later exception, timeout or cancellation keeps its actual failure kind. Required JSON completion values take priority over captured output and remain lossless; a completion that cannot fit still fails with `output-limit`.

`run_code` and tools created by `createRunCodeTool` return success when the program completes normally, with `outputTruncated: true` and a visible truncation notice. Failed runs retain their usual error codes and mention truncation. Historical Session records remain unchanged.

## Migration

1. Treat truncation as incomplete output, not evidence that execution stopped. Read current state for missing information; do not repeat completed actions merely to recover logs.
2. Update runtime consumers to inspect `outputTruncated` separately from `error`. A successful required completion value remains complete even if captured output was truncated.
3. Update custom Node bootstrap deployments together with the host: the private protocol revision is 5 and includes output suppression without cancellation. Bootstraps announcing revision 3 or 4 are rejected before program dispatch.
4. Verify actions before and after output overflow both complete, retained variables survive, and later exceptions, timeouts and cancellation still report their original outcomes. To display a CUA screenshot, use `inspect(await window.getScreenshot())`.
