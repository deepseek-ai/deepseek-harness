---
description: "Preset-scoped scheduled task tools (schedule_create, schedule_list, schedule_view, schedule_edit) over the Host ctx.schedule service, for deployments choosing which agents may manage scheduled tasks."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-schedule

English | [中文](README.zh.md)

## Summary

Use `dsh-tool-schedule` to let an agent create, list, view, update, and delete Host scheduled tasks through `schedule_create`, `schedule_list`, `schedule_view`, and `schedule_edit`. A scheduled task delivers its instruction to a target Session at each occurrence of its recurrence rule. The package registers the four tools in the preset or Agent scope that mounts it; `minimal` keeps none. Tasks belong to the Host: the tools read and change any task by id, and only the delivery target names a Session. The Host `@deepseek-ai/dsh-schedule` service owns storage, scheduling, and delivery. Failures return one structured error code.

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

Add the row below to a preset's plugin list when that preset's agents should manage scheduled tasks. The shipped Web `standard`, `cordis`, and `ptc` presets mount it; `minimal` does not.

### When to choose it

Choose it for any preset whose agents need to schedule future work, and load `@deepseek-ai/dsh-schedule` in the same process: this package is only the model-facing consumer of that service. A preset that should stay capability-poor — `minimal` is the shipped example — omits the row, and its agents see no Schedule tool at all.

### User authorization

One shared `tool:schedule` system-prompt section requires explicit user authorization to create or modify tasks. Prior explicit authorization for the running scheduled task remains valid, such as pausing that task after a monitored PR merges.

### The four tools

- `schedule_create(title, prompt, rrule, target)` — Create one task; all four inputs are required. `title` has at most 120 characters and names the action and object in the user's language; keep timing, status, and ids in their fields. `prompt` is the instruction delivered at each occurrence, and `rrule` is one `DTSTART` line and one `RRULE` line in the [RFC 5545 subset of Schedule](../../../docs/subsystems/schedule.md#rrule-input). Returns the task with its generated id.
- `schedule_list(active?, limit?, offset?)` — List one page of every Host task, including tasks that other Sessions created. Active tasks come first by next occurrence, and paused and ended tasks follow, newest first. `active: true` keeps only active tasks and `active: false` only paused and ended tasks; `limit` is 1 through 500 and defaults to 100.
- `schedule_view(id)` — Read one task by id. An unknown id returns `{ id, code: 'schedule_not_found' }`.
- `schedule_edit(id, action, ...)` — An `update` changes at least one of `title`, `prompt`, `rrule`, `target`, and `active`; `active: false` pauses the task and `active: true` resumes it. Resume needs a future occurrence; supply a new `rrule` if the old rule is exhausted. With `expectedUpdatedAt`, an update or delete of a task that changed after that read returns `schedule_conflict` and changes nothing. A `delete` accepts no patch field and removes the task with its saved deliveries.

`target` selects the Session that receives each delivery: `this_session` delivers to the calling Session, `new_once` creates one Session at the first delivery and reuses it, and `new` creates a Session for every delivery. Omit it on edit to preserve the destination and settings. Supplying it replaces the destination; `new_once` reserves a different Session, and either creating target captures the editor's working directory and composed preset.

### Minimal configuration

```yaml
- name: '@deepseek-ai/dsh-tool-schedule'
```

The package declares no `Config` fields. It injects `ctx.tools` and `ctx.systemPrompt` and registers the four tools and their shared guidance once the scope resolves the Host `ctx.schedule` service, so a composition that keeps that service off mounts no Schedule tool. Each call acts for the Agent that dispatched it.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The plugin registers four `defineTool` definitions and one `tool:schedule` system-prompt section in the scope that resolves `ctx.schedule`, so a preset mount decides visibility and Cordis effect ownership disposes them with the mount. The section is empty when neither `schedule_create` nor `schedule_edit` is visible through `ctx.tools.get()` in the requesting scope, including delegated scopes whose preset filters those tools. This lookup works for both Native and PTC presentation. Execution reads `exec.agent` for the acting Session. The delegation-depth guard runs first and the argument checks of `schedule_edit` run next, both before the service call. A `ScheduleInputError` keeps its code when the output schema of the tool declares that code, and every other failure becomes `internal_error`, so storage details never reach the model. Model content is the canonical JSON of the returned value, and the Host service owns persistence, scheduling, Session restoration, and delivery.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: the four tools, their shared guidance, output schemas, target resolution, and render/present helpers |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Schedule service](../schedule/README.md) — the Host task store, runtime, and delivery behavior these tools manage.
- [Schedule group map](../README.md) — the sibling packages in this group.
- [Generated tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-tool-schedule) — the exact four schemas the model receives.
- [Schedule subsystem](../../../docs/subsystems/schedule.md) — the `ctx.schedule` Cordis surface and stored types.
- [Schedule user guide](../../../docs/user/guide/schedule.md) — the user-facing scheduled task workflow.

