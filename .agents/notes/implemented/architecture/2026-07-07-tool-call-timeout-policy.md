# Agent Note: Tool-call timeout policy as a plugin

Status: implemented

English | [中文](2026-07-07-tool-call-timeout-policy.zh.md)

## Problem

The [timeout/deadline Agent Note](2026-07-06-timeout-deadline-library.md) extracted the timing-and-classification primitive into `@deepseek-ai/dsh-timeout`, but timeout policy was still attached to individual capabilities and model-facing schemas. `bash` exposed `timeoutMs`; `web_fetch` exposed `timeout_ms`; `web_search` had no model-facing timeout even though providers already honor `exec.signal`; a future grep/glob tool would either import the timeout library directly or invent its own timeout policy. That is the wrong authoring shape for a plugin SDK: a tool author should normally forward `exec.signal` to the implementation it calls, and deployment policy should decide the budget.

At the same time, not every timeout in the repo is a model-facing tool-call budget. Hooks execute command hooks by calling `ctx.shell` directly, not through `ctx.tools.execute()`, and the `bash` model tool multiplexes foreground execution, background start, background polling, and hook reuse through the same backend. Moving every timeout into a tool plugin in one step would conflate those paths and risk breaking hook timeout semantics.

## Decision

Tool-call timeout is a policy that applies only to model-facing tool execution, in three parts:

- `@deepseek-ai/dsh-timeout` remains the shared library that owns `deadline()` and `timeoutOf()`.
- `@deepseek-ai/dsh-tools` has an around-dispatch waterfall, `tools/execute`, between `tools/pre-execute` and `tools/post-execute`.
- The [repository naming contract](../../archived/architecture/2026-08-11-repository-naming-contract-and-rename-ledger.md) names `@deepseek-ai/dsh-tool-call-timeout-policy` for the exact operation it limits. The plugin reads each tool's declared `timeoutMs` from the runtime and wraps a call that has one by deriving a new `exec.signal`.

The execution pipeline is:

```text
ctx.tools.execute(exec)
  -> tools/pre-execute
  -> tools/execute
       -> registry dispatch (the base next())
            -> tool.execute(args, exec)
            -> thrown tool errors normalize to ToolExecutionResult
  -> tools/post-execute
```

The default behavior is conservative: a tool that declares no `timeoutMs` receives no `TOOL_TIMEOUT` deadline from the plugin.

### The `tools/execute` around-dispatch extension point

`@deepseek-ai/dsh-tools` declares a `tools/execute` waterfall whose base `next()` is the dispatch-with-normalization thunk — the same inner `try`/`catch` that turns a thrown tool (or unknown tool) into an `isError` `ToolExecutionResult`. A listener receives `(exec, next)`: it calls `next()` to delegate to dispatch (returning its result, optionally wrapped) or returns a replacement result to short-circuit dispatch. The whole pipeline still sits inside `execute`'s outer try/catch, so a throwing listener becomes an `isError` result, never a turn failure.

That the catch is the base `next` — not something outside the waterfall — is load-bearing: when a provider sees the timeout signal and throws its own upstream-abort error, registry dispatch first converts it to a normal error result, and only then can `timeout-policy` replace the final result with `TOOL_TIMEOUT`.

### The `timeout-policy` plugin

The plugin is `@deepseek-ai/dsh-tool-call-timeout-policy`, a zero-config function/namespace plugin (`name` / `inject` / `apply`) in the `packages/guard/` group (originally its own `timeout/` group). The per-tool budget is DECLARED on the tool, not on this plugin: a `ToolDefinition` carries an optional `timeoutMs`, which the owning tool plugin sets from its own config. `dsh-tool-web`, for example, resolves `fetchTimeoutMs` / `searchTimeoutMs` (default 30000) onto the `web_fetch` / `web_search` definitions:

```yaml
- id: timeout-policy
  name: '@deepseek-ai/dsh-tool-call-timeout-policy'
- id: tool-web
  name: '@deepseek-ai/dsh-tool-web'
  config:
    fetchTimeoutMs: 30000
    searchTimeoutMs: 30000
```

