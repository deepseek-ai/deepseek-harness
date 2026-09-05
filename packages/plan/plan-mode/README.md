---
description: "Plan mode for users and maintainers choosing, configuring, or debugging the per-agent planning feature with deployment guidance, a /plan command, and a user-reviewed exit."
kind: "package-reference"
---

# @deepseek-ai/dsh-plan-mode

English | [中文](README.zh.md)

## Summary

`dsh-plan-mode` adds plan mode to the agent: while it is active, the agent explores and designs before executing, guided by instructions the deployment writes, and presents the finished plan for your approval before carrying it out. You enter plan mode with `/plan`, optionally carrying a message and ordered image or file attachments, and leave it with `/plan off`; the finished plan arrives as a review where you can approve it or send the agent back to keep planning. Plan mode is guidance, not enforcement: every tool stays available, so sandbox mode and approval prompts remain the way to impose limits. Choose it when the agent should think before acting, and plan mode carries over when a session resumes or forks.

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

When plan mode is active, the agent works under your instructions and presents its plan for review instead of executing right away. The common path: configure the guidance text, enter plan mode with `/plan`, and review the finished plan when the agent calls `exit_plan_mode`.

### When to choose it

Choose plan mode when the agent should explore and design before executing and you want to approve the plan first. It does not restrict the agent: every tool stays callable, so use sandbox mode and approval prompts when you need enforced limits. Skip it when the agent should act on your requests immediately, without a planning phase.

### Minimal configuration

The only required configuration is the guidance text the agent follows while planning; anything else you add fails at load.

```yaml
- name: '@deepseek-ai/dsh-plan-mode'
  config:
    section: |
      You are in plan mode. Explore and design before presenting the complete
      plan through exit_plan_mode.
```

| Field | Default | Meaning |
|---|---|---|
| `section` | required | Guidance rendered as the `plan:policy` prompt section while plan mode is active |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-plan-mode) is the exhaustive source for every accepted field and its JSDoc.

<a id="model-and-human-interactions"></a>
### Entering and leaving plan mode

Type `/plan` to enter plan mode, or `/plan <message>` to enter with an instruction — the message becomes your next request under plan guidance. Type `/plan off` to leave plan mode directly; it also cancels a plan-mode entry that has not taken effect yet.

You can attach images and generic files to a `/plan` message, and they are included with your instruction in selection order. `/plan off` with attachments is rejected before the mode changes, so the draft and cards remain available. The `/plan` command is available wherever slash commands are supported, such as the Web client.

### The reviewed exit

When the agent has a finished plan, it calls `exit_plan_mode` with the plan written as markdown and starting with a heading. You review that exact plan and choose `Approve` to leave plan mode, or `Keep planning` to send the agent back with feedback.

Choosing `Keep planning` (optionally with free-text feedback) sends the agent back to revise the plan; closing the review to type a message instead tells the agent to wait for your next message. If no interactive review is available, `exit_plan_mode` cannot run and you can still leave plan mode with `/plan off`.

### Observing plan state

Interfaces can show whether plan mode is active and whether a mode change you requested is still waiting to take effect. The state is the same in every tab and survives restarts.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions behind the package and points at the code that realizes them; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design philosophy

Plan mode is a product package, not a capability seam: there is no swappable backend, so the state, guidance, command, and exit tool live in one place. The durable stance is one log-only whole-value-replace event, never a live mirror, so resume, fork, and compaction recover it by folding the log. Guidance is a soft layer — the package registers one prompt section and one tool, and restrains through text rather than filtering capabilities.

### Durable state and step-boundary appends

The package persists one log-only whole-value event, `plan/mode`, and the last logged value is the state. A mode change appends immediately when no turn is open; during an open turn it stays pending until the next accepted in-turn pre-step — the only append point while an agent runs — and an append failure cannot block the turn. The `set`/`get` service methods and their exact return states live in [`src/index.ts`](src/index.ts) and read the registered `plan` projection; the first dependent access fails explicitly when the registry or key is absent.

### The `/plan` command

The command child activates only when a commands service is composed. It maps bare `/plan` to active, the exact argument `off` to inactive without model input, and any other non-empty argument to active plus the trimmed text submitted through `agent.steer()` as the next step's ordinary logged user message. Admitted image and file blocks keep their selection order in that message; `/plan off` with attachments fails before any mode change. Entry points other than the command may drive `ctx.planMode` directly; the exact branch handling is in [`src/index.ts`](src/index.ts).

### The exit tool

`exit_plan_mode` stays registered while plan mode is inactive, so entering or leaving changes only the prompt section, never the request tool catalog. An approved review records a silent pending exit that the next accepted in-turn pre-step appends, keeping plan guidance for the rest of the current tool batch. Without a user-questions channel, or after a service reload while the review is pending, the call fails closed and `/plan off` remains the manual escape.

### Session projection unit

