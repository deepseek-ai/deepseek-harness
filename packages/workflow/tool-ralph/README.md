---
description: "The model-facing ralph tool: a fixed foreground fresh-agent loop toward one immutable objective, for users and maintainers choosing or configuring fresh-agent iteration."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-ralph

English | [中文](README.zh.md)

## Summary

`dsh-tool-ralph` gives the model the `ralph` tool: a fixed foreground workflow that hands one immutable objective to a sequence of fresh child agents, each starting with no conversation seed and carrying only the previous bounded report. It is a specialized orchestration policy built on the workflow and subagent capabilities — no Ralph mode is added to the agent loop, and the same-session goal domain stays independent. The call returns when a worker reports completion or a concrete blocker, or at the round limit; completion and blockers are worker reports, not independent certification. Use it only when the direct human explicitly asks for a Ralph loop or fresh-agent iterative execution; ordinary long-running objectives belong to goal tools, and bounded delegation belongs to subagents or workflows.

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

The `ralph` tool runs a fixed foreground loop: one fresh child per round works on the immutable objective in the shared workspace, and only a bounded structured report crosses rounds. Use it only when the direct human explicitly asks for a Ralph loop or fresh-agent iterative execution. For ordinary long-running same-session work, use goal tools; for bounded delegation and fan-out, use plain subagents or the `workflow` tool.

### Calling the tool

The model submits `{ objective, maxRounds? }` and the call blocks until the whole run settles. The deployment config's `maxRounds` is both the default and a ceiling on a call override. The terminal result is `complete`, `blocked`, or `budget-limited`, carrying the last bounded report and the number of rounds started; an ordinary child failure returns an error naming the failed round and retaining the last successful handoff when one exists.

### What each round sees

Each child receives only the immutable objective, its current round and cap, a shared-workspace-as-authority instruction, and the previous structured handoff; parent conversation and prior child sessions are never seeded. The workspace is the long-term memory across rounds. Reports carry a status (`continue`, `complete`, or `blocked`), a non-empty summary, evidence, next steps, and blocker text; invalid or oversized reports fail the workflow instead of being truncated or mistaken for cap exhaustion.

### Config

