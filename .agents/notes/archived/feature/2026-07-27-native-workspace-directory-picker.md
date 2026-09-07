# Agent Note: Native workspace directory picker

Status: implemented
Archived: 2026-09-04

English | [中文](2026-07-27-native-workspace-directory-picker.zh.md)

## Problem

The desktop GUI asks users to type an absolute path when they add an existing workspace. This is slower and more error-prone than choosing a directory with the operating system's native picker. The GUI is delivered through the local Web carrier, so opening a native dialog also creates a privileged boundary that ordinary remote requests must not cross.

## Decision

Add a single-folder `host.pickDirectory` RPC and expose it through `WorkspaceRuntime`. The workspace menu presents the flat **Add workspace...** action (two actions when this was decided — **Open local folder...** beside a create-by-name entry the [one-route Note](../simplification/2026-07-31-one-route-to-add-a-workspace.md) later removed). Selecting a folder reuses the existing `workspace.create({ path })` flow, selects the returned workspace, and starts a blank session.

The workspace manager must upsert the returned workspace before the selection callback runs. A newly adopted directory therefore renders its basename immediately. Reopening an already registered path preserves its existing workspace title.

## Interaction contract

- The picker accepts one directory on macOS, Windows, and Linux.
- Cancelling the system dialog is silent and returns `null`.
- A duplicate path selects the existing workspace.
- A different canonical path adopts a separate Workspace even when its derived title matches another Workspace ([identity decision](../bug-fix/2026-07-31-same-basename-workspace-adoption.md)).
- Other picker failures show a compact retryable error.
- The create-by-name flow this decision left untouched is gone; picking a directory is now the whole of adding a workspace ([one-route Note](../simplification/2026-07-31-one-route-to-add-a-workspace.md)).

## Host boundary

The native dialog RPC is accepted only from a loopback socket with same-origin browser metadata. The RPC does not use the default 30-second request timeout because a system dialog may remain open indefinitely; caller and connection aborts still propagate to the platform process.

Platform adapters open the dialog without a shell — spawned native tools on POSIX, an in-process COM conversation on Windows:

- macOS: `osascript` and the system folder chooser.
- Windows: the koffi `IFileOpenDialog` child process with the best thread DPI awareness the host accepts (per-monitor-v2 when available; PMv2-less hosts cascade to per-monitor or system-aware) ([in-process dialog note](2026-08-02-win32-in-process-folder-dialog.md)); the tier has no fallback — failures surface as-is ([PowerShell chain removal](../simplification/2026-08-04-drop-windows-powershell-picker-fallback.md)).
- Linux: `zenity`, with `kdialog` as a fallback when Zenity is unavailable.

## Alternatives considered

- A custom directory browser duplicates operating-system behavior and permissions, and belongs to the Web implementation rather than this desktop-only change.
- Reusing the manual path field keeps the current error-prone interaction.
- Adding authentication infrastructure for one local native dialog would expand the change beyond its threat model; loopback and same-origin checks are sufficient for this carrier.

## Consequences

The current GUI opens one local folder through a native picker on macOS, Windows, and Linux. Cancelling changes no state, failures remain retryable, duplicate paths are idempotent, and distinct same-basename paths coexist as separate Workspaces. The selected workspace and its displayed name refresh before a new blank session starts. This picker is now the only route to a workspace ([one-route Note](../simplification/2026-07-31-one-route-to-add-a-workspace.md)): the operator picks an existing directory, or creates one inside the chooser.

The added host, runtime, component, and GUI tests cover the native boundary, request trust checks, cancellation and failure handling, existing-path reuse, same-basename adoption, and the immediate visible-name update. The privileged RPC remains specific to the local desktop carrier; a remote Web directory browser is outside this decision.

## Risks

- Linux desktop environments may provide neither supported picker. The GUI reports that limitation instead of falling back to a typed path.
- Browser metadata varies outside the supported local carrier. The endpoint intentionally rejects requests that cannot prove the required local same-origin context.
