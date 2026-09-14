# Agent Note: Required cancellation through tool-reachable capability seams

Status: proposed

English | [中文](2026-07-19-required-cancellation-through-tool-capability-seams.zh.md)

## Problem

The implemented [tool registry cancellation contract](../../implemented/architecture/2026-07-19-cooperative-tool-cancellation.md) makes `exec.signal` required in every tool body, but many asynchronous capability interfaces reached from those bodies still accept an optional signal. A tool can therefore satisfy its own type while accidentally dropping cancellation at the next same-process call.

That gap is transitive. A filesystem tool may call path resolution and I/O, a web tool may call a provider, a bash tool may call an executor, and a composite tool may start or wait for tasks, subagents, or workflows. If any awaited operation controlling tool-owned work accepts omission, TypeScript cannot prove that cancellation remains available at the boundary that owns the side effect.

Requiring signals on every asynchronous function in the repository would overreach. Some operations are not reachable from tools, some synchronous queries cannot wait or own ongoing work, and explicitly detached work has a new owner after a deliberate handoff.

## Proposal

Require an `AbortSignal` on every asynchronous same-process capability operation that is reachable from a tool body while the tool still owns or awaits the operation. The requirement may be a positional parameter or a required readonly request field according to the owning seam's existing shape, but omission must fail TypeScript compilation.

Each direct caller supplies a signal it owns or propagates from its own required operation context. Implementations may derive a child deadline or cancellation scope, but the derived signal remains linked to the upstream signal for the delegated lifetime. Capability implementations do not synthesize never-abort signals, use ambient async-local cancellation, or validate `AbortSignal` at runtime solely to repeat the typed same-process contract.

The migration begins with an inventory from every first-party `ToolDefinition.execute()` through the capability calls it awaits. It then changes each coherent Service Definition / Service Provider / Consumer seam together, including tests and generated API documentation. Separate PRs may migrate filesystem, shell/task, web/provider, workflow/subagent, ptc-runtime, and similar families so each change remains reviewable, but no migrated interface keeps an optional compatibility overload under the repository's pre-release policy.

### Scope boundary

The proposal includes asynchronous capability operations whose completion or cancellation remains part of the invoking tool's lifetime, including start operations before ownership transfer, foreground execution, reads and writes, provider requests, waits, and cleanup or disposal that the tool awaits.

The proposal excludes synchronous registry lookup, availability checks, schema rendering, argument classification, and other operations that cannot retain asynchronous work. It also excludes work after an explicit detached-ownership handoff: once a task, workflow, worker, or child agent has been successfully published to a new lifecycle owner, that owner's controller governs the detached lifetime. The initiating start operation still requires the caller signal until the handoff commits, and any later tool call that waits for detached work requires its own invocation signal.

Optional cancellation may remain on parser, config, model/tool JSON, durable/file format, worker, process, or wire inputs when the external protocol makes it optional. The owning boundary must resolve that input into a required same-process signal before calling a migrated capability seam.

## Alternatives considered

**Leave downstream signals optional because tool bodies now receive one.** Rejected because availability at the outer callback does not make propagation type-safe; omission remains legal at every optional capability call.

**Enforce propagation with lint rules or callback inspection.** Rejected because syntax checks cannot reliably identify ownership, derived signals, abstraction layers, or correct quiescent settlement. Required interface parameters express the contract where TypeScript can check every caller.

**Pass `ToolRunContext` through every capability.** Rejected because capabilities need cancellation, not tool identity, agent state, or context deferral. Passing the larger context couples reusable services to the tool registry and obscures the narrow seam.

**Use an ambient async-local signal.** Rejected because hidden propagation makes ownership and detached handoff difficult to audit, complicates tests, and lets calls silently bind to the wrong lifetime.

**Add default or never-abort signals at capability implementations.** Rejected because defaults erase the missing owner instead of exposing it at compile time.

**Migrate every capability in the implemented tool-registry change.** Rejected because the transitive interface changes span independent capability families. Keeping this proposal separate preserves the implemented registry decision and lets each deep seam migrate with focused tests.

## Acceptance criteria

- An inventory maps every first-party tool body to the asynchronous capability operations it can reach before ownership handoff.
- Every in-scope capability interface requires `AbortSignal`, and compile-time contract tests prove omission fails.
- Interface, implementation, direct consumer, test helper, example, and generated API references migrate together without compatibility overloads or never-abort production sentinels.
- Derived deadlines and wrapper scopes remain linked to the caller signal, and integration tests prove cancellation reaches the side-effect owner and awaited work reaches quiescence.
- Synchronous queries and explicitly detached post-handoff work remain outside the requirement, with ownership transitions documented and tested where ambiguity exists.
- Runtime validation is added only at an actual untyped boundary, not to repeat a required TypeScript field or parameter.
- The top-level typecheck, coverage, snapshot, documentation, module-graph, build, hygiene, demo, and built-artifact gates pass after each coherent migration.

## Risks

**Large transitive blast radius.** A required parameter can expose many direct callers at once. Migrate by coherent capability family and use typecheck failures as the complete caller inventory.

**Incorrect detached-work classification.** Excluding a start operation too early can detach work before publication is committed; requiring the parent signal forever can let a completed tool cancel legitimately detached work. Each handoff needs an explicit commit point, new owner, rollback behavior, and quiescent failure path.

**Signal ownership confusion.** A capability that stores a borrowed signal beyond the delegated lifetime can bind work to a stale caller. Interfaces and tests must distinguish borrowed operation signals from controllers owned by long-lived services.

**Mechanical compliance without cooperation.** A required parameter proves availability, not observation or forwarding. Integration tests at process, worker, socket, provider, and task boundaries remain necessary to prove behavior.

**Over-scoping synchronous or unrelated APIs.** Requiring cancellation where no asynchronous work exists adds noise and weakens the signal of the contract. The inventory records why each operation is tool-reachable and lifetime-bearing before changing it.
