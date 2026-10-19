---
kind: upgrade-guide
description: "The sdk-minimal profile now stops model and tool dispatch when session persistence cannot complete a checkpoint."
---

# SDK-minimal requires durable checkpoints

English | [中文](guide.zh.md)

## Change

The `sdk-minimal` profile enables `session-checkpoint-policy`. It waits for session history to flush before model requests, top-level tool execution, and agent steps. Previously these operations could proceed while JSONL writes were buffered; persistence errors could remain background warnings. A checkpoint failure now stops the dependent operation. First-use file-lock initialization is paid before the first model request, and checkpoint writes contribute to request latency. This does not change the Session format or guarantee that forced termination preserves the final unflushed response.

## Migration

1. Keep the selected `dsh_home` writable and allow request deadlines to cover storage initialization and checkpoint writes. A longer shutdown timeout alone does not affect a pre-request checkpoint.
2. Check profile and invocation patches for overrides of `session-checkpoint-policy`. To receive the durability policy, retain its enabled default alongside `sessions`.
3. Run a short SDK turn, close normally, and use `resume_session()` with the same home and session ID to verify restoration. Investigate checkpoint failures before retrying model or tool work; the operation does not run until the checkpoint succeeds.