| Field | Default | Meaning |
|---|---|---|
| `subagentProvider` | `spawn` | Fresh structured-output provider used for every round. |
| `maxRounds` | `256` | Default and deployment ceiling for one Ralph run. |
| `maxHandoffChars` | `16384` | Maximum serialized characters in one round report. |
| `maxResultChars` | `16384` | Maximum characters in the complete successful parent result. |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-tool-ralph) is the exhaustive source for every accepted field. The configured provider must exist, support structured output, and report `inheritsParentContext: false`; a call against a provider that violates this fails loud before any round starts.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the fixed-script design and the validation and lifecycle mechanics; observable behavior is fully covered in [Use this package](#use-this-package).

### Design concept

The loop is a deployment-owned fixed script: the model supplies data only and cannot alter the loop, provider route, schema, or handoff validation. The tool is an ordinary plugin over `ctx.workflowEngine` and `ctx.subagents` — no Ralph mode or fresh-agent loop is added to `agent-loop`, and the same-session goal domain stays independent. The [Ralph Agent Note](../../../.agents/notes/implemented/feature/2026-07-19-fresh-agent-ralph-workflow-tool.md) owns the policy and deferred work.

### Fixed script and routing

The configured provider is carried as `WorkflowStartRequest.subagentProvider`, so the fixed script cannot inspect or change routing and the ordinary model-written `workflow` tool gains no provider selector. The resolved round cap is carried as `WorkflowStartRequest.maxTotalAgents`, coordinating the fixed loop with the engine's total-child backstop; the engine rejects a cap above its deployment ceiling before publishing a run.

### Report validation

Status-specific semantics and the serialized `maxHandoffChars` ceiling are validated inside the fixed workflow and again at the consumer boundary: a continuing report needs next steps and an empty blocker, a completion report needs evidence and no next steps, and a blocked report needs a concrete blocker. Invalid, missing, or oversized reports fail the workflow.

### Lifecycle and cancellation

The caller's agent is the parent of every fresh child, preserving cwd and lineage without copying its conversation. `exec.signal` enters the workflow engine and is also bridged to `run.cancel()` for implementation independence. The tool awaits `run.result` and calls `run.dispose()` in `finally`, so a cancelled parent step waits for the engine's bounded termination and child quiescence before returning.

### Render intent

The pending call is a `generic` card titled `ralph` with the immutable objective as its `rawInput`; the result keeps the generic card. Both presentation functions depend only on tool arguments and the settled tool envelope, and the completion and blocker labels state that a worker reported the outcome, not independent certification.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: fixed script, provider routing, report validation, tool registration |
| — | No runtime invariant companion is published; this model-facing orchestration adapter owns no independent event stream; workflow and subagent owners validate the runs and child lifecycles it starts. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the tool-level contract is not enough. They move from the shared workflow model to the engine, the subagent seam, and the adjacent goal domain.

- [Workflow subsystem](../../../docs/subsystems/workflow.md) — the seam contract behind the fixed loop.
- [Workflow seam](../workflow/README.md) — the run and result vocabulary.
- [Worker-thread engine](../workflow-worker-thread/README.md) — the engine that executes the fixed script.
- [subagent seam](../../subagent/subagent/README.md) — the fresh-child provider contract.
- [Goal group](../../goal/goal/README.md) — same-session goal tools for ordinary long-running objectives.
- [Ralph tool Agent Note](../../../.agents/notes/implemented/feature/2026-07-19-fresh-agent-ralph-workflow-tool.md) — the policy, provider requirements, and deferred work.

-----

<a id="model-experience"></a>
## Model Experience

### System prompt

#### What the model sees

Every parent request in this plugin's registration scope receives the fixed routing guidance below.

##### Ralph guidance

```markdown
Use the ralph tool ONLY when the direct human explicitly asks for a Ralph loop or fresh-agent iterative execution. Each Ralph round starts a fresh child with no conversation seed and uses the shared workspace as durable memory. Completion and blockers are worker reports, not independent evaluation. Use same-session goal tools for ordinary long-running objectives, and plain subagents or workflows for bounded delegation and fan-out.
```

#### Token effect

Small fixed guidance cost per request while the plugin is active.

#### KV Cache effect

Prefix-stable while the plugin scope and guidance text are unchanged. Activation or disposal may invalidate reuse from this prompt section.

### Tool schema

#### What the model sees

The generated [`ralph` schema](../../../docs/tool-catalog.md#deepseek-aidsh-tool-ralph) exposes one required `objective` string and one optional `maxRounds` number. Provider choice, handoff size, report schema, workflow script, and orchestration behavior are deployment-owned and absent from the call schema.

#### Token effect

Small fixed schema cost on each request where the tool is visible.

#### KV Cache effect

Prefix-stable while the definition and visibility are unchanged.

### Child requests and parent result

#### What the model sees

Each child sees the standalone fixed round prompt plus the structured-output capture contract. The parent sees only the original call and one terminal result containing a worker-reported status, round count, and pretty-printed final report; intermediate child messages and reports do not enter the parent conversation. A failed ordinary child instead yields an error with its round number and, after round one, the last successful handoff.

#### Token effect

Every round pays for a fresh child context. `maxHandoffChars` bounds cross-round state and `maxResultChars` independently bounds the complete successful parent text; child work remains outside the parent context.

#### KV Cache effect

Each fresh child has an independent request cache. The parent result appends after the reusable request prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define what the tool does not yet support. They are current constraints, not a task backlog.

- **Completion is worker self-declaration** — there is no independent evaluator or verifier deciding whether the objective is complete; evaluator policy and evaluator-driven continuation are deferred.
- **Foreground only** — there is no job id, background collection, process-resume checkpoint, scheduler, or wall-clock start policy.
- **The workspace is the only cross-round long-term memory** — one bounded report is the explicit handoff, and uncommitted conversational reasoning disappears with each child.
- **One round is one fresh child** — there is no within-round fan-out, model or provider switching, fork context, or model-call-selected provider.
- **Ordinary child failure is terminal for the run** — the fixed script reports the failed round and last successful handoff but does not retry; fatal workflow infrastructure failures can end before that state is returned.
- **Only round count bounds aggregate effort** — token, price, and elapsed-time budgets are deferred.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open directions that are not decided. It is explicitly non-authoritative — shipped behavior, limits, and accepted rationale live in the sections above, the package code, and the linked Agent Notes.

Open directions: an independent evaluator with evaluator-driven continuation; within-round fan-out and provider selection; and token, price, and elapsed-time budgets beyond the round cap.

</details>