When `ctx.sessionProjections` is composed, the package registers the `plan` unit through optional injection. The unit turns logged `/plan` command runs into a candidate target, commits the logged state on `plan/mode`, and derives `{ active, pending }` for `view`, where `pending` is true only while an unsettled or successful selection differs from the logged state — a pure replay quantity recoverable from the log alone. The key merges into `SessionProjectionMap` from [`src/types.ts`](src/types.ts); the framework drives the unit, and unloading the plugin fiber unregisters the key. Plan-mode reads require this unit and the `turnBoundary` unit, and fail explicitly if the registry or either key is absent.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `Config` schema, the `ctx.planMode` service, `plan:policy` section, `/plan` command, `exit_plan_mode` tool |
| [`src/types.ts`](src/types.ts) | The `plan` projection-key declaration and `PlanProjection` wire value |
| [`src/client.ts`](src/client.ts) | Client-namespace re-export of the types outlet |
| [`src/invariant.ts`](src/invariant.ts) | Invariant companion: validates the `plan/mode` payload shape |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the subsystem semantics to the generated catalogs and the design decision.

- [Plan mode subsystem reference](../../../docs/subsystems/plan.md) — how plan mode behaves, its configuration, and the exit tool's contract.
- [plan/ package map](../README.md) — the group and its single package.
- [exit_plan_mode tool catalog entry](../../../docs/tool-catalog.md#deepseek-aidsh-plan-mode) — the exact schema the model receives.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-plan-mode) — every accepted config field and its meaning.
- [Plan-specific collaboration state](../../../.agents/notes/implemented/simplification/2026-07-22-plan-specific-collaboration-state.md) — the design decision behind plan mode.

-----

<a id="model-experience"></a>
## Model Experience

### Plan policy system prompt

#### What the model sees

While plan mode is active, the model sees the deployment's exact `section` text at first-party prompt order 500; inactive mode contributes no text.

##### Configuration example

```markdown
You are in plan mode. Explore and design before presenting the complete plan through exit_plan_mode.
```

#### Token effect

Inactive mode adds no tokens; active mode adds the configured section to every request.

#### KV Cache effect

The section is stable within plan mode, but entering or leaving changes the system prompt from first-party order 500 onward.

### Human command

#### What the model sees

`/plan`, `/plan off`, and their terminal results stay outside model history. A non-empty suffix other than the exact `off` argument becomes one user message through `agent.steer()` after plan mode is selected: admitted image and file blocks in selection order, then the trimmed text block. Bare `/plan` with admitted attachments steers one user message containing only those blocks. An active `/plan off` selection contributes the standard logged user-switch notice only when the last request header described plan mode; cancelling a pending entry contributes none because no request observed it.

#### Token effect

The optional message costs the same history tokens as submitting that content separately. Bare `/plan` without attachments and `/plan off` add none; bare `/plan` with attachments has the normal image and file-handle cost. A narrated active exit adds the small retained switch notice.

#### KV Cache effect

The user block is append-only conversation growth. Entering or leaving plan mode changes the earlier policy section; a narrated exit notice is appended after the reusable request prefix.

### Exit tool schema and review exchange

#### What the model sees

The [`exit_plan_mode` schema](../../../docs/tool-catalog.md#deepseek-aidsh-plan-mode) remains available in both states; execution outside plan mode fails, while an approved in-mode review returns the canonical `{ approved: true }` value and renders the existing confirmation text. Rejection remains a failed call carrying review feedback, and a dismissed review a failed call naming the user's takeover.

#### Token effect

The stable schema is paid according to ToolRuntime mode, and each plan argument and review result remains in conversation history.

#### KV Cache effect

Mode transitions do not change the tool catalog; plan arguments and review results extend the conversation normally.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits describe when plan mode does not behave as you might expect or needs extra care. They are current package constraints, not a roadmap.

- **Guidance, not enforcement** — plan mode restrains through text only; deployments that need enforced restrictions configure sandbox mode and approval policy independently.
- **Pending selections are process-local** — a selection made after the turn's final accepted pre-step is lost if the process exits before another accepted in-turn pre-step; the UI must reapply it.
- **No creation-time plan option** — forked agents inherit logged plan state, while newly spawned agents begin inactive.
- **Live children cannot open the review** — a child owned by another live agent fails the `exit_plan_mode` call and is told to include the unresolved decision in its final result; durable fork lineage alone does not prevent a session resumed as a runtime root from opening the review.
- **One specialized review renderer** — only the Web UI has a `plan-review` presentation; another interaction provider presents the same request through its generic option flow.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open design questions and directions that are not decided. It is explicitly non-authoritative — shipped behavior, limits, and accepted rationale live in the sections above, the package code, and the linked Agent Note.

#### Future: a second collaboration mode

The design note rejected a generic named-mode registry because the product shipped only `plan`; a future collaboration state would establish a shared seam only from two concrete cases, and any extraction must keep `plan/mode`'s log-only fold, the boundary append, and the reviewed exit intact.

</details>