-----

<a id="model-experience"></a>
## Model Experience

### Shared system prompt

#### What the model sees

One `tool:schedule` section when `schedule_create` or `schedule_edit` is visible in the calling Agent's scope. Tool descriptions retain their operation-specific guidance without repeating this policy. A `complete: true` system-prompt override replaces ordinary sections, including this one.

##### Task authorization

```markdown
Only create or modify scheduled tasks at the user's explicit request; prior explicit user authorization for the running scheduled task remains valid.
```

#### Token effect

One fixed sentence per assembled prompt in Native and PTC mode. Scopes that hide both mutation tools pay no cost for this section.

#### KV Cache effect

Prefix-stable while the section text and mutation-tool visibility are unchanged. Mounting, disposal, or filtering may invalidate reuse from this section.

### Tool schemas

#### What the model sees

The generated [`schedule_create`, `schedule_list`, `schedule_view`, and `schedule_edit` schemas](../../../docs/tool-catalog.md#deepseek-aidsh-tool-schedule) whenever this package is visible in the calling Agent's scope. The catalog shows the default configuration; the `target` description of `schedule_create` adds the configured spacing of `new` deliveries when it exceeds one minute.

#### Token effect

A fixed schema cost on every request from an Agent whose preset mounts the package. Agents under a preset that omits the row pay nothing.

#### KV Cache effect

Prefix-stable while tool definitions and visibility are unchanged. Mounting, disposal, or a scope change may invalidate reuse from the first changed schema token.

### Task results

#### What the model sees

One canonical JSON text block per call. `schedule_create` returns the task; `schedule_list` returns `{ items, shown, total, limit, offset }`; `schedule_view` returns the task or `{ id, code: 'schedule_not_found' }`; and `schedule_edit` returns the updated task, `{ id, deleted: true }`, `{ id, code: 'schedule_not_found' }`, or `{ id, code: 'schedule_conflict' }`. Task results discriminate all seven timing kinds with `kind` and retain their authoritative timing fields. They include `id`, `title`, `prompt`, `scheduledAt`, `scheduledAtLocal`, `target`, `status`, optional `updatedAt` for revision comparison, and optional `lastDelivery` with `scheduledAt`, `deliveredAt`, and `targetSessionId`. The model input continues to expose RRULE; a rejected call returns `{ code, message }` with a declared output code.

#### Token effect

Results remain in the calling Session's history until compaction and repeat the task summary; a `schedule_list` page costs its full rendered length, at most `limit` tasks, on every later request.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV Cache entries.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **No tools without the Host service** — a composition that mounts this package without `ctx.schedule` leaves the plugin pending, so none of the four tools register.
- **Every call needs a calling Agent** — a call dispatched without one returns `internal_error` rather than guessing a Session.
- **Every tool reaches every Host task** — `schedule_list` returns tasks that other Sessions created, and `schedule_view` and `schedule_edit` read, change, and delete any task by id. The authorization sentence guides model behavior; the Host does not validate user intent or add ownership checks per Session. A preset whose agents must not manage Host tasks omits the row.
- **Deletion does not retract a queued message** — a message that the Host already delivered stays in the target Session inbox after a `schedule_edit` delete.
- **Task timing belongs to the Host** — the tools expose no clock source, delivery retry, or execution result; those limits are the service's.
- **Every tool refuses a delegated caller** — each of the four tools reads the calling Agent's delegation depth before it calls the service and returns `{ code: 'subagent_session', message: 'A delegated subagent cannot use scheduled tasks.' }` when that depth is above zero. The guard lives in this package and reads `delegationDepthOf` from `@deepseek-ai/dsh-subagent`, the same accounting the delegation cap enforces, so it holds under any preset that mounts the tools.
- **A delegated child still sees the four tools** — a child joins its parent's preset, so its requests carry the four schemas and their token cost; the refusal above, not schema omission, keeps the child from managing tasks.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
