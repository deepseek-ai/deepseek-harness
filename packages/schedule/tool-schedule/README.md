---
description: "Preset-scoped reminder management tools (schedule_create, schedule_list, schedule_update, schedule_delete) over the Host ctx.schedule service, for deployments choosing which agents may keep durable reminders."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-schedule

English | [中文](README.zh.md)

## Summary

Use `dsh-tool-schedule` to let an agent create, list, edit, and delete durable Host reminders through `schedule_create`, `schedule_list`, `schedule_update`, and `schedule_delete`. The package registers the four tools in the preset or Agent scope that mounts it, so the composition decides which agents receive them; `minimal` keeps none. Each call acts on the calling Agent's Session and only manages stored reminders — the Host `@deepseek-ai/dsh-schedule` service owns storage, scheduling, and delivery. Failures return one structured error code instead of storage details.

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

Add the row below to a preset's plugin list when that preset's agents should manage durable reminders. The shipped Web `standard`, `cordis`, and `ptc` presets mount it; `minimal` does not.

### When to choose it

Choose it for any preset whose agents need to schedule future work in their own Session, and load `@deepseek-ai/dsh-schedule` in the same process: this package is only the model-facing consumer of that service. A preset that should stay capability-poor — `minimal` is the shipped example — omits the row, and its agents see no reminder tool at all.

### The four tools

- `schedule_create(prompt, title, <one selector>)` — Create one reminder. Supply a non-empty prompt, a title of at most 120 characters, and exactly one of `after_seconds`, `at`, `every_seconds`, `daily`, `weekly`, or `cron`. Returns the canonical reminder view.
- `schedule_list()` — List every active reminder of the calling Session with its id, title, UTC target, state, and delivery mode.
- `schedule_update(id, <title|prompt|one selector>)` — Replace the name, instruction, or timing in place, or a combination of them. An unknown or ended reminder returns `updated: false` with the reason code; `after_seconds` is create-only.
- `schedule_delete(id)` — Remove one retained reminder, active or ended. Unknown or already-deleted ids return `deleted: false`.

### Minimal configuration

```yaml
- name: '@deepseek-ai/dsh-tool-schedule'
```

The package declares no `Config` fields. It injects `ctx.tools` and registers the four tools once the scope resolves the Host `ctx.schedule` service, so a composition that keeps that service off mounts no reminder tool. Each call acts on the Session of the Agent that dispatched it.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The plugin registers four `defineTool` definitions through the context that loads it, so a preset mount decides visibility and Cordis effect ownership disposes them with the mount. Execution reads `exec.agent` for the Session binding and the injected `ctx.schedule` service for storage; the delegation-depth guard runs before selector and identity checks, all before the service call, and any failure the service raises that is not a `ScheduleInputError` collapses to `internal_error` so storage details never reach the model. Model content is the canonical JSON of the returned value, and the Host service owns persistence, scheduling, Session restoration, and delivery.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: the four registrations, selector validation, and the render/present helpers |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Schedule service](../schedule/README.md) — the Host task store, runtime, and delivery behavior these tools manage.
- [Schedule group map](../README.md) — the sibling packages in this group.
- [Generated tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-tool-schedule) — the exact four schemas the model receives.
- [Schedule subsystem](../../../docs/subsystems/schedule.md) — the `ctx.schedule` Cordis surface and stored types.
- [Schedule user guide](../../../docs/user/guide/schedule.md) — the user-facing reminder workflow.

-----

<a id="model-experience"></a>
## Model Experience

### Tool schemas

#### What the model sees

The generated [`schedule_create`, `schedule_list`, `schedule_update`, and `schedule_delete` schemas](../../../docs/tool-catalog.md#deepseek-aidsh-tool-schedule) whenever this package is visible in the calling Agent's scope.

#### Token effect

A fixed schema cost on every request from an Agent whose preset mounts the package. Agents under a preset that omits the row pay nothing.

#### KV Cache effect

Prefix-stable while tool definitions and visibility are unchanged. Mounting, disposal, or a scope change may invalidate reuse from the first changed schema token.

### Reminder results

#### What the model sees

One lossless JSON text block per call: a reminder view for `schedule_create`, an array of views for `schedule_list`, `{ id, deleted }` for `schedule_delete`, and a reminder view or `{ id, updated: false, code }` for `schedule_update`. A rejected call returns `{ code, message }` carrying one published error code.

#### Token effect

Results remain in the calling Session's history until compaction and repeat the stored reminder fields; a long reminder list costs its full rendered length on every later request.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV Cache entries.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **No tools without the Host service** — a composition that mounts this package without `ctx.schedule` leaves the plugin pending, so none of the four tools register.
- **Every call needs a calling Agent** — a call dispatched without one returns `internal_error` rather than guessing a Session.
- **Deletion does not retract a queued message** — a reminder the Host already delivered stays in the Session inbox after `schedule_delete`.
- **Reminder timing belongs to the Host** — the tools expose no target-time correction, clock source, or delivery retry; those limits are the service's.
- **Every tool refuses a delegated caller** — each of `schedule_create`, `schedule_list`, `schedule_update`, and `schedule_delete` reads the calling Agent's delegation depth before dispatch and returns `{ code: 'subagent_session', message: 'A delegated subagent cannot use reminders.' }` when that depth is above zero. The guard lives in this package and reads `delegationDepthOf` from `@deepseek-ai/dsh-subagent`, the same accounting the delegation cap enforces, so it holds under any preset that mounts the tools.
- **A preset's delegation rows remove the four tools from a child's prompt** — the `standard`, `cordis`, and `ptc` presets declare `toolFilter.deny` for `schedule_create`, `schedule_delete`, `schedule_list`, and `schedule_update` on both the `tool-subagent` and `tool-subagent-fork` rows. The provider applies that filter through `ctx.tools.restrict()` in the child scope, so the four tools leave a delegated child's prompt; delegating further on that chain intersects the same restriction.
- **A Session a delegated child owns cannot arm a reminder** — `ScheduleService.create` throws `ScheduleInputError` with code `subagent_session`, and `ScheduleService.update` returns the non-mutating `subagent_session` result, when the Session's Agent has a delegation depth above zero. The delegation depth is the accounting the delegation cap itself reads, and the persisted session header carries it across a cold resume. The rule sits in the service, not in these tools, so other in-process consumers reach it too: the Automation surface included. `schedule_list` and `schedule_delete` still serve that Session, so a reminder stored before this rule stays removable.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
