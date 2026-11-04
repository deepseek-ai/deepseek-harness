# Agent Note: Preset-scoped Schedule tools

Status: implemented

English | [中文](2026-09-24-preset-scoped-schedule-tools.zh.md)

## Problem

`@deepseek-ai/dsh-schedule` registered `schedule_create`, `schedule_list`, `schedule_update`, and `schedule_delete` itself, attaching them to every live root Agent from an `agent/created` listener whose only filter was membership in `ctx.agents.roots()`. That predicate says nothing about the Agent preset, so `minimal` — composed for a capability-poor agent — carried all four schemas and paid their fixed request-context token cost. Storage, delivery, and the preset mechanism were each correct; the availability decision sat in the package that owns the storage service.

## Decision

`@deepseek-ai/dsh-tool-schedule` (`packages/schedule/tool-schedule`) contributes `schedule_create`, `schedule_list`, `schedule_view`, and `schedule_edit` as a preset-level Consumer. It declares `inject = ['tools', 'systemPrompt']` and registers the definitions and shared authorization instruction from inside `ctx.inject(['schedule'], …)`, so the mounting scope owns them and registration waits for the Host Schedule service in that same scope. The shipped Web profile mounts the row in its `standard`, `cordis`, and `ptc` presets and omits it from `minimal`. Cordis effect ownership disposes the definitions with the mount, and a composition that never resolves `schedule` registers none of them. The [Web bundle](../../../../packages/bundle/web-app/README.md) owns the `schedule` and `ui-schedule` rows the shipped composition mounts; this record owns the reminder tools' preset placement.

`@deepseek-ai/dsh-schedule` keeps the `schedule` storage domain, now writing v2 and reading v1, the Host timer and serialized queue, Host delivery, the Automation tasks page's backing reads, and the `ctx.schedule` interface. `dsh-tool-schedule` is the model-facing consumer of that interface: it maps RRULE and target inputs to service requests, reads `exec.agent` for the actor and `this_session` destination, and maps undeclared failures to `internal_error` so storage details never reach the model. Management addresses every Host task by id; the target alone selects the receiving Session.

## Alternatives considered

**Keep registration in the Host service behind a `Config` flag.** An `exposeTools` field would move a composition choice into the storage plugin, where no preset can state it, and every preset would still need an edit to change the outcome.

**Register the tools whenever `ctx.schedule` is present.** The shipped Web composition mounts the `schedule` Host service for the whole deployment, `minimal` included, so that condition restores the coupling between storage and model surface that this decision removes.

## Consequences

- `minimal` request headers and tool lists carry no reminder tool schema.
- Each preset that mounts the row pays the four schemas' fixed token cost, and tool availability is read from the composition instead of inferred from the Host service's presence.
- A deployment can mount `dsh-schedule` for storage and delivery without granting its agents model-driven reminder management.
- `dsh-schedule` injects no `ctx.tools` and registers no model-facing tool.
- A delegated child inherits the preset's four reminder schemas. `runForCaller` in `dsh-tool-schedule` returns `{ code: 'subagent_session', message: 'A delegated subagent cannot use scheduled tasks.' }` from each tool when the caller's delegation depth is above zero. The [preset composition decision](../simplification/2026-10-09-preset-owned-subagent-composition.md) removes the redundant child filter; visibility does not authorize execution.
- A Session a delegated child owns can never receive a delivered reminder, so `ScheduleService.create` and target changes or arming through `ScheduleService.edit` refuse it with `subagent_session`. The refusal reads the delegation depth — the accounting the delegation cap itself enforces, carried by the persisted session header across a cold resume. The rule sits in the service, so other consumers reach it too — the Automation surface included.

## Testing

`packages/schedule/tool-schedule/tests/tool-schedule.spec.ts` pins the four definitions and their error mapping, including `refuses every call from a registered delegated child whose scope mounts the tools`, and `packages/subagent/subagent/tests/schedule-tools.spec.ts` runs a delegated child through the tool executor and pins that refusal without a stored task. `apps/cli/tests/web-agent-presets.e2e.ts` asserts the `minimal` preset's tool list, and `snapshots/web/minimal-preset/tool-schemas.expected.json` records its tool table without reminder schemas. `packages/schedule/schedule/tests/subagent-ownership.spec.ts` pins the delegation-depth refusal, and `scripts/optional-bundles.spec.ts` asserts that both delegation rows in the three presets omit `toolFilter`. The Web preset e2e also checks equal parent/child tool schemas and refusal from all four reminder executors for fresh and seeded children. `snapshots/web/subagent-fork-schedule` records all four refusals in a seeded fork through the shipped Web composition and shares the standard preset's prompt and schema pins.
