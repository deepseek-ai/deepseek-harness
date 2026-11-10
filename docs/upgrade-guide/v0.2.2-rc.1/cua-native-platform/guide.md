---
kind: upgrade-guide
description: "Migrate CUA scripts and custom native providers to scoped window input, string element IDs, and platform capabilities."
---

# Native CUA application and window API

English | [中文](guide.zh.md)

## Change

Screenshots and pointer input require explicit windows. App (`appHandle`) and Window (`windowId`) objects share their application handle's latest accessibility snapshot. Discovery reports running matches' PIDs.

Providers supply startup capabilities and implement `getGuidance(kind)` instead of supplying a `guidance` string. `raw` selects instructions for the raw `cua` tool; `standalone` selects instructions for `cua_run_code`. The native helper reports runtime permissions and session lock state; the Host combines these with startup capabilities in `getCapabilities()`. Human-facing permission responses carry a `darwin` or `win32` platform tag.

## Migration

1. After `cua.getApp(selector)`, select the target from `app.getWindows()` with `app.getWindow(windowId)`. Use `window.getScreenshot()`, `window.click()`, `window.scroll()`, and `window.drag()`. Replace `hover` with `window.mouseMove()`. On macOS, `window.click(id)` sends mouse events at the element center. Switch to `invoke(id)` for the default accessibility action, or `performAction(id, "AXShowMenu")` to request an advertised menu action.
2. Replace `getAXState()` with `getAccessibilityTree()`. Replace `getAXStateAndScreenshot()` with separate tree and screenshot reads. Application and window selection does not read AX. Before using element IDs, call `getAccessibilityTree()` explicitly. To display the tree in TypeScript PTC, pass its return value to `inspect`. A screenshot does not require a successful AX read. Before coordinate input, including relative coordinates, obtain a successful AX observation covering the window or a screenshot; absolute coordinates require a screenshot. See [macOS AX read limits](../cua-ax-read-limits/guide.md) for changes to traversal defaults and configuration.
3. Pass the opaque string ID from the latest tree wherever you passed a numeric element index. In raw requests use `elementId` with `snapshotId`. Replace `performSecondaryAction` with `listActions(id)` and `performAction(id, exactName, argument?)`, or use `invoke(id)` for the default action. `setValue` accepts the provider’s supported JSON values. On macOS, `performAction(id, 'AXRaise')` performs the advertised raise action. Call `app.activate()` first when the application must become active.
4. Replace a packed chord such as `pressKey('shift+Tab')` with `pressKey('Tab', ['shift'])`. Check `(await cua.getCapabilities()).methods` before using `sendKeyEvent`. On macOS, call it inside one `run_code` or `cua_run_code` to hold a key across tool calls. To request one repeat, send another down for a non-modifier key held by that execution. Returning, throwing or pausing releases any remaining keys. If your script handles unknown macOS key names as `NATIVE_ERROR`, handle `INVALID_ARGUMENT` instead. Correct the key name before retrying.
5. Read `dispatched` from action results, then observe the application to verify the outcome. `invoke` returns `dispatched: false` when the element has no default action. Remove reads of the old `verified` field and of `pid` on selected objects or window records. Use `listApps()` or running `findApps()` matches when you need a PID.
6. Custom providers replace `CuaBackend.description` with `capabilities` and `guidance` with `getGuidance(kind)`, and supply `permissionParameters` to `installCua`. Both kinds may return identical text. Rebuild custom `helperPath` against the [operation schema](../../../../packages/experimental/cua/src/protocol.ts) and [tagged permission response](../../../../packages/experimental/cua/src/access-types.ts). Restart and verify both tool forms' guidance, advertised methods, keyboard scopes, and platform controls on the Computer Use permission page.
