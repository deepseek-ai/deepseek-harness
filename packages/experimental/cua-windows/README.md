---
description: "Discover Windows applications by AUMID and observe or operate explicitly selected windows."
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

`buildTimeoutMs` defaults to 300000, `connectTimeoutMs` to 30000, and `pollIntervalMs` to 25. Accessibility reads default to 2000 nodes and depth 25. Pass `maxElements` and `maxDepth` to override either limit for one read. The bundle loads this provider only on native Windows. When configured explicitly in WSL, `windowsPowerShellPath` defaults to `powershell.exe`. The WSL cache currently copies only the exe, so a multi-file publish cannot start from that cache.

<a id="interface-semantics"></a>
## Interface semantics

### Application discovery

Application discovery uses the AppsFolder catalog scope used by PowerShell `Get-StartApps`: the current user's discoverable Start applications, rather than every background process or executable on disk. `cua.listApps()` supplements this catalog with applications associated with accessible top-level windows. Its final results are not guaranteed to match the command's output item for item; use the IDs returned by `cua.listApps()`.

Each result contains `id`, `displayName`, and `isRunning`. The ID is an AUMID, including a full executable path used as the fallback when Windows supplies no window or process AUMID. Only identical ID strings merge. Matching is case-sensitive, with no path normalization or merging by name or executable. Pass the returned ID unchanged; a display name, PID, window ID, or arbitrary path is not an alternative selector.

`isRunning` means that this discovery found an associated window, not that a background process exists. A catalog application without a window reports `false`; minimizing a window does not by itself make the application non-running. Inaccessible windows or processes are omitted. Failure to read the application catalog fails the request instead of returning only the window-derived entries. `cua.getState()` summarizes the same application discovery; it is not an accessibility observation.

### Application and window selection

- `cua.getApp(id)` requests application consent and returns an App on success. It does not read accessibility state or activate the application. Windows does not support application launch; the windowless-selection limitation below applies.
- `app.getWindows()` reads the application's current window list. One application can have multiple windows across multiple processes, and the list can become empty as windows close.
- `app.getWindow(windowId)` returns a Window object without reading accessibility state. Pass the opaque window ID returned by the provider unchanged. Window operations check that the target still belongs to the selected application.
- `window.getAccessibilityTree()` explicitly reads accessibility state. Element IDs belong to the current observation; reading another window of the same App replaces the facade's current snapshot. Do not mix elements or snapshots across windows.
- `window.getScreenshot()` captures that explicit window and does not read or replace its accessibility tree. Screenshots can remain usable when an accessibility read fails.
- `app.activate()` explicitly requests foreground activation. `app.show()` restores a default window without requesting activation; `window.show()` restores the named window. An absent default returns `WINDOW_NOT_FOUND`; an ambiguous default returns `AMBIGUOUS_WINDOW`.

<a id="interaction-rules"></a>
## Interaction rules

1. Check `cua.getCapabilities()` before choosing an operation. Accessibility and keyboard input are window-scoped on Windows; screenshots and pointer actions also require a Window object.
2. Read an accessibility tree before using element IDs. Absolute pointer coordinates use pixels in the latest returned screenshot, relative to that window. `relative: true` uses integer thousandths from 0 to 999 after an appropriate AX observation or screenshot. Capture again after a resize.
3. `pressKey`, `click`, and `drag` accept `ctrl` (or `control`), `alt`, and `shift`. Only `click` and `drag` accept `win`. System keyboard and pointer input require the intended foreground window. Explain any necessary focus change, explicitly activate the application or ask the user to focus the target, and observe again. Do not assume that selecting an App or Window changes focus.
4. Treat `dispatched` as dispatch evidence, not confirmation of the intended effect. Observe the result before continuing. On a changed window, stale snapshot, timeout, or cancellation, do not blindly repeat input or switch to another window.
5. Consent applies to the application within the conversation. Respect denial and revocation; do not use another tool to bypass them. Reconnects invalidate retained handles, so select the application again before further operations.

<a id="model-experience"></a>
## Model Experience

### Explicit application and window operations

#### What the model sees

The program receives application and window identifiers, observations, and action results. Selection alone does not provide an accessibility tree.

#### Token effect

Process returned trees and screenshots in memory. In a CUA program, call `inspect(...values)` with the text or images to display.

#### KV Cache effect

Inspected results append to model history. Retaining an App, Window, or returned observation in the program preserves the existing prompt prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The npm package omits the Windows helper. Use the [standalone ZIP on x64 or a matching build on ARM64](#setup).
- Hover, click, scroll and drag use the system pointer. `requireSystemPointerApproval` does not prompt separately for Windows pointer operations.
- Drag checks the topmost window only at its starting point. An overlay from another application along the path or at the destination can receive the drop even while the selected window stays in the foreground.
- The helper does not check each key or button release during cleanup. If an input remains held after a failure, release it manually before continuing.
- Helper identity hashes only the exe. Different DLLs with the same apphost can reuse the old service. Stop Hosts using the same output directory before rebuilding to avoid locked files.
- The Windows handshake requires a positive `maxClickHoldMs`. With zero, it fails with `INVALID_CONFIG` before ordinary clicks or status queries can run.
- `findApps`, application launch, and app-level accessibility are unavailable. Ask the user to open the required application or window.
- Applications with `isRunning: false` can be discovered, but the current `getApp` flow attempts an unsupported launch and fails with `UNSUPPORTED`. Open a window before selecting such an application.
- Observation and input require an accessible, unlocked interactive Windows session. Screenshots require Windows Graphics Capture support; a listed window can still be unavailable for capture or input.
- Application consent does not offer an **Always allow** grant. Another conversation needs its own consent.

<a id="dev-note"></a>
### Dev Note

None.
