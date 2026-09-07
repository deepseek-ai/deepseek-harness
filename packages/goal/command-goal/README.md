---
description: "The human-facing /goal slash command for users and maintainers choosing, composing, or debugging goal control in UI command planes."
kind: "package-reference"
---

# @deepseek-ai/dsh-command-goal

English | [中文](README.zh.md)

## Summary

`dsh-command-goal` gives the human `/goal` command over the persisted goal service: a user can create, edit, pause, resume, clear, and inspect the current goal directly from the UI, without involving the model. The command registers in its Cordis scope, so command adapters reading that scope discover and execute it, while command text and output stay in the UI — they never enter model requests. Every accepted mutation persists through the goal service's durable `goal/change` event. Ordered image and file attachments may accompany a create or edit and are submitted as one ordinary user message so later goal rounds see them. Choose it for interactive deployments with a command adapter; headless and automation apps without one do not need it.

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

Use `dsh-command-goal` in interactive deployments that mount a command adapter — the shipped Web client is the reference. It gives users direct control over the goal lifecycle without a model turn: commands execute in the UI command plane and the adapter renders their results directly.

### Command reference

Every sub-command runs against the current goal of the invoking agent; a bare `/goal` shows usage when no goal exists.

| Input | Result |
|---|---|
| `/goal` | Shows the current objective, durable phase, round count and cap, process-local activation, and valid next commands; a blocked goal also shows its policy code and explanation |
| `/goal <objective>` | Creates and arms a goal, or replaces a completed goal with a fresh identity |
| `/goal edit <objective>` | Edits the current objective without changing its phase or activation |
| `/goal pause` | Pauses an active goal and disarms continuation |
| `/goal resume` | Resumes a stopped goal, or rearms an active goal after session resume or fork, subject to its remaining round cap |
| `/goal clear` | Clears the current goal while retaining its durable history |

### Input grammar

Control words (`clear`, `pause`, `resume`, `edit`) are recognized only when they occupy the complete input; any other non-empty suffix is an objective, so `/goal pause after verification` creates that literal objective. `edit` takes its replacement inline and refuses to replace an unfinished goal directly. Expected domain rejections become stable, direct command errors without exposing branded ids or revisions; unexpected implementation failures still fail dispatch so adapters can report them as command failures.

### Attachments

`/goal` declares attachment support. Attachments accompany only an objective: after a successful create or edit, the command submits one user followup carrying the admitted image and file blocks in selection order plus the fixed text `Reference attachments for the goal objective.` Later goal rounds read that ordinary session history; the goal domain stores no attachment state. Every other sub-command, and any refused create or edit, returns a direct error before a domain mutation and leaves the dispatching composer's draft and cards intact.

### Compose it

The command injects the commands registry and the goal service. A custom app mounts their owners plus this plugin; automatic continuation remains an independent choice:

```yaml
- id: commands
  name: '@deepseek-ai/dsh-commands'
- id: goal
  name: '@deepseek-ai/dsh-goal'
- id: command-goal
  name: '@deepseek-ai/dsh-command-goal'
```

The shipped `dsh` base enables the persisted-goal stack and this command. The Web bundle keeps the goal service and driver on the Host, disables the base command producer, and mounts the producer in the `standard`, `code`, and `cordis` agent presets; `minimal` omits it. The ACP automation app enables the domain and model tools without a command adapter. The standalone `sdk-minimal` profile omits the complete goal stack so its result API still settles one correlated physical turn.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains how the command parses input and renders output; the observable contract is covered in [Use this package](#use-this-package).

### Design

- **Grammar, not free text.** The parser recognizes only the exact control words (`clear`, `pause`, `resume`, `edit`) when they fill the whole input; every other non-empty suffix is an objective. `edit` alone is invalid, and `edit` refuses to replace an unfinished goal directly.
- **Domain rejections become stable errors.** `GoalError` outcomes are converted into direct command errors with a fixed message; unexpected failures rethrow so adapters report a command failure rather than a domain result. Rendered output never exposes branded ids or revisions.
- **Attachments accompany the objective.** On a successful create or edit, the command submits one user followup carrying the admitted image and file blocks in selection order plus the fixed text `Reference attachments for the goal objective.` Every other path submits nothing, so the dispatching composer keeps the draft and cards.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: command grammar, status rendering, attachment submission |
| — | No runtime invariant companion is published; this command adapter owns no event stream or state projection; accepted mutations are checked by the goal domain and command dispatch behavior is covered by package tests. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

The command is a thin adapter over the goal domain; read these pages for the state it mutates and the registry it plugs into.

- [Goal service](../goal/README.md) — the state and lifecycle the command mutates.
- [Commands service](../../interaction/commands/README.md) — the command registry contract and dispatch.
- [Harness-level goal-execution Agent Note](../../../.agents/notes/implemented/feature/2026-07-16-harness-level-loop.md) — the UX and composition decisions.

-----

<a id="model-experience"></a>
## Model Experience

### Human `/goal` control

#### What the model sees

The slash input, mutation, and direct status/error output are absent from model requests. The goal domain records the mutation as `goal/change`; an enabled same-session driver may expose the resulting state in a later continuation prompt. Presentation text is never logged. When a create or edit carries attachments, the model sees one ordinary user message: the ordered image and file blocks followed by the text `Reference attachments for the goal objective.` It precedes the next goal round in session history.

#### Token effect

Reading status, mutating a goal, or receiving a direct command error adds no model tokens. An enabled same-session driver may add later goal-round prompts. An objective's attachments add one ordinary user message with the normal text, image, and file-handle costs.

#### KV Cache effect

Command discovery, mutations, and direct output do not affect the cache. Later continuation prompts follow the driver's ordinary request history.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when the command is a poor fit or needs special care. They are current package constraints, not a task backlog.

- **Plain-text interaction only** — the generic command registry has no modal edit form or replacement-confirmation callback; inline edit and explicit clear keep destructive intent deterministic across adapters.
- **No per-command round-cap argument** — `defaultMaxGoalRounds` remains deployment config, while a direct human request may ask the model to edit `max_goal_rounds` through the separately authorized goal tool.
- **No continuous status widget** — bare `/goal` is the portable observation API; no adapter-specific badges or reconnectable command output are provided.
- **Web command adapter only in the shipped apps** — headless, ACP automation, and JSON-RPC adapters do not consume `ctx.commands`. Ordinary prompts can still authorize model-facing goal tools when those are composed.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers; it is explicitly non-authoritative. Open, undecided: a continuous status widget and per-command round-cap input; both are deferred UI and configuration work.

</details>
