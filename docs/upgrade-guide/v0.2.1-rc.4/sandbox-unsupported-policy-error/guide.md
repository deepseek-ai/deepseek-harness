---
kind: upgrade-guide
description: "The sandbox package removes SandboxUnsupportedPolicyError; Windows processes ignore additional writable roots."
---

# Remove SandboxUnsupportedPolicyError imports

English | [中文](guide.zh.md)

## Change

`@deepseek-ai/dsh-sandbox` no longer exports `SandboxUnsupportedPolicyError`. Windows subprocess confinement ignores additional writable directories instead of rejecting execution with `SANDBOX_UNSUPPORTED_POLICY`. The harness `write` and `edit` tools still honor those directories; Windows processes retain workspace and private-temp access under `workspace-write`.

## Migration

1. Remove imports and error handlers specific to `SandboxUnsupportedPolicyError` or `SANDBOX_UNSUPPORTED_POLICY`.
2. Use the harness file tools for writes to additional directories on Windows. Do not assume a successful process launch grants those directories.
3. Rebuild the consumer and verify that workspace commands run while extra directories remain accessible only through the file tools.
