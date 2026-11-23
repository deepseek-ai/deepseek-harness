---
kind: upgrade-guide
description: "macOS CUA show() distinguishes displaying an application from restoring a specific window."
---

# Showing a macOS app or window

English | [中文](guide.zh.md)

## Change

`app.show()` makes a running application visible. If it has no visible or recoverable minimized window, it asks the app to reopen once. The app may reuse a window or create another one. `window.show()` only targets the original window ID and fails if it is no longer usable. Both return `dispatched: false` when the window is already visible. A Stage Manager thumbnail is added to the active group before the helper confirms visibility.

## Migration

1. Call `app.show()` to display the app after its last window was closed. Select the returned `windowId` with `app.getWindow(id)`.
2. Keep using `window.show()` to restore a particular window. If it is closed, use `app.show()` when any window of that app will do. Use `app.activate()` when the app should keep keyboard focus.
