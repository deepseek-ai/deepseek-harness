---
kind: upgrade-guide
description: Explicit CUA input on macOS and Windows persists across programs and turns, with system reminders after successful programs.
---
# CUA reports held input after programs

English | [中文](guide.zh.md)

## Change

On macOS and Windows, explicit `sendKeyEvent('down')` and `toggleMouse('down')` remain held across programs and turns until an explicit `up`. Normal completion does not release them. After a successful `run_code` or `cua_run_code`, a system reminder lists any remaining keys and mouse buttons, their application or window and actual input mode. Program failure, user stop, connection closure, environment reset and disposal release owned input in reverse dispatch order. Complete `pressKey`, `typeText`, `click` and `drag` actions keep their operation-local cleanup. DSH and MCP both preserve input after successful programs. A client pause between completed MCP calls is not observable by the server and can leave input held. On Windows, an up after focus changes releases desktop input without reactivating the original window.

## Migration

1. Pair explicit downs with ups when input should stop. Read the reminder before continuing; no reminder is added when no input remains held.
2. Upgrade the platform package and helper together. A custom `helperPath` must implement the task-owned `getHeldInputs` and `releaseHeldInputs` private operations.
3. Verify that one successful program can hold a key, receive its reminder, and release it in a later program. A failed or cancelled program waits for its cleanup. If the model is thinking when DSH stops or fails, the Agent can finish before native release is confirmed. Subsequent CUA calls wait for the outcome. If cleanup cannot be confirmed, CUA disables further operations for that task; inspect the desktop manually before starting another task.
