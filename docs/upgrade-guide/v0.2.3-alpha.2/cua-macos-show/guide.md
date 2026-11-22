---
kind: upgrade-guide
description: "macOS CUA show() reports window visibility and returns focus after restoration."
---

# Restoring minimized macOS windows

English | [中文](guide.zh.md)

## Change

`app.show()` and `window.show()` used to unhide the application even when the window was not minimized. A visible window now returns `status: "already_visible"`. A minimized window is restored in the background when possible. If it takes keyboard focus, the helper returns focus to the previous window. Switching to a third application takes precedence.

## Migration

1. Call `window.show()` when you need a specific window displayed. `status: "restored"` confirms that the same window is on screen and no longer minimized. After an error, inspect the window before sending input.
2. Call `app.activate()` when the target application should keep keyboard focus.
