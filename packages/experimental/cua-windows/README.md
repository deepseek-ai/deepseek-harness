---
description: "Discover Windows applications, manage application consent, and observe or operate explicitly selected windows."
kind: "package-reference"
---

# @deepseek-ai/dsh-cua-windows

English | [中文](README.zh.md)

## Summary

Discover Windows applications, obtain consent, then inspect and operate their windows through the shared [Computer Use API](../cua/README.md). Simulated keyboard and mouse input are available, including typing, pasting, key presses, individual key events, pointer movement, clicking, scrolling, and dragging. Application selection, window selection, accessibility observation, and foreground activation are separate actions. Use this page for Windows-specific semantics and safe interaction rules.

## Table of Contents

- [Setup and configuration](#setup)
- [Interface semantics](#interface-semantics)
- [Interaction rules](#interaction-rules)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

<a id="setup"></a>
## Setup and configuration

In a native Windows source checkout, activation uses the .NET 10 SDK on PATH to build the helper for the current architecture under `native/bin/win-<arch>`. Set `helperPath` to the absolute path of an existing executable to use it instead. For a manual build, run `pnpm run build:native:x64` or `pnpm run build:native:arm64` in this package. To use the standalone win-x64 ZIP, extract the entire archive and point `helperPath` at its exe. The framework-dependent `build:native` output in `native/bin/local` requires a matching Windows .NET runtime and an explicit `helperPath`.

`buildTimeoutMs` defaults to 300000, `connectTimeoutMs` to 600000, and `pollIntervalMs` to 25. Accessibility reads default to 2000 nodes and depth 25. Pass `maxElements` and `maxDepth` to override either limit for one read. The bundle loads this provider only on native Windows. When configured explicitly in WSL, `windowsPowerShellPath` defaults to `powershell.exe`. The WSL cache currently copies only the exe, so a multi-file publish cannot start from that cache.

<a id="interface-semantics"></a>
## Interface semantics

### Application discovery

`cua.listApps()` aggregates applications from eligible visible top-level windows in the current Windows session. Name searches and empty `cua.findApps` queries return installed applications from the StartApps catalog, enumerated through AppsFolder. Window observations supplement those catalog entries with running state and known executable paths. The catalog may be incomplete; if an application is missing, ask the user for its location.

Discovery results contain `id`, `identity: null`, and `isRunning`, with `name` in `listApps` and `displayName` in `findApps`. A window's ID comes from its explicit AUMID, then the package process AUMID, then the executable path. Only identical ID strings merge, using case-sensitive equality. Pass the returned ID unchanged to `cua.getApp`, or supply an existing absolute `.exe` path. Shell names, process names and executable metadata provide display labels; labels do not determine identity.

`listApps` results have `isRunning: true`. In `findApps` results, `isRunning` indicates an associated window; a catalog application without a window reports `false`. Inaccessible windows or processes are omitted. Failure to read the application catalog fails name and empty `findApps` queries. `listApps` and explicit path selection do not read the application catalog. `cua.getState().apps` comes from `listApps()`.

`cua.findApps(query)` uses case-insensitive literal substring matching on display names, IDs, and known executable paths, or checks an absolute `.exe` path directly. `""` and `null` return all catalog applications. Nonempty queries must contain a non-whitespace character and use `maxAppMatches` (default 20); excessive matches return `AMBIGUOUS_APP`. Response-size and time limits apply to all queries.

### Application and window selection

The first time a conversation selects an application without a saved grant, the approval card offers **Reject**, **Allow for this session**, and, when the profile can save grants, **Always allow**. **Always allow** is the primary button. Selecting it grants access across conversations in the same profile until revoked on the Computer Use plugin page. Pressing Enter in the approval details grants access for the current conversation.

Application consent uses the [permission attributes](#permission-attributes) observed at selection. Versions and copies sharing an attribute can share consent regardless of executable location or signing. Permission equivalence does not merge discovery IDs, change launch targets or associate additional windows. A launcher and its runtime may share consent while remaining separate native application objects.

The approval card and permission list use the shared Computer Use presentation and copy, showing the application name and icon. Reusing an application's consent within a conversation preserves its saved name and icon lookup target. Only an explicit **Always allow** choice saves a cross-conversation grant; existing session consent is not upgraded. Selecting an executable path retains that launch target even when its consent is shared with other copies.

- `cua.getApp(id)` requests application consent and returns an App on success. It does not read accessibility state or activate the application. Stopped applications are launched through Explorer after consent.
- `app.getWindows()` reads the application's current window list. One application can have multiple windows across multiple processes. Previously admitted HWNDs remain listed while valid, including hidden windows.
- `app.getWindow(windowId)` returns a Window object without reading accessibility state. Pass the opaque window ID returned by the provider unchanged. Windows checks application association on first admission, then trusts the HWND while it remains valid; later observations and input do not compare target PIDs, process start times or application identities.
- `window.getAccessibilityTree()` explicitly reads accessibility state. Element IDs belong to the current observation; reading another window of the same App replaces the facade's current snapshot. Do not mix elements or snapshots across windows.
- An element that disappears during the read, as on a web page that is still rendering, becomes an indented `[One child could not be read.]` row without an element ID; a child list that can no longer be enumerated ends with `[Child list incomplete.]`. The raw `getState` result then sets `hasUnreadableElements: true`, and the remaining rows stay usable. Use a screenshot to inspect the missing contents. Only a window root that disappears fails the read with `STALE_SNAPSHOT`.
- Pass `showDiff: true` on successive reads to receive UI Automation structure, property and text notifications for one window. The initial read and the first read after a cancellation return the observed tree. Changing the window or read options, reaching a traversal limit, or reading a tree with unreadable elements also returns the observed tree. Set `maxDiffNotifications` in the Windows provider configuration to limit distinct (event type, RuntimeId) pairs per read interval (default 50). When the count exceeds the limit or the nonempty summary reaches the current tree’s UTF-8 byte count, the first line reads `Diff too large. Showing the current tree instead.`, followed by the current tree within the requested traversal limits. A notification names the current element when available. A removal can identify a previous element. Providers can omit changes or report a whole container. Omit the option or pass `false` to read the current tree and stop listening. The helper can acknowledge connection close while unsubscription is queued on the UIA thread. It logs one diagnostic if removal fails.
- Use `getActionSchema(action)` to query an action's parameter JSON Schema.
- `window.getScreenshot()` captures that explicit window and does not read or replace its accessibility tree. Screenshots can remain usable when an accessibility read fails.
- `app.launch()` requests a new application instance and waits for the selected application's HWND set to change or the launch wait limit to expire. A single-instance program may only activate its existing instance, and a launched instance may belong to another application ID.
- `app.activate()` explicitly requests foreground activation. `app.show()` restores a default window without requesting activation; `window.show()` restores the named window. An absent default returns `WINDOW_NOT_FOUND`; an ambiguous default returns `AMBIGUOUS_WINDOW`.

<a id="permission-attributes"></a>
### Permission attributes

Selection supplies the existing authorization digest and optional AUMIDs and executable paths to the shared [consent matcher](../cua/README.md#permission-controls). Window, package and Shell-resolved AUMIDs occupy one attribute set and compare case-sensitively; executable paths occupy another and compare case-insensitively. Empty or unavailable values do not match. Names, icons, publisher signatures, installation directories and process ancestry do not contribute.

The optional [Shell resolver](native/entry/ApplicationResolver.cs) queries a selected executable path's registered shortcut and selected windows on the STA thread. Its undocumented Windows 8+ interface can be unavailable; failed queries contribute no value and leave the other attributes usable. Application enumeration and window ownership never call it. There is no product-specific list.

These attributes group permissions, not authenticated publishers. An application declaring an already authorized AUMID can share that grant. Missing shared attributes still require separate consent. See the [permission matching decision](../../../.agents/notes/implemented/architecture/2026-11-26-cua-permission-attributes.md) and [upgrade guide](../../../docs/upgrade-guide/v0.2.3-alpha.2/windows-cua-identities/guide.md).

<a id="interaction-rules"></a>
## Interaction rules

1. Check `cua.getCapabilities()` before choosing an operation. Accessibility and keyboard input are window-scoped on Windows; screenshots and pointer actions also require a Window object.
2. Read an accessibility tree before using element IDs. Absolute pointer coordinates use pixels in the latest returned screenshot, relative to that window. `relative: true` uses integer thousandths from 0 to 999 after an appropriate AX observation or screenshot. Capture again after a resize.
3. `pressKey`, `click`, and `drag` accept `ctrl` (or `control`), `alt`, and `shift`. Only `click` and `drag` accept `win`. System keyboard and pointer input require the intended foreground window. Explain any necessary focus change, explicitly activate the application or ask the user to focus the target, and observe again. Do not assume that selecting an App or Window changes focus.
4. Treat `dispatched` as dispatch evidence, not confirmation of the intended effect. Observe the result before continuing. On a changed window, stale snapshot, timeout, or cancellation, do not blindly repeat input or switch to another window.
5. Respect denial and revocation. After a reconnect, select the application again to obtain a fresh handle.

`win.toggleMouse(button, direction)` sends one system mouse button event at the current pointer. A down requires the selected window to be in the foreground and under the pointer. Release through the original Window object. An up releases the desktop button without switching focus or moving the pointer.

<a id="model-experience"></a>
## Model Experience

### Explicit application and window operations

#### What the model sees

The program receives application and window identifiers, observations, and action results. Selection alone does not provide an accessibility tree. After a successful program, a reminder lists any held keys and buttons with their window and desktop input mode. While one connection holds a key or button, another connection can use different keys or buttons. Program failure, cancellation and reset request release in reverse dispatch order. At disconnect, the helper makes a final bounded release attempt. If it fails or times out, the helper silently discards that connection’s records.

#### Token effect

Process returned trees and screenshots in memory. In a CUA program, call `inspect(...values)` with the text or images to display.

#### KV Cache effect

Inspected results append to model history. Retaining an App, Window, or returned observation in the program preserves the existing prompt prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The npm package omits the Windows helper. Use the [standalone ZIP on x64 or a matching build on ARM64](#setup).
- Hover, click, scroll and drag use the system pointer. `requireSystemInputApproval` does not prompt separately for Windows pointer operations.
- Drag checks the topmost window only at its starting point. An overlay from another application along the path or at the destination can receive the drop even while the selected window stays in the foreground.
- Held-input reminders and cleanup use the helper's own dispatches. If you press the same key or button while the helper holds it, its next up can also interrupt your press.
- Windows routes input through the desktop. After focus changes or the original window closes, a confirmed release means the desktop accepted the up. The original window may not receive the event. Releasing a held input does not check the current foreground window or lock state. The release uses the saved up event and reports `foregroundChanged: null` for an explicit up. If Windows refuses an explicit cleanup request, further CUA input for the task is blocked. Inspect the desktop before starting another task.
- Cleanup of temporary input inside complete actions does not check each key or button release. If an input remains held after a failure, release it manually before continuing.
- Helper identity hashes only the exe. Different DLLs with the same apphost can reuse the old service. Stop Hosts using the same output directory before rebuilding to avoid locked files.
- The Windows handshake requires a positive `maxClickHoldMs`. With zero, it fails with `INVALID_CONFIG` before ordinary clicks or status queries can run.
- App-level accessibility is unavailable; select an explicit window before reading its tree.
- If `getWindows()` is empty after launch, ask the user to open the required window.
- Observation and input require an accessible, unlocked interactive Windows session. Screenshots require Windows Graphics Capture support; a listed window can still be unavailable for capture or input.
- UI Automation enumerates children one sibling at a time. When an element disappears, Windows can refuse to step past it, so its later siblings are replaced by `[Child list incomplete.]` until a fresh read.

<a id="dev-note"></a>
### Dev Note

None.
