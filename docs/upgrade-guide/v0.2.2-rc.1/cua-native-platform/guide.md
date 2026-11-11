---
kind: upgrade-guide
description: "Migrate CUA scripts and custom native providers to scoped window input, string element IDs, and platform capabilities."
---

# Native CUA application and window API

English | [中文](guide.zh.md)

## Change

Screenshots and pointer input require explicit windows. App (`appHandle`) and Window (`windowId`) objects share their application handle's latest accessibility snapshot. Window IDs are opaque strings. macOS retains running application PIDs and permission `helper.pid` and `parent.pid`. Windows permission metadata omits PIDs.

Providers supply startup capabilities and implement `getGuidance(kind)` instead of supplying a `guidance` string. `raw` selects instructions for the raw `cua` tool; `standalone` selects instructions for `cua_run_code`. The native helper reports runtime permissions and session lock state; the Host combines these with startup capabilities in `getCapabilities()`. Human-facing permission responses carry a `darwin` or `windows` platform tag.

## Migration

1. Pass a current `app.getWindows()` ID unchanged to `app.getWindow(windowId)`. Rediscover saved numeric IDs. Use `window.getScreenshot()`, `window.click()`, `window.scroll()`, and `window.drag()`. Replace `hover` with `window.mouseMove()`. On macOS, `window.click(id)` sends mouse events at the element center. Switch to `invoke(id)` for the default accessibility action, or `performAction(id, "AXShowMenu")` to request an advertised menu action.
2. Replace `getAXState()` with `getAccessibilityTree()`. Replace `getAXStateAndScreenshot()` with separate tree and screenshot reads. Application and window selection does not read AX. Before using element IDs, call `getAccessibilityTree()` explicitly. To display the tree in TypeScript PTC, pass its return value to `inspect`. A screenshot does not require a successful AX read. Before coordinate input, including relative coordinates, obtain a successful AX observation covering the window or a screenshot; absolute coordinates require a screenshot. See [macOS AX read limits](../cua-ax-read-limits/guide.md) for changes to traversal defaults and configuration.
3. Pass the opaque string ID from the latest tree wherever you passed a numeric element index. In raw requests use `elementId` with `snapshotId`. Replace `performSecondaryAction` with `listActions(id)` and `performAction(id, exactName, argument?)`, or use `invoke(id)` for the default action. `setValue` accepts the provider’s supported JSON values. On macOS, `performAction(id, 'AXRaise')` performs the advertised raise action. Call `app.activate()` first when the application must become active.
4. Replace a packed chord such as `pressKey('shift+Tab')` with `pressKey('Tab', ['shift'])`. Check `(await cua.getCapabilities()).methods` before using `sendKeyEvent`. On macOS, call it inside one `run_code` or `cua_run_code` to hold a key across tool calls. Repeat a held non-modifier with another down. Returning, throwing or pausing releases any remaining keys. Replace `NATIVE_ERROR` with `INVALID_ARGUMENT` for unknown macOS keys and correct the key before retrying.
5. Read `dispatched`, then observe the outcome. `invoke` returns `dispatched: false` when the element has no default action. Remove reads of the old `verified` field and of `pid` on selected objects or window records. Pass a Windows application ID unchanged. For a specific macOS instance, use `getApp(String(row.pid))`. Update permission readers that test for `win32` to use `windows`.
6. Custom providers replace `CuaBackend.description` with `capabilities` and `guidance` with `getGuidance(kind)`. Supply `permissionParameters`. Set `acceptsPidSelector: true` if `getApp` accepts process IDs. Rebuild custom `helperPath` against the [operation schema](../../../../packages/experimental/cua/src/protocol.ts) and [tagged permission response](../../../../packages/experimental/cua/src/access-types.ts). Restart. Verify both tool forms’ guidance, advertised methods, keyboard scopes and permission controls.
