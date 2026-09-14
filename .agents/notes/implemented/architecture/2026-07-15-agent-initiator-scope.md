# Agent Note: Initiating Agent scope over AsyncLocalStorage

Status: implemented

English | [中文](2026-07-15-agent-initiator-scope.zh.md)

## Problem

The harness has two useful but different notions of context. A Cordis `Context` selects services, registration ownership, and lifetime; `agent.ctx` is the flat registration scope owned by one live Agent. Agent and Session identity instead describe the subject of an asynchronous operation. A dynamic `ctx.agent` meaning “whichever Agent is running” would conflate those meanings and fail when one process drives Agents concurrently.

Deep process-local infrastructure sometimes needs a trusted initiating Agent below explicit loop, tool, and request parameters—for example, a host-aware transport, tracing helper, logger, or gateway client. Requiring every private helper to forward `agent` adds repetition, while a process-global mutable slot is incorrect across `await`. Model-visible arguments are unsuitable because a model must not choose a trusted Session or routing header. The carrier belongs to the Agent service rather than optional model-visible context.

## Decision

The mandatory `ctx.agents` service uses Node `AsyncLocalStorage` to carry the initiating Agent. It stores the exact `Agent` directly rather than introducing a one-field frame; a separate private run token records nested boundary lineage only for teardown bookkeeping and carries no identity. The [core-data catalog](../../../../docs/subsystems/core.md#initiating-agent) identifies the carried type.

`currentInitiator()` reads optionally, `requireInitiator()` throws `no initiating agent is active`, and `withInitiator(agent, operation)` preserves the operation's exact synchronous value or Promise. `withoutInitiator(operation)` establishes a clearing boundary for work that must not inherit an Agent. Session remains derived as `agent.session`; turn, step, tool call, `signal`, model, `cwd`, sandbox, and authorization stay with their existing owners.

`AgentLoop` already injects `ctx.agents` and wraps each concrete driver's complete `runLoop` lifetime in `agents.withInitiator(agent, ...)`. Its package-private loop, turn, step, and tool-call orchestration entries recover the exact Agent from `ctx.agents`, derive `agent.session` once, and let operation-local helpers capture it instead of forwarding the concrete driver or `Session` through shallow interfaces. A leaf helper keeps a narrow `Session` parameter when that is its actual interface rather than accepting a broader `Context` only for an ambient lookup.

Concurrent drivers receive independent stores. A child driver's continuations carry the child, while the caller resumes in its prior store as soon as `withInitiator()` returns; active-run tracking keeps the returned Promise in the teardown drain until it settles. Creation, persistence load, and unpublished `setup(agentCtx, childAgent)` remain outside the child's driver boundary: creation initiated by a parent runs under the parent identity, while the explicit `childAgent` parameter identifies the child.

Ambient identity does not replace explicit contracts. `ToolExecution.agent`, `AssembleContext.agent`, the Agent parameter of `AgentSetup`, `GenerateOptions.sessionId`, job ownership, parent/child requests, approval and hook subjects, `cwd` selection, cancellation, worker/process messages, persistence records, and wire identity remain explicit. A remote boundary materializes the identity it needs into its typed request because ALS is process-local.

`AgentRegistry` owns an ordered initiator lifecycle. Teardown first rejects new boundaries; removing `ctx.agents` then drains injected dependents such as AgentLoop, and the registry waits for active returned-Promise boundaries before calling `AsyncLocalStorage.disable()`. If a boundary's inherited async chain starts an owning Cordis fiber's unload, the private run-token lineage releases that nested boundary chain from the drain, which prevents teardown from waiting on itself while unrelated boundaries still drain. `currentInitiator()` and `requireInitiator()` remain usable through a retained in-flight service reference while the ordinary drain runs; after disposal, initiator methods throw `agent initiator scope is disposed`. Root Context disposal may start sibling fiber teardown concurrently, so active-boundary counting remains necessary in addition to Cordis dependency ordering.

Initiator scope does not own detached work: registry drain tracks only the Promise returned by `withInitiator()` or `withoutInitiator()`. Asynchronous resources created inside a boundary inherit its store until they settle or ALS is disabled, so their owning seam must stop unreturned work explicitly. Agent-owned foreground work returns its lifetime and keeps its cancellation contract. Unrelated timers, queues, and deployment infrastructure start under `withoutInitiator(operation)`; queue, worker, process, and wire boundaries serialize identity rather than expecting ALS propagation.

A host-aware transport may derive a deployment-owned header such as `X-Harness-Session-Id` from `ctx.agents.requireInitiator().session.id`; the header is absent from model-visible schema and arguments. No production MCP or Web transport adopts such a header in this decision. A test-double transport proves the trusted boundary without assigning host routing policy to an existing provider-neutral seam.

This decision extends the [Agent registration-scope contract](2026-07-08-agent-scope-contexts.md) and its [runtime design](2026-07-12-agent-scope-runtime-design.md); it does not change their static `agent.ctx` meaning. The [explicit runtime-identity decision](2026-08-31-explicit-agent-runtime-identity.md) keeps initiator scope limited to private asynchronous chains while lifecycle, ownership, event, and wire interfaces carry their subjects directly.

## Verification

Agent service tests pin optional and required reads, exact synchronous and cross-realm Promise identity, intrinsic Promise settlement observation, overlapping, nested, and cleared boundaries, restoration after throws or rejection, ordinary and reentrant drain ordering, and retained-reference errors. AgentLoop integration pins concurrent and nested drivers, agentless calls, AgentRegistry restart, root teardown, and package-private loop and tool scheduling through the ambient lookup. Composition, module-graph, build, and runtime-closure checks keep `ctx.agents` wired through the default bundle, SDK spine, Python runtime closure, and direct AgentLoop harnesses without another provider.

A test-double host-aware transport derives `X-Harness-Session-Id` internally and verifies that tool schema and logged arguments contain no identity field. The service deliberately does not drain async work omitted from the Promise returned by the boundary operation; that work remains subject to its owner's explicit stop contract.

## Alternatives considered

**Pass Agent through every function.** Public, worker, process, persistence, and wire boundaries continue to do this, but requiring every process-local private helper to carry Agent adds repetitive forwarding without improving trust. ALS is confined to the asynchronous chain inside those explicit boundaries.

**Expose a dynamic `ctx.agent`.** Context carries registration ownership, not a domain subject. Adding an accessor for the executing Agent would mix registration and execution scopes and make concurrent behavior surprising.

**Add a separate `ctx.agentExecution` service.** The carrier has no independent backend, configuration, or identity type: it stores the same `Agent` that `ctx.agents` already owns, and AgentLoop already depends on that service. A second mandatory provider would add package, composition, lifecycle, generated-catalog, and test-harness wiring without separating a real capability.

**Store a named or complete runtime frame.** A one-field `{ agent }` frame only wraps the value, while Agent, Session, inbox, cancellation, turn, step, tool execution, and persistence already have authoritative owners. Adding more fields would create stale snapshots and another lifecycle; carrying `Agent` directly keeps the boundary named by its methods without duplicating state.

**Include a step `AbortSignal`, `cwd`, sandbox, or authorization.** Their lifetimes and authority do not match the driver boundary, and their existing seams already pass them explicitly. Adding a control capability requires a separate decision and nested lifecycle contract.

**Use a process-global `currentAgent`.** Concurrent Agents and subagents overwrite one another across awaited continuations, so a mutable global is correct only under a serialization guarantee the harness does not make.

**Derive identity from model-visible arguments.** Model or user input cannot be trusted to select Session, tenant, or sandbox routing.

**Add routing identity to every capability seam.** That spreads hosting concerns through provider-neutral APIs. A host-aware implementation owns its transport header while public boundaries remain explicit.

## Consequences

Deep infrastructure gains one trusted process-local initiating Agent without widening existing tool and capability requests. Concurrent and nested drivers isolate automatically, AgentLoop gains no additional mandatory service, and HMR/root disposal reaches quiescence before ALS is disabled.

The dependency is implicit in function signatures and carries a capability-bearing Agent object. Consumers must restrict it to cross-cutting infrastructure, treat ambient presence as neither liveness nor authorization, and retain explicit cancellation and ownership checks. ALS also has an always-on propagation cost and does not cross worker, process, HTTP, or durable queue boundaries.

The teardown design deliberately accepts Node's [Stability 1 (Experimental)](https://nodejs.org/api/async_context.html#asynclocalstoragedisable) `AsyncLocalStorage.disable()` dependency. Node requires `disable()` before an ALS instance can be garbage-collected, which matters when HMR replaces AgentRegistry-owned instances; the service state guard prevents a later boundary from re-entering the instance after disposal.

The scope deliberately carries only the Agent, omitting turn, step, `signal`, `cwd`, sandbox, and authorization. A real consumer that cannot use existing explicit fields must justify any refinement separately; a stale copied field may at most mislabel telemetry, never grant control.
