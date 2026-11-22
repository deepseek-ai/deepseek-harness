---
kind: upgrade-guide
description: "macOS CUA show() reports when restoring a window requires foreground access."
---

# Foreground access for minimized macOS windows

English | [中文](guide.zh.md)

## Change

On macOS, `app.show()` and `window.show()` previously unhid the application even when the selected window was not minimized. They now leave such windows untouched and return `dispatched: false`. A minimized window returns `FOREGROUND_REQUIRED` because clearing its minimized state can take keyboard focus.

## Migration

1. Use `app.activate()` when the task requires bringing a hidden application to the foreground.
2. For background restoration, call `window.show()` on the selected window. If it returns `FOREGROUND_REQUIRED`, call `app.activate()` when foreground access is appropriate, then inspect the selected window.
