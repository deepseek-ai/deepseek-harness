---
description: "Shared service mounting for tests that exercise the concrete AgentLoop, for test authors wiring real loop prerequisites."
kind: "package-library"
---

# @deepseek-ai/dsh-agent-loop-testkit

English | [中文](README.zh.md)

## Summary

`dsh-agent-loop-testkit` mounts the standard prerequisite services a test needs before loading the concrete `AgentLoop` — the LLM runtime, session store, system-prompt registry, tool registry, and agent registry — in dependency order, with one call. The loop itself, adapters, optional plugins, agents, and teardown stay in the test's hands, so each scenario keeps its own load order and topology. Use it when a test's subject is loop behavior rather than service wiring; tests that probe injection failures or partial topologies mount their dependencies directly. It registers no model-facing behavior of its own.

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

This package gives an AgentLoop test a working service topology before the loop is mounted: call the helper on your test context, then mount `AgentLoop` with the configuration under test and register your adapter and optional plugins.

### Minimal example

```ts
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'

const ctx = new Context()

await mountAgentLoopTestDependencies(ctx)
// Register the test adapter and any optional plugins here.
await ctx.plugin(AgentLoop, { agents: [] })
```

The helper activates the LLM, session, system-prompt, tool, and agent services in dependency order and returns before the loop is mounted. System-prompt and tool-registry configuration can be forwarded through `options`; the helper provides no test defaults beyond those the services own.

### When to use it

Use the helper for tests whose subject is the loop: load order, retries, tool execution, or session behavior on a real prerequisite stack. Mount dependencies directly when a test probes service load order, injection failures, partial topologies, or teardown — the helper hides exactly the wiring such tests must control.

### What can go wrong

A plugin-load failure rejects the helper call; services activated earlier in the sequence remain owned by your context and unwind with it. The context owns every mounted service, so dispose it after the test.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design of the helper; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design

**Runtime invariant:** No companion is published. This test-support package owns no production event stream or mutable data; consuming test suites exercise its behavior.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the loop to the services the helper mounts and the tests that use it.

- [Agent loop package](../../core/agent-loop/README.md) — the concrete loop this helper prepares tests for.
- [Session package](../../core/session/README.md) — the session store the helper mounts.
- [LLM package](../../llm/llm/README.md) — the LLM runtime and adapter contract the helper mounts.
- [Testing policy](../../../docs/testing.md) — the coverage tiers these tests serve.
- [Test-support group map](../README.md) — sibling harnesses and support packages.

-----

<a id="model-experience"></a>
## Model Experience

None, as this test-only composition helper neither drives nor modifies model requests.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define what the helper does not share. They are current package constraints, not a task backlog.

- **Only the mandatory prerequisite spine is shared** — adapters, optional plugins, `AgentLoop`, agents, and context teardown remain caller-owned so scenario-specific ordering stays visible.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
