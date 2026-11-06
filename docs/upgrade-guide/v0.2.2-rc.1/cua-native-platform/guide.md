---
kind: upgrade-guide
description: "Migrate CUA scripts and custom native providers to scoped window input, string element IDs, and platform capabilities."
---

# Native CUA application and window API

English | [中文](guide.zh.md)

## Change

CUA scripts use an explicit window for screenshots and pointer input. App and Window objects share the latest accessibility snapshot for their application handle. Their identifiers are `appHandle` and `windowId` respectively. Application discovery still reports the PID of a running match.

Providers supply startup capabilities alongside their platform guidance. The native helper reports runtime permissions and session lock state. The Host combines both in `getCapabilities()`. Human-facing permission responses carry a `darwin` or `win32` platform tag.

## Migration

1. After `cua.getApp(selector)`, select the target from `app.getWindows()` with `app.getWindow(windowId)`. Use `window.getScreenshot()`, `window.click()`, `window.scroll()`, and `window.drag()`. Replace `hover` with `window.mouseMove()`.
2. Replace `getAXState()` with `getAccessibilityTree()`. Replace `getAXStateAndScreenshot()` with separate tree and screenshot reads. Selection reads the initial tree silently for a window, and for an app when `appLevelAccessibility` is true. Read the tree explicitly to display it.
3. Pass the opaque string ID from the latest tree wherever you passed a numeric element index. In raw requests use `elementId` with `snapshotId`. Replace `performSecondaryAction` with `listActions(id)` and `performAction(id, exactName, argument?)`, or use `invoke(id)` for the default action. `setValue` accepts the provider’s supported JSON values. On macOS, `performAction(id, 'AXRaise')` performs the advertised raise action. Call `app.activate()` first when the application must become active.
4. Replace a packed chord such as `pressKey('shift+Tab')` with `pressKey('Tab', ['shift'])`. Check `(await cua.getCapabilities()).methods` before using `sendKeyEvent`: macOS supports complete keystrokes and rejects directional events with `NOT_IMPLEMENTED`.
5. Read `dispatched` from action results, then observe the application to verify the outcome. `invoke` returns `dispatched: false` when the element has no default action. Remove reads of the old `verified` field and of `pid` on selected objects or window records. Use `listApps()` or running `findApps()` matches when you need a PID.
6. For a custom provider, replace `CuaBackend.description` with `capabilities` and pass `guidance` and `permissionParameters` to `installCua`. Rebuild any custom `helperPath` against the [operation schema](../../../../packages/experimental/cua/src/protocol.ts) and [tagged permission response](../../../../packages/experimental/cua/src/access-types.ts). Restart the provider, inspect its advertised methods and keyboard scopes, and open the Computer Use permission page to verify its platform controls.
