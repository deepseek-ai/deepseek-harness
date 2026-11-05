---
kind: upgrade-guide
description: "CUA window discovery omits offscreen and zero-size windows by default."
---

# Finding hidden CUA windows

English | [中文](guide.zh.md)

## Change

`listWindows`, `app.getWindows()` and the window list in `getState` now show positive-size, onscreen windows on the current desktop. A scoped observation also retains its explicitly selected window. Scripts that find minimized, hidden or other-Space windows through default discovery can miss their target.

## Migration

1. Call `app.getWindows({ includeHidden: true })`, or pass `includeHidden: true` with the app handle to the raw `listWindows` operation.
2. Find the target by its window ID in the full result. Use `app.getWindow(windowId)` to select it and `show()` if restoration is required.