Timeouts live on tool definitions rather than a free-text name map, eliminating misspelled unused policy. `defineTool` validates a positive finite budget. During dispatch the enforcer derives a deadline signal and assigns it to `exec.signal`; the registry fuses that deadline with the original caller signal before the body under the [tool-cancellation contract](2026-07-19-cooperative-tool-cancellation.md). The enforcer restores the caller signal afterward and converts its own expiry into `TOOL_TIMEOUT`; tools without a budget pass through unchanged.

Signal replacement is by **in-place mutation of `exec.signal`**, not by passing a new object to `next()`. Cordis's waterfall `next()` ignores any arguments handed to it and re-invokes downstream listeners with the shared payload array (`vendor/cordis/src/events.ts`), so mutation is how the wrapper supplies its deadline to the registry. The registry re-fuses the captured caller signal immediately before the body, and the plugin restores `exec.signal` to the caller's original in a `finally` so `tools/post-execute` never sees the plugin's deadline signal.

`timeout-policy` owns both uses of the `TOOL_TIMEOUT` code: the internal deadline code passed to `deadline()`/`timeoutOf()` (scoped so a nested outer deadline reads as an ordinary cancel) and the structured tool-result error code. Its replacement result is:

```ts ignore-check
function toolTimeoutResult(timeoutMs: number): ToolExecutionResult {
  return {
    content: [{ type: 'text', text: `Error: tool call timed out after ${timeoutMs}ms` }],
    isError: true,
    error: {
      message: `tool call timed out after ${timeoutMs}ms`,
      info: { name: 'ToolTimeoutError', code: 'TOOL_TIMEOUT' },
    },
  }
}
```

This is a cooperative deadline. It does not kill arbitrary work by racing the tool promise; the tool or the capability it calls must honor `exec.signal` and reach quiescence. Declaring `timeoutMs` therefore MEANS "this tool is cooperative with `exec.signal`", which the plugin README states as its contract.

No new session event is needed for reconstructability: `TOOL_TIMEOUT` is the final model-facing `tool/result` for that call, so the existing session log already records the content and structured `{ name, code }` error the next model request sees.

### Existing tool adaptation

`web_fetch` and `web_search` are migrated. `dsh-tool-web` keeps ownership of their model-facing schemas, and those schemas expose no timeout knob: `web_fetch` has no `timeout_ms` parameter, while `web_search` accepts a required `queries` array without a timeout argument. The tool bodies do not import `@deepseek-ai/dsh-timeout`; they forward `exec.signal` to `ctx.web`.

`dsh-web-fetch-http` keeps one configured provider-level `timeoutMs` as a large resource backstop for direct `ctx.web.fetch()` callers and misconfigured deployments; it owns no model-facing timeout. When a `TOOL_TIMEOUT` signal reaches the fetch provider first, provider-scoped classification treats it as upstream `WEB_ABORTED`, and the outer `tools/execute` wrapper replaces the final tool result with `TOOL_TIMEOUT`. A shipped web-tool deployment configures the provider backstop above the `timeout-policy` budget so the tool-call policy normally wins for model calls.

`bash` stays on the current backend timeout path. `dsh-tool-bash` continues to expose `timeoutMs` and `run_in_background`; `dsh-bash-local` continues to use `@deepseek-ai/dsh-timeout` for `BASH_TIMEOUT`; hook bridges continue to call `runHook()` and pass `timeoutMs` through `ctx.shell`. This keeps foreground/background/hook behavior stable.

`read`, `write`, `edit`, `todo_write`, `job_list`, and `job_kill` do not opt into tool-call timeout. `job_output` owns its bounded wait because a wait timeout is a successful live-status result, not a tool failure.

