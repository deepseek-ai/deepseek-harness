---
description: "Enable the shipped Schedule services, reminder catalog, and Automation tasks page from the plugin manager."
kind: "package-bundle"
---

# @deepseek-ai/dsh-experimental-schedule-bundle

English | [中文](README.zh.md)

## Summary

This optional bundle switches on the three Schedule rows that `@deepseek-ai/dsh-web-app` inserts with `disabled: true`: `time-context`, `schedule`, and `ui-schedule`. Its patch appends no row and declares no plugin dependency, so enabling it cannot mount a Host service twice. Shipped profiles leave it switched off.

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

Open Plugins in the Web sidebar and enable Scheduling and time context, marked by a clock icon. A live root Agent then receives `schedule_create`, `schedule_list`, `schedule_update`, and `schedule_delete`, the Session header shows its reminder catalog, the sidebar's Automation tasks entry opens the task-management page and the right Sidebar holds the selected task's detail, and each eligible step appends one clock reading with the current time, the browser zone attached to the open request, and the elapsed time since the preceding model-visible message. Disabling the bundle restores the shipped composition; stored tasks remain on disk.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Maintainer details — click to expand</summary>

`cordis.patch.yml` carries three id-targeted patches, each setting `disabled: false` on a row the Web bundle already inserts. `OPTIONAL_BUNDLES` in `packages/boot/app-boot/src/profile.ts` names this package and `apps/cli` depends on it, so every installation ships it switched off and the plugin manager offers it in the Official group. Selecting it appends the bundle to the tail of the profile's `dsh.profile.bundles` list; bundle layers apply in list order, so the patches reach the rows only because that list places `@deepseek-ai/dsh-web-app` before this package. A hand-ordered list with this package first leaves the rows disabled while the Plugins page still shows the switch as on. No runtime invariant companion is published because this configuration-only package owns no mutable runtime state.

| File | Role |
|---|---|
| [`cordis.patch.yml`](cordis.patch.yml) | Three `disabled: false` patches over the shipped Web rows |
| [`locale/en.json`](locale/en.json), [`locale/zh.json`](locale/zh.json) | Plugin-manager title and description |
| [`icon.svg`](icon.svg) | Plugin-manager icon |
| [`src/index.ts`](src/index.ts) | Empty module entry; the patch is the runtime content |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Schedule subsystem](../../../docs/subsystems/schedule.md) — durable tasks, occurrence resolution, and delivery.
- [Schedule service](../../schedule/schedule/README.md) — Host task storage, activation, and the record format.
- [Web bundle](../../bundle/web-app/README.md) — the composition that carries these rows.

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

- The switch targets rows `@deepseek-ai/dsh-web-app` inserts. In a profile without that bundle the three patches match no row: the loader reports one `patch: entry <id> not found` warning per row and mounts nothing from this bundle; such a profile mounts no Plugins page either.
- The bundle's detail page has no per-row switches. The Host reports the three overridden ids under `overrides`, and the Web client renders only the rows a bundle inserts, so opening this card shows "This plugin pack contains no components." The switch for the three rows is on the Official-group list row.

-----

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Maintainer details — click to expand</summary>

None.

</details>
