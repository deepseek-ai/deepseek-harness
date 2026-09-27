---
description: "Add Schedule, its reminder catalog, and the Automation tasks page from the plugin manager."
kind: "package-bundle"
---

# @deepseek-ai/dsh-experimental-schedule-bundle

English | [中文](README.zh.md)

## Summary

This optional bundle inserts the three Schedule rows the shipped Web composition leaves out: `time-context`, `schedule`, and `ui-schedule`. Shipped profiles leave it switched off.

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

Open Plugins in the Web sidebar and enable Automation tasks, marked by an alarm clock icon. A live root Agent then receives `schedule_create`, `schedule_list`, `schedule_update`, and `schedule_delete`, the Session header shows its reminder catalog, the sidebar's Automation tasks entry opens the task-management page and the right Sidebar holds the selected task's detail, and each eligible step appends one clock reading with the current time, the browser zone attached to the open request, and the elapsed time since the preceding model-visible message. The bundle's page lists Time awareness, Task scheduling, and Task interface with their state. Disabling the bundle restores the shipped composition; stored tasks remain on disk.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Maintainer details — click to expand</summary>

`cordis.patch.yml` inserts the three rows, and `package.json` depends on their packages so each row resolves from this bundle. `OPTIONAL_BUNDLES` in `packages/boot/app-boot/src/profile.ts` names this package and `apps/cli` depends on it, so every installation ships it switched off and the plugin manager offers it in the Official group. Selecting it appends the bundle to the profile's `dsh.profile.bundles` list. No runtime invariant companion is published because this configuration-only package owns no mutable runtime state.

| File | Role |
|---|---|
| [`cordis.patch.yml`](cordis.patch.yml) | Inserts the `time-context`, `schedule`, and `ui-schedule` rows |
| [`package.json`](package.json) | The row packages as dependencies |
| [`locale/en.json`](locale/en.json), [`locale/zh.json`](locale/zh.json) | Plugin-manager title and description |
| [`icon.svg`](icon.svg) | Plugin-manager icon |
| [`src/index.ts`](src/index.ts) | Empty module entry; the patch is the runtime content |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Schedule subsystem](../../../docs/subsystems/schedule.md) — durable tasks, occurrence resolution, and delivery.
- [Schedule service](../../schedule/schedule/README.md) — Host task storage, activation, and the record format.
- [Web bundle](../../bundle/web-app/README.md) — the composition this bundle adds the rows to.

-----

<a id="model-experience"></a>
## Model Experience

### Reminder tools and clock readings

#### What the model sees

A live root Agent gains `schedule_create`, `schedule_list`, `schedule_update`, and `schedule_delete`. `time-context` appends one durable user message per eligible step carrying the sampled instant, the browser zone attached to the open request, and the elapsed time since the preceding model-visible message.

#### Token effect

Selecting the bundle adds four Schedule tool schemas to every live root Agent request and one durable clock reading per eligible step; a conversation that never creates a reminder pays both.

#### KV Cache effect

The tool schemas change the request prefix once when the bundle mounts; each appended reading is new visible content after that prefix, so existing entries are not invalidated.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- While the bundle is on, its page offers a switch per row, as for every bundle. The three rows work only together: switching `schedule` off leaves the task page without its service, and switching `time-context` off leaves the model without the current time for new reminders.
- A profile patch or `--patch` overlay that targets `time-context`, `schedule`, or `ui-schedule` by id matches no row while this bundle is not selected: the loader warns `patch: entry <id> not found` for each such patch. Select this bundle instead of switching the rows on by id.

-----

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Maintainer details — click to expand</summary>

None.

</details>
