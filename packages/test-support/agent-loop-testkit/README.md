---
description: "Prerequisite mounting, production AgentLoop drivers, and explicit Inbox stubs for agent-loop tests."
kind: "package-library"
---

# @deepseek-ai/dsh-agent-loop-testkit

English | [中文](README.zh.md)

## Summary

`dsh-agent-loop-testkit` mounts the standard prerequisite services a test needs before loading the concrete `AgentLoop` — the LLM runtime, session store, session-projection registry, system-prompt registry, tool registry, and agent registry — in dependency order, with one call. A second helper mounts the production loop and returns a narrow driver for creating real Agents and claiming their real Inbox input. Consumer tests that need only the public queue operations can instead use an explicitly process-local Inbox stub, while tests with no pending-input behavior can use a fail-fast unsupported Inbox. Adapters, optional plugins, load order, and teardown stay in the test's hands. The package registers no model-facing behavior of its own.

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

This package gives an AgentLoop test a working service topology and keeps the choice between production Inbox behavior and a structural stub explicit.

### Drive a production Agent

Use `mountAgentLoopTestHarness()` when the test covers durable Inbox events, projection recovery or validation, live Inbox notifications, or loop-driver claims. Mount any load-order-sensitive consumers after the prerequisites and before creating the Agent. The context owns the loop and every Agent returned by the harness.

```ts
import { Context } from '@deepseek-ai/cordis'
import { SessionId, type UserMessage } from '@deepseek-ai/dsh-session'
import {
  mountAgentLoopTestDependencies,
  mountAgentLoopTestHarness,
} from '@deepseek-ai/dsh-agent-loop-testkit'

const ctx = new Context()

await mountAgentLoopTestDependencies(ctx)
// Register the test adapter and any load-order-sensitive plugins here.
const harness = await mountAgentLoopTestHarness(ctx)
const agent = await harness.create(SessionId('test-agent'))
declare const message: UserMessage

agent.inbox.append('next-turn', message)
const admitted = harness.claim(agent, 'next-turn', 1)
```

The dependency helper forwards system-prompt and tool-registry configuration through `options` and provides no test defaults beyond those services' own defaults. A plugin-load failure rejects the helper call; services activated earlier in the sequence remain context-owned and unwind when the context is disposed.

### Build a structural Agent stub

Use `createInboxStub()` when the test subject needs mutable pending lists but does not exercise durability, projection validation, live Inbox notifications, or the driver's claim policy. The stub implements the public queue operations with two process-local arrays and never writes to a Session. Use `unsupportedInbox()` when the test subject must not touch pending input; every mutation throws at the first unexpected dependency.

```ts
import { createInboxStub } from '@deepseek-ai/dsh-agent-loop-testkit'

const agent = {
  // ...
  inbox: createInboxStub(),
}
```

### When to use it

Use the dependency and loop helpers for tests whose subject is production loop or durable Inbox behavior. Use the structural stub for consumer-domain tests that only need queue editing. Mount dependencies directly when a test probes service injection failures or partial topologies, because the helper hides exactly the wiring those tests must control.

### What can go wrong

The harness mounts no LLM adapter. Register an adapter before sending work that would start a model request. Dispose the owning context after every test so Agents reach quiescence and their scoped registrations unwind.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design of the test utilities; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design

`mountAgentLoopTestDependencies` mounts six service plugins in a fixed dependency order — LLM, session, session-projection registry, system-prompt registry, tool registry, then agent registry — and stops before `AgentLoop`, so the caller controls loop load order. `mountAgentLoopTestHarness` mounts the public production plugin, creates Agents through its service, and exposes the production driver's claim operation without exporting the loop's concrete Inbox class or projection definition. [`src/inbox.ts`](src/inbox.ts) contains only the process-local mutable stub and the fail-fast unsupported placeholder; it owns no projection or durable event implementation. The mounting and driver implementation lives in [`src/index.ts`](src/index.ts). No invariant companion is published because the package owns only test helpers and has no independent production observations that can diverge.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level behavior is not enough. They move from the loop to the services the helper mounts and the tests that use it.

- [Agent loop package](../../core/agent-loop/README.md) — the concrete loop this helper mounts for production behavior.
- [Session package](../../core/session/README.md) — the durable event log used by production Inbox behavior.
- [LLM package](../../llm/llm/README.md) — the LLM runtime and adapter interface the helper prepares.
- [Testing policy](../../../docs/testing.md) — the coverage tiers these tests serve.
- [Test-support group map](../README.md) — sibling harnesses and support packages.

-----

<a id="model-experience"></a>
## Model Experience

None, as these test-only utilities neither assemble nor modify model requests.

#### KV Cache effect

None; the package itself sends no provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define what the utilities do not share. They are current package constraints, not a task backlog.

- **Only the mandatory prerequisite spine is shared** — adapters, optional plugins, scenario-specific load order, and context teardown remain caller-owned.
- **The production harness has no adapter default** — tests that start the loop must register the route they exercise.
- **The mutable Inbox stub is process-local only** — use a harness-created Agent whenever durable events, projection recovery or validation, live notifications, or claim policy matter.
- **The unsupported Inbox accepts no mutations** — use the mutable stub or a harness-created Agent whenever pending input is part of the test subject.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
