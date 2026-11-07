---
description: "Client Session status table and useSessionStatus hook: running state, the effective pending interaction, and completion reminders by Session."
kind: "package-reference"
---
# @deepseek-ai/dsh-api-session-status

English | [中文](README.zh.md)

## Summary

Use this package to read each Session's running state, highest-precedence pending interaction, and completion reminder from one Client status table. Components read the table through the `useSessionStatus` root hook; Client plugins read it as `ctx.uiSession.sessionStatus`. The package has no configuration fields, Host behavior, or persistent storage.

## Table of Contents

- [Status table](#status-table)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="status-table"></a>
## Status table

The Web bundle loads the Client half after [`dsh-client-ui-session`](../../client/ui-session/README.md); a composition that loads ui-session without this package has no status table and no `useSessionStatus` hook. A plugin that reads `ctx.uiSession.sessionStatus` adds `'uiSession.sessionStatus'` to its `inject` list; without it, Cordis rejects the property read. The member is declared on ui-session's `UiSessionService`, the type of `ctx.uiSession`; a value annotated as the `UiSession` class does not show it.

| Member | Use |
|---|---|
| `getSnapshot()` | Status by Session identity; the snapshot keeps its reference until a status fact changes |
| `subscribe(listener)` | Observe published changes; a throwing listener is reported without stopping later listeners |

Each `SessionStatus` has three independent fields:

| Field | Source |
|---|---|
| `running` | Host Session list baselines and `api-session/status` events; absent until either establishes it. Subagent catalog rows and retained subagent fallback rows do not establish it. |
| `pendingInteraction` | The same object `ctx.uiSession.pendingInteractions` publishes for that Session. Domain plugins keep registering requests through `ctx.uiSession.registerPendingInteraction(precedence)`. |
| `completionUnread` | A stop this Client observed while the main view did not retain the Session, including an idle event that arrives before the first list baseline. The reminder clears when the main view retains the Session, the Session runs again, or a ready list no longer contains it. |

<a id="model-experience"></a>
## Model Experience

None, as the status table adds no tools, prompts, or Session events.

#### KV Cache effect

None; the status table does not assemble model requests.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Completion reminders belong to one Client** — another browser tab or a page reload starts without the reminders this Client recorded.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
