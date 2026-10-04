# Agent Note: PTC mode collapses the executor, not just the wire

Status: implemented
Archived: 2026-09-30

English | [中文](2026-08-07-ptc-executor-collapse.zh.md)

## Problem

`mode: 'ptc'` collapsed only the announcement surface, not the execution surface. `wireSchemas()` sent the model exactly one tool — `run_code` — but the executor resolved every call through `get()`, which returns the full visible map plus the reserved transport. A model that emitted a native tool name (`write`, `read`, `bash`, `subagent`, …) bypassed `run_code` entirely: the call traversed the normal pipeline and executed, even though no schema for it had ever been advertised. Providers do not intercept unadvertised tool names, so schema omission enforced nothing.

The package contract names this exact anti-pattern: schema omission is not enforcement when a direct caller can bypass it; denial must be tested through the executor.

## Decision

`ToolRuntime` resolves callable definitions through a new private `resolveExecution(name, scope, nested)` that applies the mode collapse at the operation boundary that owns it. When `modeFor(scope)` resolves to `ptc`, a model-direct call (`nested = false`) may only name the reserved `run_code` transport; every native name resolves to `undefined` and surfaces as the executor's existing `UNKNOWN_TOOL` error, whose message names the route back through `run_code` because the name IS declared to this model (an already-aborted caller signal keeps the cancellation contract: `ABORTED_BEFORE_DISPATCH`, with the visible tool's finalizer applied). The effective scope mode includes declarations inherited from an agent preset, so its wire schema and execution permissions remain aligned. A collapsed call terminates at `createExecution` — the first stage of `prepare` — BEFORE the extensible policy pipeline, so `tools/pre-execute` listeners, approval `ask`, and guards never observe a call that is deterministically denied; a human is never prompted to approve it. A nested sub-dispatch (`nested = true` — a `parent` token set, which only the `run_code` SDK binding sets in production code) may call any visible tool, so programs keep every binding the generated SDK declared.

Four execution-path lookups — `executionMode`, `dispatchToolBody`, `postExecute`, `normalizeDispatchResult` — go through `resolveExecution`. `createExecution` applies the same collapse via the shared `collapses(name, nested)` predicate so it can distinguish a collapsed call from a genuinely unknown name before the policy pipeline. The public registry view (`get`) and SDK projection (`schemas`) keep their semantics: presentation, inspection, and binding enumeration still see the full visible set. The wire (`wireSchemas`) and the executor now agree. A collapsed call with non-JSON-serializable arguments reports the parameter `TypeError` (the invalid-args contract), not `UNKNOWN_TOOL` — the body still never runs and policy still does not.

The collapse is a security-relevant invariant, so acceptance is pinned through the executor: a model-direct native call under `ptc` returns `UNKNOWN_TOOL`, the same tool via an SDK sub-dispatch succeeds, and `native`/`both` direct calls plus `run_code` itself are unchanged. The base [PTC mode foundation](../feature/2026-06-15-ptc.md) owns the transport design this note layers the execution boundary onto.

## Alternatives considered

### Filter `get()` / the registry view by mode

The view is consumed by presenters, `tool-cordis` inspection, and the SDK binder; collapsing it would hide from the program surface tools that must still bind, and would change the public resolution contract for every consumer, not just the executor.

### Filter at the agent-loop entry

The loop is not the only executor caller, and the distinction that matters (model-direct vs transport sub-dispatch) rides on the execution input, not at the loop boundary. An entry filter would also re-enable PTC mode semantics the registry already owns.

### Reject via a shipped guard

Guards are an optional plugin extension; a security invariant must not depend on a deployment composing the right plugin. The registry owns the mode decision and must enforce it itself.

### Keep schema omission only (status quo)

No provider guarantees interception of unadvertised names; the reported session proves it does not happen.

## Consequences

- `mode: 'ptc'` now enforces what it announces: a model-direct native call becomes `UNKNOWN_TOOL`, which the model can correct by routing through `run_code` (a pre-aborted call still resolves `ABORTED_BEFORE_DISPATCH`, per the cancellation contract).
- `both` and `native` behavior is unchanged; SDK sub-dispatches are unchanged (the `parent` token is the discriminator).
- A collapsed call is rejected at `prepare`, BEFORE the extensible policy pipeline: pre-execute listeners, approval `ask`, and guards never observe it. `executionMode` also fails closed (`exclusive`), so scheduling has no observable difference.
- Native-tool guidance sections (`tool:read`, `tool:write`, `tool:bash`, etc.) remain in the system prompt because they describe capabilities available through the generated SDK as well as native function calls, and several carry cross-tool routing policy (`read` over `bash cat`, `read` before `write` for the default fs-observation-policy, `subagent` over `workflow`) that no single tool description can hold. The executor collapse, not prompt filtering, prevents model-direct native calls.
- The prompt STATES the collapse, in the `tools:ptc-only` section ordered ahead of first-party per-tool guidance. Those sections name their tool without qualifying how it is reached, so a model that read only them emitted a native call, received `UNKNOWN_TOOL` for a tool the same prompt declared, and concluded the deployment was inconsistent rather than correcting itself. The denial carries the route for the same reason. The TypeScript SDK section repeats the distinction next to the generated declarations, labels them as program-only bindings, and states that only separately supplied tool schemas grant direct-call availability. Because the declaration list can otherwise be read as native tool availability, the section emits a complete `run_code` call around `tools.bash(...)` when the current `bash` parameter schema accepts the example arguments. `both` renders the rule empty: its native calls do execute, so stating it there would be false — which is why `both-mode-turn` no longer shares `ptc-turn`'s expected prompt.
- Any future composite transport that sets a `parent` token opts its sub-dispatches into the full table, matching the nested-call semantics the token already documents.
