---
description: "Host and Client workspace control: mutate workspace navigation and follow its complete projection."
kind: "package-reference"
---
# Workspace Controller

English | [中文](README.zh.md)

## Summary

`@deepseek-ai/dsh-api-workspace-controller` owns the Host `ctx.workspaceController` service and the generated Client `ctx.remote.workspace` namespace. Its Remote methods create, rename, remove, and reorder Workspaces, reorder Sessions within a Workspace, archive and unarchive Sessions from Workspace navigation, and follow the complete Workspace projection. Use it through API Gateway when a Client must change or follow Workspace navigation. The package also owns `ctx.directoryPickerController` and the generated `ctx.remote.directoryPicker` namespace, because the directory-picking seam it carries is abstract and never a Loader entry of its own.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

The Host controller serializes mutations whose correctness depends on current registry state and throws `RemoteError` with a stable error code for expected failures. Its `follow()` stream synchronously attaches to durable Workspace changes, emits one complete baseline first, then emits ordered `upsert`, `remove`, `order`, `archived`, and `pinned` increments. Archive and pin sets are Session id arrays, with the most recently pinned id first in the pin array. A reconnect starts another generation with a replacement baseline, so consumers do not depend on receiving every increment while disconnected. `archiveSession` without `stopActivity` refuses a Session with running work as `workspace/session-active`, whose details list that work by family (`turn`, `subagent`, `job`, `schedule`) with item ids and labels; with `stopActivity: true` the registry's providers stop the work first and the response arrives once the archive set is durable, while the stops settle in the background.

The Client entry provides `ClientWorkspaceModel` and `createWorkspaceStateStream()`. The model owns Workspace rows, registry order, archived and pinned Session identities, unary mutation echoes, and stream/unary race resolution. A newer Host row wins by `updatedAt`; a committed stream order outranks an older unary response; a removed Workspace id cannot be resurrected by delayed data. Pin snapshots change only when their identities or order change. The package exposes framework-neutral snapshots and subscriptions, leaving navigation policy and React hooks to the UI owner. `WorkspaceController.archiveSession(sessionId, { stopActivity })` throws `WorkspaceArchiveError` with the Host's `rpcError`, so a surface can tell the running-work refusal from a missing Session or a carrier fault and offer to stop the work.

<a id="first-use-workspace"></a>
### First-use Workspace

`workspace.initializeDefault()` returns the durable default Workspace; the Client service exposes it as `workspaces.initializeDefault(signal?)`. It takes no request: the Host owns the fixed `default-workspace` directory name, and the registry derives the initial title from that same segment, so one installation keeps one on-disk path and one stored title in every language. The Host places the directory under its account's `<Documents>/deepseek-harness`, including on remote Web hosts. OS filename restrictions apply. Linux system lookup requires `xdg-user-dir` with an enabled Documents directory; hosts without it must configure `documentsDirectory` or use the folder picker.

The [Workspace registry](../../workspace/workspace/README.md#first-use-workspace) owns eligibility, directory creation, and durable initialization. An existing default Workspace is returned without another Documents lookup and is never renamed or relocated. Ineligible first use returns `undefined`, so startup can leave directory selection to the user. Lookup and creation failures use standard Remote error handling. Initialization creates no Session and sends no message.

`DEFAULT_WORKSPACE_DIRECTORY` and `workspaceDisplayTitle(title, localizedDefault)` are published from `./default-workspace` for browser consumers: a Workspace still carrying the automatic title reads as the reader's localized default name, and every other title reads verbatim. A Workspace the user renamed to exactly `default-workspace` — or a folder of that name adopted from the picker — is labeled as the default; nothing else depends on the distinction.

| Configuration | Default | Purpose |
| --- | --- | --- |
| `documentsDirectory` | System Documents directory | Fully qualified Host directory override |
| `documentsLookupTimeoutMs` | `10000` | Positive maximum duration of OS directory lookup, in milliseconds |

Documents lookup holds the registry mutation queue, so other Workspace mutations, including registration of a picked directory, can wait up to `documentsLookupTimeoutMs`. Cancellation can stop the lookup; after resolution succeeds, it does not roll back creation or registration.

-----

<a id="model-experience"></a>
## Model Experience

None, as Workspace organization is browser and Host control state and registers no prompt, tool, or session event.

#### KV Cache effect

No direct effect; Workspace mutations do not alter model requests.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- `follow()` replaces the whole projection after reconnect and has no durable cursor or incremental catch-up protocol.
- Process-local deletion markers prevent delayed data from reviving a removed Workspace only for the lifetime of the Client model.


<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. Workspace Registry owns persistence; every stream generation is a full projection.
