# Agent Note: Schedule in the shipped Web composition

Status: implemented
Archived: 2026-09-25

English | [中文](2026-09-24-web-default-schedule-composition.zh.md)

## Problem

The Automation tasks page, the Session reminder catalog, and the `schedule_*` tools reached a Web deployment only through `--patch apps/cli/config/examples/schedule/cordis.yml`. `packages/bundle/web-app/cordis.patch.yml` carried the `ui-schedule` client row with `disabled: true`, and the Host rows `time-context` and `schedule` existed in that overlay alone. A person running the shipped `web` profile therefore saw no Automation tasks entry and no reminder tools, while every consumer that wanted them repeated the same three rows: the repository preview image kept its own overlay list, and two Web suites hard-coded the overlay path.

## Decision

`packages/bundle/web-app/cordis.patch.yml` inserts `time-context` and `schedule` in its Host row list and leaves `ui-schedule` enabled; `packages/bundle/web-app/package.json` declares both packages, which `verify-cordis-config` requires for a bare row name in a bundle patch. The `web` profile consequently ships the Automation tasks page, the Session-header reminder clock, the idle Session row's clock mark and hover list, the right-Sidebar task tab, and `schedule_create`, `schedule_list`, `schedule_update`, and `schedule_delete` on every live root Agent.

`apps/cli/config/examples/schedule/cordis.yml` is deleted. `applyEntryPatches` appends an `insert` list without de-duplicating ids, so keeping the overlay would mount `time-context` and `schedule` a second time; the two Web suites and the preview packer that named the overlay compose the shipped profile alone.

`time-context` ships with Schedule because a reminder request states a wall-clock target. The plugin appends one durable user message per eligible step carrying the sampled instant, the browser zone attached to the open request, and the elapsed time since the preceding model-visible message. The sampling instant is what lets the model turn a request such as "tomorrow at nine" into an offset-bearing `at` value; the [Schedule subsystem](../../../../docs/subsystems/schedule.md) owns that interpretation boundary and the explicit-zone requirement it feeds.

The Host service, its storage domain, and the client half are unchanged. This decision moves which composition mounts them, and the [Host-owned scheduled messages decision](2026-09-16-host-schedule-storage.md) continues to own task storage, activation, dispatch, and delivery records.

## Recorded sessions

A Web scenario that drives a live step now logs one time-context reading per step, so its committed Session fixture and header sidecars were refreshed. A reading's sampled instant, browser zone, and elapsed duration are volatile, and `normalizeWebSessionVolatiles` in `apps/web/tests/scaffold.ts` replaces them with `{{timeContextTimestamp}}`, `{{clientTimeZone}}`, and `{{elapsed}}`. The turn and step numbers and the preceding-event baseline stay readable, so a fixture still shows what the model received. Refresh writes the current writer generation (`session.v4.jsonl`) beside the retained predecessors, which remain committed replay baselines.

## Alternatives considered

**Keep the overlay and change nothing.** The shipped surface would keep contradicting the product documentation that describes the Automation tasks entry, and each consumer would keep its own copy of the three rows. The overlay also cannot satisfy the request that the default `dsh web` process exposes the page without a flag.

**Ship the Schedule rows without `time-context`.** The model would then have no sampling instant of its own, so an unqualified date or time in a reminder request would depend on a separate clock source; the overlay paired the two rows for that reason.

**Reach for a separate optional bundle.** `OPTIONAL_BUNDLES` exists for bundles a person switches on from the plugin manager, which is the same opt-in shape as the overlay; the decision here is that a default Web surface owns the page and the tools.

## Consequences

- Every Web session's request header carries four additional tool schemas, and every eligible step appends one durable user message. A conversation that never creates a reminder pays that token cost.
- The clock reading is model-visible and durable, so it replays, compacts, and appears in exported Session logs like any other user message.
- A deployment that wants the previous behavior disables the `time-context`, `schedule`, and `ui-schedule` rows in its own profile patch layer; the capability itself is untouched.
- The `cordis_inspect_query` `listTools` answer for a full preset table now passes the base composition's 12,500-token inline budget, so the spill policy retains that answer's head and tail with a spill path instead of the complete JSON.
- The repository preview image and both Web suites drop their overlay arguments, so one composition change reaches every surface at once.
