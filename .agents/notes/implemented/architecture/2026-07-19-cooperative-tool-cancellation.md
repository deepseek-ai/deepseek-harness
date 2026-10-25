# Agent Note: Cooperative tool cancellation at the registry boundary

Status: implemented

English | [中文](2026-07-19-cooperative-tool-cancellation.zh.md)

## Problem

Every typed tool invocation needs a caller-owned cancellation signal. An optional `ToolExecutionInput.signal` lets direct callers omit ownership, makes `exec.signal` optional in every tool body, and encourages registry fallbacks that cannot represent the caller's actual lifetime.

The pipeline also has different mutability needs at different stages. Tool implementations, pre-policy, post-policy, and result observers only borrow cancellation state, while an around-dispatch wrapper must temporarily replace the signal to add a deadline or another lexical cancellation scope. One mutable public type either grants mutation too broadly or prevents that composition.

Cancellation can arrive before policy, during approval, inside an around-dispatch wait, after a tool body starts, or while post-policy waits. One undifferentiated `ABORTED` result cannot tell durable consumers whether body side effects were possible. Racing a tool promise against cancellation is not a safe fallback because abandoned same-process work continues after the registry reports completion.

## Decision

`ToolExecutionInput.signal` is a required readonly `AbortSignal`. `ToolExecution.signal` and `ToolRunContext.signal` are therefore required and readonly as well. Every typed caller supplies the signal it owns; the registry provides no overload, default controller, never-abort sentinel, or convenience execution path.

`ToolDefinition.execute(args, exec)` keeps its existing signature. `defineTool()` contextually types `exec.signal` as a required `AbortSignal`, so every registered TypeScript tool can observe or forward cancellation without a cast. First-party direct callers and nested PTC mode dispatches pass their current operation signal explicitly.

The registry trusts this typed same-process contract. It does not perform runtime `AbortSignal` validation or add hostile-input tests for an omitted or malformed signal. Validation remains at parser/config, model/tool JSON, durable/file, worker, process, and wire boundaries; untyped JavaScript that violates the TypeScript interface has no compatibility contract.

### Mutability follows the pipeline stage

`ToolDispatchExecution` is identical to `ToolExecution` except that its required `signal` is mutable. Only the `tools/execute` waterfall receives this type. Pre-policy, post-policy, result observers, guards, and tool implementations receive readonly views of a private registry-owned mutable run object.

An around-dispatch wrapper may replace `exec.signal` for its delegated lifetime but cannot typefully delete it or assign `undefined`. The registry captures the required caller signal outside that mutable object, fuses every wrapper replacement with the caller signal immediately before body invocation, removes dispatch-scoped listeners after settlement, and restores the required upstream signal unconditionally.

### Cancellation codes record whether dispatch occurred

`dsh-tools` exports `TOOL_ABORTED = 'ABORTED'` and `TOOL_ABORTED_BEFORE_DISPATCH = 'ABORTED_BEFORE_DISPATCH'`. The registry records body invocation immediately before calling `ToolDefinition.execute()`.

`ABORTED_BEFORE_DISPATCH` carries `{ name: 'AbortError' }` and model text `Error: tool call aborted before dispatch`. It applies whenever cancellation prevents body invocation, including pre-aborted entry, cancellation during pre-policy or approval, an aborted wrapper signal, a wrapper success overtaken by caller cancellation before delegation, and agent-loop siblings skipped after turn cancellation.

`ABORTED` carries model text `Error: tool call aborted` and applies only after the body was invoked, including cancellation while an around wrapper or post-policy listener waits after body completion. A denial, wrapper failure, tool failure, or post-policy failure remains more specific than generic cancellation. A timeout owned by timeout-policy remains `TOOL_TIMEOUT`, and contexts deferred before a successful outcome is replaced remain attached.

### Pre-aborted entry short-circuits after materialization

