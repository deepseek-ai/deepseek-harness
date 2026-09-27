# Agent Note: Schedule as an opt-in optional bundle

Status: implemented

English | [中文](2026-09-24-schedule-opt-in-optional-bundle.zh.md)

## Problem

Schedule adds four tool schemas to every live root Agent request and one durable clock message per eligible step, so the shipped Web composition must not mount it by default. A person using the shipped Web profile still needs a product-surface switch to turn it on; a profile patch layer or a `--patch` overlay is a configuration file that person cannot reach.

## Decision

`packages/bundle/web-app/cordis.patch.yml` carries none of `time-context`, `schedule`, and `ui-schedule`, so the shipped Web composition exposes no Schedule surface: no `schedule_*` tools, no Session reminder catalog, no Automation tasks page, and no per-step clock reading.

`@deepseek-ai/dsh-experimental-schedule-bundle` (`packages/experimental/schedule-bundle/`) inserts the three rows in its `cordis.patch.yml` and depends on their packages, as every other optional bundle inserts the rows it ships. `OPTIONAL_BUNDLES` in `packages/boot/app-boot/src/profile.ts` names the package, and `apps/cli` declares it as a runtime dependency, so every installation ships it switched off. The [experimental-as-optional-bundles decision](2026-09-21-experimental-capabilities-as-optional-bundles.md) owns the `OPTIONAL_BUNDLES` conventions and the localized `icon` and `meta.title` / `meta.description` metadata the Web Plugins page renders in its Official group.

Enabling the bundle inserts `time-context` (a per-step clock reading with the sampled instant, the browser zone attached to the open request, and the elapsed time since the preceding model-visible message), `schedule` (durable reminders plus `schedule_create`, `schedule_list`, `schedule_update`, and `schedule_delete` on live root Agents), and `ui-schedule` (the Session reminder catalog and the Automation tasks page). The bundle carries `time-context` with `schedule` because a reminder request states a wall-clock target: the sampled instant is what lets the model turn a request such as "tomorrow at nine" into an offset-bearing `at` value. The [Schedule subsystem](../../../../docs/subsystems/schedule.md) owns the durable records, delivery, and management operations; the [Web bundle](../../../../packages/bundle/web-app/README.md) owns the composition the bundle adds the rows to. Disabling the bundle restores the shipped composition, and the Host stops scheduling while the `schedule` row is absent; stored task records remain in the Schedule domain.

## Alternatives considered

**Ship Schedule on by default.** Every Web session then pays four tool schemas in each request header and one durable user message per eligible step, and a conversation that never creates a reminder pays both costs. The arrangement also left the capability without an off switch on the product surface.

**Keep a `--patch` overlay file.** An overlay is a launch-time argument rather than a product-surface switch, so a person using the shipped Web profile cannot reach it. Re-declaring the rows through its `insert` list does not override them: `applyEntryPatches` appends that list without de-duplicating ids, and the Loader collapses the composed list to one entry per id with the last declaration winning, so the overlay replaces the Web bundle's rows instead of setting fields on them.

**Keep the rows in the Web composition with `disabled: true` and switch them on with id-targeted patches.** The bundle would then set fields on existing rows, but the plugin manager lists only the rows a bundle inserts, so the bundle's page reported no components and needed a second listing path for overridden rows, while every other optional bundle inserts its rows. A profile that also declares one of the ids resolves the same way as for any other bundle: the Loader keeps the last declaration.

**Lock the three rows to the bundle switch.** A bundle manifest field that makes the plugin manager refuse to switch the rows one by one adds a plugin-manager concept only this bundle would use. The bundle's page offers a switch per row, as for every other bundle, and the bundle README records that the three rows work only together.

## Consequences

- A default `dsh web` session carries no Schedule tool schemas, no Session reminder catalog, no Automation tasks page, and no per-step clock reading. An installation that wants them enables the optional bundle from the Plugins page or lists the package in a profile's `dsh.profile.bundles`.
- An enabled installation adds four tool schemas to every live root Agent and one durable clock message per eligible step; the reading is model-visible and durable, so it replays, compacts, and appears in exported Session logs like any other user message.
- The Plugins page lists the three rows under the bundle with the titles their packages' `locale/*.json` declare, their state, and, while the bundle is on, a switch per row; switching one of them off leaves Schedule without that part.
- A profile patch or `--patch` overlay that targets one of the three ids matches no row while the bundle is not selected, and the loader warns `patch: entry <id> not found` for it; selecting the bundle replaces switching the rows on by id.
- The switch is configuration-only: `src/index.ts` is an empty module, the patch carries the runtime content, and the package owns no mutable runtime state, so it publishes no invariant companion.
