---
kind: upgrade-guide
description: "Python PTC compositions require sandbox services, and direct Python file operations follow the resolved file policy."
---

# Python PTC applies the shared file sandbox

English | [中文](guide.zh.md)

## Change

`@deepseek-ai/dsh-experimental-ptc-runtime-python` requires `sandbox` and `sandboxPolicy`. Previously, direct Python file operations ran without confinement and the provider rejected explicit `sandboxPolicy` inputs. It now applies the shared policy to each program and reports confinement in `PtcRunResult.sandbox`. A restricted run fails with `sandbox-unavailable` when confinement cannot be established.

This affects custom compositions that select the Python runtime. Shipped profiles continue to use the Node runtime. Python remains local to macOS or Linux; its configured resource budgets and unsupported per-call timeout overrides remain unchanged.

## Migration

1. In the `cordis.yml` or profile patch that selects the Python runtime, retain the existing shared sandbox services. If they are absent, mount `@deepseek-ai/dsh-sandbox-local` and `@deepseek-ai/dsh-sandbox-policy` with its required `@deepseek-ai/dsh-session-projection` service. See the [Python runtime requirements](../../../../packages/experimental/ptc-runtime-python/README.md#use-this-package).
2. Set the shared `sandbox-policy` row's `mode` and `workspaceRoot` for agentless calls. Its default mode is `read-only`; `workspace-write` permits workspace writes. PTC tool calls use the Session's resolved policy and directory. Do not add a separate Python-only sandbox setting.
3. Direct service callers use `runtime.run(runtime.resolve(request))`; pass a trusted `sandboxPolicy` only when an explicit override is required. Model-facing `run_code` uses the existing approval flow for a one-call wider mode, without changing nested tools' permissions or replaying the program automatically.
4. Verify a program can write inside the intended workspace under `workspace-write`, fails to write outside it, and returns `result.sandbox.mode` and `result.sandbox.enforcement`. Under `read-only`, direct file writes fail. Inspect `sandbox-unavailable` separately from a denied file operation and repair the local sandbox installation before retrying.