The registry first creates the call token, snapshots the visible definition's optional final-content callback, and losslessly snapshots and freezes the arguments. An argument-materialization failure wins even when the caller signal is already aborted. Before final content, the registry also losslessly snapshots the candidate result and converts a result-snapshot failure into an ordinary error, so the callback can still enforce its content invariant. After successful argument materialization, a pre-aborted signal skips `tools/pre-execute`, approval, `tools/execute`, `tools/post-execute`, and the tool body, then passes `ABORTED_BEFORE_DISPATCH` through that content-only callback before publishing exactly one frozen authoritative `tools/result`.

### Started work still reaches quiescence

Once a tool body starts, the registry awaits it. Cancellation reaches the body through the fused signal but never races or abandons its promise. A cooperative implementation stops or forwards cancellation and settles after its owned work reaches quiescence; an uncooperative same-process implementation can keep the registry pending indefinitely. Process, worker, network, and provider layers retain responsibility for their own termination mechanisms.

This decision requires cancellation at the tool invocation boundary only. Making signals required on asynchronous capabilities reachable from tool bodies is a separate migration proposed in [Required cancellation through tool-reachable capability seams](../../proposed/architecture/2026-07-19-required-cancellation-through-tool-capability-seams.md).

## Verification

[`execution-signal-types.spec.ts`](../../../../packages/core/tools/tests/execution-signal-types.spec.ts) proves the required exact signal types, readonly observer and tool views, mutable-but-required around-dispatch view, and `defineTool()` inference. [`tools.spec.ts`](../../../../packages/core/tools/tests/tools.spec.ts) covers pre-aborted materialization, phase skipping, policy and wrapper races, body invocation classification, caller-signal fusion, error precedence, context retention, and quiescent drainage. [`tool-calls.spec.ts`](../../../../packages/core/agent-loop/tests/tool-calls.spec.ts) and [`contract-regressions.spec.ts`](../../../../packages/core/agent-loop/tests/contract-regressions.spec.ts) cover balanced durable results for undispatched siblings. [`ptc.spec.ts`](../../../../packages/core/tool-executor-ptc/tests/ptc.spec.ts) and first-party integration suites cover explicit forwarding, while [`timeout-policy.spec.ts`](../../../../packages/guard/timeout-policy/tests/timeout-policy.spec.ts) preserves timeout ownership.

No registry test can prove that arbitrary third-party same-process code observes the signal or stops in bounded time. Capability tests continue to prove cancellation and quiescence at the boundary that owns each side effect.

## Alternatives considered

**Keep the signal optional and synthesize a fallback.** Rejected because a registry-owned fallback has no caller lifetime to represent and preserves the exact omission the type should prevent.

**Validate `AbortSignal` at runtime.** Rejected because this is a typed same-process boundary, not a serialization boundary. Runtime checks would duplicate the static contract without making cooperative use enforceable.

**Add `supportsCancellation` metadata, callback-arity checks, or signal-use linting.** Rejected because none proves that asynchronous work observes or correctly forwards cancellation. Availability is a type contract; behavior remains a tool and capability responsibility.

**Expose one mutable execution type to every stage.** Rejected because observers and tool implementations only borrow the signal. Stage-specific types make replacement possible only where the pipeline owns that operation.

**Forbid around wrappers from replacing the signal.** Rejected because deadlines and nested operational scopes need lexical derivation. Capturing and fusing the caller signal preserves composition without allowing detachment.

**Race the tool promise against cancellation.** Rejected because it reports completion while side effects may remain live, violating the [quiescent-disposal rule](../../../../docs/defensive-patterns/general.md#dispose-must-reach-quiescence-not-just-request-it).

## Consequences

- TypeScript rejects every `ToolExecutionInput` that omits `signal`, every tool or observer mutation of a readonly signal, and every around-dispatch attempt to remove the signal.
- Durable consumers can distinguish calls whose body may have produced side effects (`ABORTED`) from calls that never entered the body (`ABORTED_BEFORE_DISPATCH`).
- The change is intentionally breaking under the repository's pre-release stance; no compatibility overload or runtime fallback remains.
- Cooperative tools stop promptly and reach quiescence; an implementation that ignores its signal remains observable as a pending call.
- Downstream capability interfaces remain unchanged until the linked proposed Agent Note is accepted and implemented.
