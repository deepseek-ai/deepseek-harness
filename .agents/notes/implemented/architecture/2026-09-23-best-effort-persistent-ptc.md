# Agent Note: Node PTC execution modes and in-memory state

Status: implemented

English | [中文](2026-09-23-best-effort-persistent-ptc.zh.md)

## Problem

Interactive automation retains application objects, imported modules and helper functions between model calls. Recreating every object for every program prevents consumers from using ordinary JavaScript references across observations and actions.

## Decision

The existing `@deepseek-ai/dsh-ptc-runtime-node` plugin selects its execution mode through `executionMode`. The default `per-call` mode starts a fresh process under the configured file policy. Opt-in `persistent-in-memory` mode keeps a Node REPL process per explicit, object-identity state owner. Both modes provide the same `ctx.ptcRuntime` service. PTC uses the live Agent as owner and awaits release during its context disposal. Changing the configuration reloads the provider and releases its processes. The [sandboxed Node decision](2026-09-11-sandboxed-node-ptc-runtime.md) owns per-call confinement; the [PTC foundation](../feature/2026-06-15-ptc.md) owns tool dispatch and logged model requests.

Mode names describe state retention rather than a process implementation or source syntax. `per-call` retains state for one invocation; `persistent-in-memory` retains it across invocations until the process or owner ends. `durable` names the deferred ability to save and restore execution state across restarts. It is not an accepted configuration value: a future implementation must define its recovery point, recoverable values and external-resource handling before exposing that mode. The [retained-process permission decision](2026-10-08-persistent-ptc-sandbox.md) owns confinement, policy changes and temporary escalation.

One npm package and one plugin entry keep existing installation and loading paths stable. Communication, binding proxies, JSON encoding and output limits remain package-local modules. The Node provider delegates retained process ownership to an internal execution object, which registers no additional Cordis service. Per-call and in-memory execution keep their distinct lifecycle rules. `programFormat` describes source evaluation independently of retention: a REPL need not retain state. The runtime owns syntax, completion and retention instructions through `executionInstructions`; tools own call arguments, SDK declarations and image attachment. Workflow uses `programFormat` to wrap its program and refuses restricted file policies when the selected runtime cannot enforce them.

The Session records submitted programs, nested tool calls and returned output. It does not serialize the REPL heap or rerun earlier programs after restart, resume or fork: replaying automation could repeat external side effects. A missing variable is a normal program error, and the model-visible instructions require recreating variables and reacquiring resources. No environment identifier or new durable Session event is required because the provider exposes no unlogged model input.

Cancellation, deadline expiry, protocol or output-limit failure, owner disposal and process exit discard the environment. Ordinary exceptions retain earlier mutations. A retained function uses the active evaluation's host bindings; asynchronous work from an earlier evaluation cannot acquire a later evaluation's tool authority or output sink.

## Alternatives considered

Separate npm providers plus a shared library allow independent distribution, at the cost of another package, dependency declarations and cross-package exports for shared implementation details. The two Node modes have no current need for separate release schedules or independent dependencies. A second plugin subpath permits separate loading but asks deployments to replace plugin entries to select an execution policy. A configuration field expresses that selection while preserving the existing entry. Independent distribution or substantially different dependencies can justify revisiting this choice.

A new Cordis service for common helpers would require another registration and injected dependency without adding an independently replaceable runtime capability. Internal functions and classes provide the required reuse. A common execution superclass would also couple fresh-process cleanup with owner-retained lifetimes; the provider shares mechanisms without merging those lifecycles.

Serializing arbitrary JavaScript objects cannot preserve native resources and closures. Replaying prior programs can repeat writes and input actions. Both would imply recovery guarantees that in-memory execution does not offer.

A realm inside the Harness process shares process lifetime with model code and cannot terminate a synchronous loop independently. A managed child process permits cancellation and resource cleanup while retaining imports and variables during healthy use. Process ownership alone does not provide a file sandbox or multi-tenant isolation.

## Consequences

Selecting `persistent-in-memory` retains execution state; the [permission decision](2026-10-08-persistent-ptc-sandbox.md) defines its file restrictions. Nested tools keep their normal authorization and logging. Memory and native handles may disappear without a Harness restart. The model must recover from reference or resource errors; the runtime never retries a program automatically.

An idle owner retains a process with no expiration timer. Callers release owners explicitly; ownerless service calls use temporary processes. Programs use REPL statements and a final expression rather than top-level return, and calls for one retained owner cannot overlap. Tool schemas and program guidance follow the selected mode.
