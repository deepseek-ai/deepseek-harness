---
description: "Native-OS-chooser backend of the directory-picker seam: opens one platform chooser per pick for operators sitting at the web GUI host's display."
kind: "package-reference"
---

# @deepseek-ai/dsh-host-directory-picker-native

English | [中文](README.zh.md)

## Summary

An operator at the host's display picks a workspace directory through a native OS chooser: `dsh-host-directory-picker-native` opens one platform directory chooser per pick and resolves the chosen absolute path (`null` on cancel). macOS drives `osascript`, Linux uses Zenity with a KDialog fallback, and Windows opens the modern `IFileOpenDialog` in a spawned child process. Only viable when the operator sits at the host's display — remote deployments compose the [browse backend](../directory-picker-browse/README.md) instead. One composition row also registers the matching browser-side interaction in the workspace flow, so it selects both sides.

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

Compose this backend when the operator works at the host's display and a native chooser is the right interaction. A workspace flow that opens a directory picker calls `pick(signal)` once per open request; the returned promise resolves with the chosen absolute path, or `null` when the operator cancels.

### When to choose it

Choose this backend for a workstation-local operator on macOS, Windows, or desktop Linux. Choose the [browse backend](../directory-picker-browse/README.md) when clients cannot reach an OS chooser — remote browsers, SSH-forwarded sessions, or unattended hosts. When the situation varies, the [adaptive chooser](../directory-picker-auto/README.md) resolves it at boot.

### What an operator experiences

Each call opens one native chooser on the host display and waits for the operator; aborting the caller's signal terminates the chooser process instead of leaving it open. On Linux the chooser needs either Zenity or KDialog installed; with neither present, `pick` rejects with an actionable error instead of falling back to a typed-path prompt. The browser half of this package registers a renderless flow occupant into the workspace flow — every `open` request drives `directoryPicker/pick` and reports the one outcome (picked path, cancel, or failure).

### Observable failures

A cancel returns `null`, not an error. Missing platform tooling, a failed chooser launch, or an aborted pick surfaces as a rejection the UI can present; the [browse backend](../directory-picker-browse/README.md) remains the composition-level fallback for deployments where native picking is unreliable.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design concept

The backend is a thin service over a platform chooser: `NativeDirectoryPicker` registers the `native` capability whose `pick` forwards to `pickNativeDirectory`, and the chooser runs as a subprocess so the host process never blocks on the dialog. The command boundary (`DirectoryPickerRunner`) and platform facts are injectable, and the shared no-shell subprocess runner lives in [`dsh-native-command`](../../util/native-command/README.md).

### Platform mechanics

Platform tools run without a shell: `osascript` on macOS, and Zenity with a KDialog fallback on Linux; the caller's abort terminates the native process. Windows opens the modern `IFileOpenDialog` in a spawned child process — a koffi-driven COM conversation on the child's main thread with the best thread DPI awareness the host accepts (per-monitor-v2 first), aborted by posting `WM_CLOSE` to the dialog thread.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `NativeDirectoryPicker` service with the stable `native` capability |
| [`src/native-picker.ts`](src/native-picker.ts) | Chooser dispatch: platform selection, subprocess running, abort wiring |
| [`src/win32-dialog.ts`](src/win32-dialog.ts) + siblings | Windows child-process `IFileOpenDialog` via koffi, DPI handling, `WM_CLOSE` abort |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these when the backend contract is not enough: the seam definition first, then the alternative backend and the chooser that selects between them.

- [Directory-picker seam](../directory-picker/README.md) — the `native` capability contract and the typed error vocabulary.
- [Directory-picker capability seam decision](../../../.agents/notes/implemented/architecture/2026-07-28-directory-picker-capability-seam.md) — why backends differ in interaction shape.
- [Browse backend](../directory-picker-browse/README.md) — the in-app alternative for remote clients.
- [Adaptive chooser](../directory-picker-auto/README.md) — boot-time resolution between native and browse.
- [No-shell subprocess runner](../../util/native-command/README.md) — the shared subprocess primitive the chooser runs on.

-----

<a id="model-experience"></a>
## Model Experience

None, as the GUI-host picking backend registers nothing model-facing.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when the native interaction is unavailable or fragile. They are current package constraints, not a task backlog.

- **Linux requires desktop tooling** — with neither Zenity nor KDialog installed, `pick` rejects with an actionable error; it does not fall back to a typed-path prompt (the browse backend is that fallback at the composition level).
- **Windows has no mechanism fallback** — the child-process picker through packaged koffi is the only native tier, so a COM refusal or dialog crash surfaces the failure; the browse backend remains the fallback at the composition level.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. Each pick is one stateless subprocess round trip; the chooser outcome is only the returned path.
