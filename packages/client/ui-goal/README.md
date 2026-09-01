---
description: "Goal surface for the Web GUI: the composer-context strip that shows the current goal and edits, pauses, resumes, or clears it; for users and maintainers of the goal experience."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-goal

English | [中文](README.zh.md)

## Summary

This package renders the goal surface in the Web GUI: a strip in the composer-context stack that shows the current goal of the session and offers edit, pause, resume, and clear actions. It reads the live goal from the host-computed projection and routes every mutation through the goal service, surfacing rejections inline. It also projects each durable `/goal` command run as a `Command input` bubble in the chat, so a goal command entered by the user or the model appears in the transcript. Goal creation is outside this plugin. The shipped Web presets other than `minimal` mount `/goal` in their agent scope.

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

Mount this plugin alongside `ui-conversation` and the goal domain package; the strip then appears as the second card in the composer-context stack (after Todo, before Queue) whenever the session has a goal. An active goal offers pause; a paused one offers resume; edit rewrites the objective; clear removes the goal and suppresses the strip until the projection catches up.

### The command-input bubble

Each durable `/goal` run projects as a right-aligned monospace user-style bubble labeled `Command input` (or `指令输入`), rendered before the generic command result row. It carries no timestamp, copy, or branch actions, and reloading reconstructs it from the run.

### Failures

A rejected mutation surfaces the Remote error inline on the strip; loading, absent, completed, and successfully cleared goals render nothing.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The strip is projection-mode: the live goal arrives through `useProjection('goal')` (seeded by the history tail page and updated by `session/projection` frames), so the plugin owns no domain store, refresh chain, or event listener. The inject face carries only the four mutation verbs through `ctx.remote.goals`; each reads the CAS ref from the session's current projected value at call time, and the RPC's compare-and-set is the staleness guard. The strip single-flights mutations synchronously because a pending render cannot fence same-frame clicks. The command-input projection is a separate Conversation Definition that builds a `command-input` Chat Node before the generic command result Node; it never creates `user/message` or a model turn.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the goal surface is not enough. They move from the browser strip to the goal domain and the slots it fills.

- [dsh-goal](../../goal/goal/README.md) — the goal domain, projection, and `/goal` command this surface reads and mutates.
- [ui-conversation](../ui-conversation/README.md) — declares the `conversation.input.dock` slot and owns the composer.
- [Client package map](../README.md) — adjacent browser UI packages.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the `goals/edit`, `goals/pause`, `goals/resume`, and `goals/clear` mutations the strip routes; the host GoalService owns the model-visible goal context message those mutations queue.

#### KV Cache effect

None unless the queued goal context is admitted. An admitted context extends the history tail like any other message; an insertion discarded before admission does not affect the cache.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define the current goal surface. They are current package constraints, not a goal-domain comparison or a task backlog.

- **Durable phase only** — the projection omits process-local activation, so the strip cannot distinguish an active-but-disarmed goal from an armed one; resume re-arms through the RPC side. There is no host-live activation channel.
- **Preset-independent host state** — switching an active session to `minimal` leaves its host-owned goal intact. `/goal` and goal tools disappear, while this strip can still edit, pause, resume, or clear the goal.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. A single GoalBar dock registration whose disposal is proven by the HMR-safety spec — the plugin owns no store (state arrives on the goal projection), emits no cordis events, and holds no cross-plugin mutable state.
