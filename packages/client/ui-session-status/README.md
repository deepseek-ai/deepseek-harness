---
description: "Client Session status table and useSessionStatus hook over Host reading records: running state, the effective pending interaction, and read or unread reminders shared by clients of one running Host."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-session-status

English | [中文](README.zh.md)

## Summary

Show each Session's running state, highest-precedence pending interaction, and read or unread reminder from one Client status table. Reminders come from reading records this package keeps in Host memory: they survive a browser refresh while the Host remains running, and connected clients share manual marks and acknowledgements, including completions that occur while every client is offline. Reading marks do not change conversation history or model requests.

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

The Web bundle's single `ui-session-status` row loads both faces: the Host reading service `ctx.sessionStatus` and, after [`dsh-client-ui-session`](../ui-session/README.md), the Client plugin, which the Web client requires at startup. A composition without this package has no status table and no `useSessionStatus` hook, and profiles without the Web bundle run no reading service. The package has no configuration fields or persistent storage. Restarting the Host or reloading this plugin discards every record: history reads as read again, and no earlier turn outcome survives.

Use the Session row menu to **Mark as read** or **Mark as unread**. All clients connected to that Host share the result; a failed operation leaves the previous reminder visible and reports failure. A completed, failed, or cancelled turn creates an unread reminder. Existing history starts read when first observed. Opening a Session in a visible, focused main view acknowledges its loaded completion after a rendering frame. Switching the main view to a Session, including restoring it after a page reload, clears its existing manual reminder after the content arrives. Window focus and further activity in the open Session preserve manual unread. Unread reminders do not imply task success and remain independent of running and pending-interaction status.

Components read the status table through the `useSessionStatus` root hook. A Client plugin that reads `ctx.uiSession.sessionStatus` adds `'uiSession'` and `'uiSession.sessionStatus'` to its `inject` list; without them, Cordis rejects the property read. A plugin whose components call `useSessionStatus` injects `'uiSession.sessionStatus'` as well, so the plugin unloads and reloads with the hook. The member is declared on ui-session's `UiSessionService`, the type of `ctx.uiSession`; a value annotated as the `UiSession` class does not show it.

| Member | Use |
|---|---|
| `getSnapshot()` / `subscribe(listener)` | Status by Session identity; the snapshot keeps its reference until a status fact changes, and a throwing listener is reported without stopping later listeners |
| `mark(sessionId, unread)` | Mark a Session read or unread; rejects while reading is not synchronized or when the Host rejects the mark |
| `readingReady` | Whether the current Host reading baseline has arrived |

Each `SessionStatus` has four fields:

| Field | Source |
|---|---|
| `running` | Host Session list baselines and `api-session/status` events; absent until either establishes it. Subagent catalog rows and retained subagent fallback rows do not establish it. |
| `pendingInteraction` | The same object `ctx.uiSession.pendingInteractions` publishes for that Session. Domain plugins register requests through `ctx.uiSession.registerPendingInteraction(precedence)`. |
| `completionUnread` | The Host reading record carries a manual unread mark, or its latest completed turn is beyond the read turn; that unacknowledged turn is not shown while the visible, focused main view retains the Session and it is open |
| `completionFailed` | The Session is unread and its latest completed turn ended with an execution error this Host observed |

The Host face serves the `sessionStatus` Remote namespace with `mark` and `follow`; its failures use `session-status/not-found` and `session-status/unavailable`. The Client keeps its copy of the reading records private: no Client service other than `ctx.uiSession.sessionStatus` exposes them.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

Reading records live in the Host service's Map and change only from `turn/end` events and explicit marks. Each record holds `completedTurn`, `failed`, `readTurn`, and `manualUnread`. Marks do not change execution facts or flush the Session log.

The Client submits the completed turn it has seen. The Host advances `readTurn` monotonically up to that position, bounded by its known completion; automatic acknowledgements preserve `manualUnread`. Explicit read and unread actions clear or set that flag in Host processing order. Cold menu actions check metadata without opening history.

Only the ordered subscription updates Client records; mutation replies report success or failure. Streams send an accessible baseline followed by whole-record changes. The Client follows them through `ctx.remote.$stream` and the Gateway's `RemoteSnapshotStream` only while `ctx.remoteAccess` allows `sessionStatus/follow`, so a LiveShare viewer opens no stream and keeps `readingReady` false; a normal stream end returns an error with the Gateway's `gateway/carrier-lost` code, so the stream reconnects and the next baseline replaces the records. The existing access stream ends a reading generation when grants change, so reconnecting clients receive a fresh baseline. Disposal closes followers and discards records; pending metadata lookups cannot commit afterward.

The Client plugin combines Session list baselines, `api-session/status` events, ui-session's pending interactions, and reading records into the status table, provided as `uiSession.sessionStatus` beneath `ctx.uiSession`. It also acknowledges the Session retained by the main view. It waits for a visible, focused window, an open Session, a rendering frame, and a loaded body that reaches the completed turn. Window focus only advances the natural read position. When the main view switches to a different Session, the plugin checks that Session's manual unread mark once the reading baseline is ready and clears an existing mark with the next acknowledgement; a replaced binding for the same Session is not a switch, and later acknowledgements keep manual marks.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Session reading memory decision](../../../.agents/notes/implemented/feature/2026-10-23-session-reading-memory.md) — package structure, Host memory ownership, concurrency, and deferred persistence.
- [Session UI adapter](../ui-session/README.md) — the parent `ctx.uiSession` service and pending-interaction registration.
- [Workspace browser](../ui-workspace/README.md) — row menu and reminders.

-----

<a id="model-experience"></a>
## Model Experience

None, as reading records and the status table add no tools, prompts, or Session events.

#### KV Cache effect

None; reading marks and the status table do not assemble model requests.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

Reading state has these operational limits:

- **Concurrent explicit marks** — the last action processed by the Host wins. Delayed explicit read actions can clear a newer manual unread mark; there is no revision comparison. Automatic acknowledgements (`acknowledge`) never clear manual unread or read beyond their submitted position. The only automatic path that clears manual unread is the main-view switch rule above, including restoring the main view after a page reload; it applies only when that page is visible, focused, and showing the Session.
- **One Host process** — separate Host processes or machines do not synchronize with each other.
- **Host restart or plugin reload** — all reading state resets and history reads as read. A turn that failed before the restart keeps no outcome, so marking such a Session unread shows the ordinary unread reminder. Reloading the Host plugin ends every reading stream; if the replacement service is not yet serving when the Client reconnects, the Client receives a terminal error, disables reading commands, and recovers only after a page reload. Persistent reminders require the separately tracked follow-up; this package writes no read-state files.
- **Web profiles only** — the row lives in the Web bundle, so profiles without it run no reading service.
- **Metadata and transport failures** — a failed metadata lookup leaves reading state unchanged. A terminal stream or protocol failure disables reading commands until the page reloads; ordinary carrier loss reconnects automatically.
- **Unloaded and archived Sessions** — records for Sessions unloaded from memory remain until the service stops; reclaiming them requires a Session deletion lifecycle. Archived rows hide their unread styling and status, read as read, and offer no reading mark in the row menu or shortcut.
- **Main-view visibility** — main-view retention does not distinguish every settings or auxiliary panel, so acknowledgement can run, and the status table hides the open Session's unacknowledged completion, while such a panel covers the Conversation; that refinement belongs to the notification work.
- **No message counts or read receipts for other people** — the state belongs to the Host's owner and records Session-level reminders. LiveShare viewers cannot read or change it.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
