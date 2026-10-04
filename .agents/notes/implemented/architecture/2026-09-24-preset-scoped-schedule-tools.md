# Agent Note: Preset-scoped Schedule tools

Status: implemented

English | [中文](2026-09-24-preset-scoped-schedule-tools.zh.md)

## Problem

`@deepseek-ai/dsh-schedule` registered `schedule_create`, `schedule_list`, `schedule_update`, and `schedule_delete` itself, attaching them to every live root Agent from an `agent/created` listener whose only filter was membership in `ctx.agents.roots()`. That predicate says nothing about the Agent preset, so `minimal` — composed for a capability-poor agent — carried all four schemas and paid their fixed request-context token cost. Storage, delivery, and the preset mechanism were each correct; the availability decision sat in the package that owns the storage service.

## Decision

`@deepseek-ai/dsh-tool-schedule` (`packages/schedule/tool-schedule`) contributes the four tools as a preset-level Consumer. It declares `inject = ['tools']` and registers the definitions on `ctx.tools` from inside `ctx.inject(['schedule'], …)`, so the mounting scope is the one that owns them and the registration waits for the Host Schedule service in that same scope. The shipped Web profile mounts the row in its `standard`, `cordis`, and `ptc` presets and omits it from `minimal`. Cordis effect ownership disposes the definitions with the mount, and a composition that never resolves `schedule` registers none of them. The [Web bundle](../../../../packages/bundle/web-app/README.md) owns the `schedule` and `ui-schedule` rows the shipped composition mounts; this record owns the reminder tools' preset placement.

`@deepseek-ai/dsh-schedule` keeps the version-1 storage domain, the Host timer and serialized queue, Host delivery through the Session controller, the Automation page's backing reads, and the `ctx.schedule` interface. `dsh-tool-schedule` is the model-facing consumer of that interface: it checks selector and identity constraints before the service call, reads `exec.agent` for the Session binding, and maps failures that are not `ScheduleInputError` to `internal_error` so storage details never reach the model.

## Alternatives considered

**Keep registration in the Host service behind a `Config` flag.** An `exposeTools` field would move a composition choice into the storage plugin, where no preset can state it, and every preset would still need an edit to change the outcome.

**Register the tools whenever `ctx.schedule` is present.** The shipped Web composition mounts the `schedule` Host service for the whole deployment, `minimal` included, so that condition restores the coupling between storage and model surface that this decision removes.

## Consequences

- `minimal` request headers and tool lists carry no reminder tool schema.
- Each preset that mounts the row pays the four schemas' fixed token cost, and tool availability is read from the composition instead of inferred from the Host service's presence.
- A deployment can mount `dsh-schedule` for storage and delivery without granting its agents model-driven reminder management.
- `dsh-schedule` injects no `ctx.tools` and registers no model-facing tool.
- A delegated child cannot use the four tools through either layer: the `tool-subagent` and `tool-subagent-fork` rows in `standard`, `cordis`, and `ptc` deny all four names through `toolFilter`, and the provider applies that filter in the child scope through `ctx.tools.restrict()`, so the tools leave the child's prompt; `subagentCallerRefusal` in `dsh-tool-schedule` independently returns `{ code: 'subagent_session', message: 'A delegated subagent cannot use reminders.' }` from every one of the four tools when the caller's delegation depth is above zero, so a call that reaches a tool anyway is refused.
- A Session a delegated child owns can never receive a delivered reminder, so `ScheduleService.create` and `ScheduleService.update` refuse it with `subagent_session`. The refusal reads the delegation depth — the accounting the delegation cap itself enforces, carried by the persisted session header across a cold resume. The rule sits in the service, so other consumers reach it too — the Automation surface included.

## Testing

`packages/schedule/tool-schedule/tests/tool-schedule.spec.ts` pins the four definitions and their error mapping, including `refuses every tool for a delegated child caller`. `apps/cli/tests/web-agent-presets.e2e.ts` asserts the `minimal` preset's tool list, and `snapshots/web/minimal-preset/tool-schemas.expected.json` records its bash-only tool table. `packages/schedule/schedule/tests/subagent-ownership.spec.ts` pins the delegation-depth refusal, and `scripts/optional-bundles.spec.ts` asserts that both delegation rows in the three presets deny all four tool names.
