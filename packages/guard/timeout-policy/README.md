---
description: "Cooperative time limit for cancellation-aware tool calls, mapping a settled timeout to a clear model error for users and maintainers choosing or debugging the plugin."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-call-timeout-policy

English | [中文](README.zh.md)

## Summary

A tool call can hang for a long time — a slow web fetch, a search that never returns — and without a limit the model waits indefinitely, stalling the whole session. `dsh-tool-call-timeout-policy` arms a cooperative deadline for calls that declare a limit: it asks the tool to stop through `exec.signal`, then maps a settled cancellation to a clear `Error: tool call timed out after <ms>ms` result. A tool that ignores or slowly handles cancellation keeps the caller waiting until it settles; the plugin never hard-stops downstream work. The limit comes from each tool's own configuration, so the plugin itself is zero-config, and it ships enabled in the `dsh` base bundle.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

The common path is one line: add the plugin to the composition — the `dsh` base bundle already has it. Tools that have a limit configured are protected automatically; every other tool is untouched.

### When to choose it

Choose it when the model calls tools that can take a long time, those tools honor `exec.signal`, and you want a predictable timed-out answer after cancellation settles. Avoid it when a tool must be hard-stopped at its limit — the plugin can only ask a tool to stop, so a tool that ignores cancellation keeps running and keeps the caller waiting — and when you want one default limit for every tool, because each tool's limit comes from that tool's own configuration.

### Setting it up

Mount the plugin with no configuration:

```yaml
- name: '@deepseek-ai/dsh-tool-call-timeout-policy'
```

The limit is set where the tool is configured. For example, `dsh-tool-web`'s `fetchTimeoutMs`/`searchTimeoutMs` settings (default 30,000 ms) put the limit on `web_fetch` and `web_search`. Tools without a limit — the shipped `bash`, `read`, `write`, and `edit` — are never cut off. The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-tool-web) lists the tool settings that produce limits.

### What you get

When the deadline fires, the plugin aborts the derived `exec.signal`. After downstream code honors cancellation and `next()` settles, the model receives `Error: tool call timed out after <ms>ms` as an error result, so it can decide to retry, adjust, or give up. A tool that ignores or slowly handles the signal keeps the caller waiting and produces no timeout result until it settles; calls that finish in time are unchanged.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains how the plugin arms a deadline around each dispatch and maps it to the `TOOL_TIMEOUT` result, and points at the code that realizes it; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design philosophy

The wrapper is built on four commitments:

- **Enforcement home, not a library.** `dsh-timeout` owns timing and classification (`deadline`, `timeoutOf`); this plugin owns the per-call wiring over `tools/execute`; each capability owns termination. The split is recorded in the [timeout-deadline-library Agent Note](../../../.agents/notes/implemented/architecture/2026-07-06-timeout-deadline-library.md).
- **The tool declares its own budget.** `timeoutMs` lives on the tool's `ToolDefinition`, read from the registry (`ctx.tools.get(exec.name, exec.agent)?.timeoutMs`), so a mistyped tool name is impossible and undeclared tools delegate untouched.
- **Scoped classification.** `TOOL_TIMEOUT` serves as both the internal `deadline` classification code and the structured error `code`; scoping `timeoutOf` to it keeps a nested outer deadline (another wrapper's timer that fired first) from being misread as this plugin's timeout — it reads as an ordinary upstream cancel.
- **Signal swap, then restore.** Cordis `next()` ignores passed arguments, so the wrapper mutates the shared `exec` in place: it swaps the derived deadline signal onto `exec` for dispatch and restores the caller's signal in a `finally`, so `tools/post-execute` listeners never see this plugin's possibly-aborted signal.

### How a deadline is armed and mapped

One `tools/execute` listener reads the dispatched tool's declared limit from the registry (`ctx.tools.get(exec.name, exec.agent)?.timeoutMs`); a tool without a limit delegates untouched. For a limited tool, `deadline(exec.signal, timeoutMs, TOOL_TIMEOUT)` builds a fused signal that the wrapper swaps onto `exec` for dispatch and restores in a `finally`, so `tools/post-execute` listeners never see the derived signal. When the wrapper's own timer fired — `timeoutOf(d.signal, 'TOOL_TIMEOUT')` scoped by the code, so a nested outer deadline reads as an ordinary upstream cancel — the dispatched result, already normalized into an error result by dispatch, is replaced with the structured result: `isError: true`, content `Error: tool call timed out after <ms>ms`, and error info `{ name: 'ToolTimeoutError', code: 'TOOL_TIMEOUT' }`.

### Composing with other wrappers

Multiple `tools/execute` listeners compose by Cordis registration order, which chooses the semantics: the timeout registered outer covers a whole retry operation, the timeout registered inner covers each attempt.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `TOOL_TIMEOUT`, `name`/`inject`/`apply`, the `tools/execute` wrapper |
| — | No runtime invariant companion is published; this stateless policy plugin owns no package-local event history or mutable data relation beyond the seam it intercepts. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the tool-call pipeline to the timeout-library split, the enforced limits, and the guard group map.

- [Tools subsystem reference](../../../docs/subsystems/tools.md) — the `tools/execute` waterfall and decision shapes this wrapper hooks.
- [Timeout deadline library Agent Note](../../../.agents/notes/implemented/architecture/2026-07-06-timeout-deadline-library.md) — the timing/termination split and why the deadline only notifies.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-tool-web) — `dsh-tool-web`'s `fetchTimeoutMs`/`searchTimeoutMs` budgets the policy enforces.
- [guard group map](../README.md) — the sibling guard packages and the loop-hygiene family.

-----

<a id="model-experience"></a>
## Model Experience

### Conditional tool result

#### What the model sees

This plugin adds no prompt or schema. If a declared deadline wins and downstream cancellation settles, it replaces the provider's outcome with `Error: tool call timed out after <ms>ms` plus the structured `TOOL_TIMEOUT` error; otherwise the original result passes through unchanged. A downstream call that never settles cannot produce a timeout result.

#### Token effect

Zero tokens on non-timeout calls. A timeout adds one small retained error result and can prevent a larger late provider result from entering context.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when the policy is a poor fit. They are current package constraints, not a task backlog.

- **Cooperative, never a hard kill** — the deadline only notifies via `exec.signal`; a tool that ignores the signal does not stop on timeout, the wrapper remains inside `await next()`, and the model receives no timeout result until downstream settles.
- **No blanket budget** — only tools that declare `timeoutMs` on their `ToolDefinition` get a deadline; undeclared tools (the shipped `bash`, `read`, `write`, and `edit` declare none) have no registry-wide default.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open questions and directions that are not decided. It is explicitly non-authoritative — shipped behavior, limits, and accepted rationale live in the sections above, the package code, and the linked Agent Notes.

The `src/index.ts` FIXME asks to settle a `@deepseek-ai/dsh-timeout-guard` rename; the [naming ledger](../../../.agents/notes/implemented/architecture/2026-08-11-repository-naming-contract-and-rename-ledger.md) already records `@deepseek-ai/dsh-tool-call-timeout-policy` as the decided name, so the FIXME is stale pending a code cleanup.

</details>
