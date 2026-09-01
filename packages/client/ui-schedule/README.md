---
description: "The read-only Web catalog for active Schedule reminders, for users choosing the surface and maintainers of its projection, timing, and accessibility behavior."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-schedule

English | [中文](README.zh.md)

## Summary

This package renders a read-only catalog of the current Session's active Schedule reminders in the Web header. It reads the complete `schedule` projection and issues no RPC or mutation. The browser derives status, local time, relative time, and ordering without adding those presentation values to durable state. The shipped Web bundle keeps the plugin disabled until the explicit Schedule overlay enables both the Host Schedule services and this client row.

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

Enable the Schedule overlay before starting the Web Session that should expose reminders:

```sh
dsh web --patch apps/cli/config/examples/schedule/cordis.yml
```

The shipped Web graph already resolves `@deepseek-ai/dsh-client-ui-schedule` through a disabled `ui-schedule` row; the overlay enables that row together with `@deepseek-ai/dsh-schedule`. The trigger appears only while the Session is successfully open and the projection contains at least one active record. Opening it shows overdue rows first, then future rows by target time, with exact ties preserving the projection's creation order.

### Read and dismiss the catalog

Each row shows the complete wrapping prompt, a separate Scheduled or Overdue status, localized Once or the largest exact whole unit for a repeating interval, browser-local target time, and browser-clock-relative time. Intervals are never rounded, and the three metadata fields wrap across lines instead of clipping valid large values. The body-portaled popover targets 336px, shares the trigger's left edge when space permits, and shifts left to retain a 16px viewport margin when the trigger is near the right edge; its maximum width is the viewport width minus 32px. It scrolls vertically when needed and exposes no Schedule id, raw UTC value, details, or action controls.

Only the native trigger button enters the tab order. Enter and Space use normal button activation; while focus remains on the trigger or catalog, Escape closes the popover and restores trigger focus; an outside pointer press dismisses it. If a live update removes the final record, the component closes and unmounts without moving focus to another header action. A failed Session open hides the trigger even when a tentative cached projection exists.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The browser plugin contributes `schedule-catalog` to `conversation.session.header.actions` at order 10, after static Agent and Subagent context and before background Jobs. It reads `openState` through the standard Session hook and the complete value through `useProjection('schedule')`; popover visibility is its only local interaction state. The component portals the catalog to `document.body` and gives its trigger and panel refs to `useAnchoredPosition`, which publishes fixed coordinates after measuring the rendered panel, keeps a 5px gap below the trigger, clamps to a 16px viewport margin, and remeasures on resize, captured scroll, and panel resize. The catalog ref also makes pointer presses inside the portal part of the existing dismissal boundary. Browser formatting uses the viewing locale, time zone, and clock, while durable Schedule records remain unchanged.

### Source map

| File | Role |
|---|---|
| [`src/client/index.ts`](src/client/index.ts) | Browser entry: locale registration and Session-header slot contribution |
| [`src/client/ScheduleCatalogAction.tsx`](src/client/ScheduleCatalogAction.tsx) | Visibility, ordering, formatting, popover, and keyboard behavior |
| [`src/client/locales.ts`](src/client/locales.ts) | English and Chinese catalog copy |
| [`src/index.ts`](src/index.ts) | Empty Host apply that keeps the optional browser feature addressable by Loader |
| — | No runtime invariant companion is published because this read-only client catalog owns no mutable cross-plugin state. |

The [durable Web Schedule Agent Note](../../../.agents/notes/implemented/feature/2026-08-05-durable-web-schedule.md) owns the active projection and opt-in presentation boundary; this package owns the catalog's timing and accessibility behavior.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the catalog itself is not enough. They move from the browser presentation to the durable Schedule state and shared projection transport.

- [Schedule package](../../schedule/schedule/README.md) — creates, lists, cancels, and delivers the reminders shown here.
- [Schedule subsystem](../../../docs/subsystems/schedule.md) — durable record, transition, and delivery semantics.
- [Session projections subsystem](../../../docs/subsystems/session-projection.md) — the complete-value transport this package reads.
- [Client package map](../README.md) — adjacent browser UI packages.

-----

<a id="model-experience"></a>
## Model Experience

None, as this package renders a completed client projection for a human and never changes prompts, messages, schemas, streams, or tool results.

#### KV Cache effect

None; the package never assembles or sends provider requests.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define the current Schedule catalog. They are current package constraints, not a reminder-service comparison or a task backlog.

- **Active records only** — terminal delete and dispatch transitions remove rows; the ordinary transcript remains the only reminder-delivery history.
- **Browser-derived time** — local and relative labels use the viewing browser's current locale, time zone, and clock. They are presentation values, not durable Schedule facts.
- **Read-only surface** — creating and deleting reminders remain with the Schedule tools; the catalog has no mutation, retry, acknowledgement, toast, or delivery-receipt semantics.
- **Open Session required** — a failed open hides even a tentative cached value because strict Session replay remains authoritative.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