A future model-facing grep/glob tool can be implemented on top of `ctx.shell` without importing `@deepseek-ai/dsh-timeout`: it forwards `exec.signal` to `ctx.shell`, and declares its own `timeoutMs` (from its plugin's config) for the enforcer to apply. If bash-local's backend timeout becomes a problem for such a tool, the bash seam can later add a caller-owned-deadline mode; that is a separate decision.

## Alternatives considered

**Name the plugin `tool-timeout`.** The literal Agent Note name matched the `gen-tool-catalog` completeness guard's `packages/*/tool-*` glob, which requires every match to register a model-facing tool. This plugin registers none — it is a `tools/execute` wrapper — so a `tool-*` name would either fail `verify-tool-catalog` or force a misleading boot entry. The package is `@deepseek-ai/dsh-tool-call-timeout-policy` in what was then a new `timeout/` group, since folded into `packages/guard/`; the cordis.yml `id` can still be `timeout-policy`.

**Keep per-tool timeout handling only.** This was the shape for `bash` and `web_fetch`, and it matches Claude Code and Codex for shell commands. It loses for web-style tools because every new timeout-capable tool must choose validation, cap semantics, docs, snapshots, and classification. The plugin centralizes policy and classification while leaving each tool's schema focused on business input.

**Move all timeout policy out of bash-local immediately.** Cleaner long-term — bash-local would become a pure subprocess executor and all callers would own their deadlines. It loses as the first step because hooks call `ctx.shell` directly and the bash model tool has foreground/background semantics that are not the same tool-call lifetime. Keeping `BASH_TIMEOUT` preserves those paths while tool-call timeout proves itself on simpler tools.

**Use a global default budget for every tool.** Convenient, but it surprises tool authors: any tool that accidentally runs longer than the global budget would start failing once the plugin loads. A per-tool declared budget makes adoption deliberate.

**Expose a model-facing `timeout_ms` override.** Claude Code's `WebFetch`/`WebSearch` and Codex's web tools keep timeout out of the model-call shape. A model override would make timeout part of prompt semantics and force schema/argument-stripping rules into `timeout-policy`. Web timeout stays deployment policy only.

**Let `timeout-policy` match tool arguments itself.** A rule engine such as "disable timeout when `bash.run_in_background` is true" would make the policy plugin know tool-specific argument semantics. Avoided by not migrating bash to tool-call timeout.

**Use `tools/pre-execute` plus `tools/post-execute` instead of a new around-dispatch extension point.** A pre listener could arm a deadline and mutate `exec.signal`; a post listener could classify and replace. That loses because the deadline lifetime would cross two independent waterfalls: a call-id map, cleanup on every pre-deny/tool-throw/post-throw/dispose path, and ordering rules with every other listener. `tools/pre-execute` is also the allow/deny gate, not an execution wrapper. `tools/execute` gives the timeout one lexical scope: arm, delegate, classify, dispose.

**Use `Promise.race` to enforce timeouts for non-cooperative tools.** Rejected for the same reason as the timeout-library Agent Note: it returns control to the caller while the underlying process, fetch, or provider operation may still be running. The plugin only sends a signal; termination remains the implementation's responsibility.

## Consequences

- `@deepseek-ai/dsh-tools` gains an around-dispatch surface after the interception points deliberately split pre/post tool hooks. Its contract is narrow — wrap registry dispatch, not replace the pre-gate or post-result policy — and the base `next()` is dispatch-with-normalization so a wrapper never sees a raw tool throw.
- Multiple `tools/execute` listeners compose by ordinary Cordis waterfall order: a listener that calls `next()` wraps downstream listeners plus dispatch; one that returns without `next()` short-circuits them. A deployment combining timeout with a future retry/sandbox/metrics wrapper chooses semantics by registration order ("timeout covers the whole retry" vs "timeout covers each attempt").
- Opt-in by declaration is a deliberate misconfiguration risk: a tool can declare a `timeoutMs` without honoring `exec.signal`, and that tool will not stop on timeout. The registry awaits that non-quiescent body rather than racing it, while the plugin contract states that declaring a budget means cooperative; the web tools prove the pattern on tools that already forward the signal.
- During the transition `bash` and the migrated web tools use different timeout paths on purpose: `TOOL_TIMEOUT` is the model-facing tool-call budget, while `BASH_TIMEOUT` remains the bash backend timeout used by bash and hooks.
